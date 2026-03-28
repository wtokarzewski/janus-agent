import { randomUUID } from 'node:crypto';
import { Bot, InputFile } from 'grammy';
import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage } from '../bus/types.js';
import type { JanusConfig } from '../config/schema.js';
import type { AgentLoop } from '../agent/agent-loop.js';
import type { SubagentRegistry } from '../agent/subagent-registry.js';
import { resolveUser, autoIdentifyUser, deriveChannelAllowlist } from '../users/user-resolver.js';
import type { InviteStore } from '../invites/invite-store.js';
import { saveConfig } from '../config/config.js';
import { ensureUserDir, ensureChatDir } from '../users/user-resolver.js';
import { transcribeVoice } from './voice-transcribe.js';
import { synthesizeVoice } from './voice-synthesize.js';
import * as log from '../utils/logger.js';

const MAX_TELEGRAM_MSG = 4096;
/** Max inbound message size (100 KB). Prevents token waste from oversized pastes. */
const MAX_INBOUND_CHARS = 100_000;
const START_MAX_RETRIES = 3;
const START_RETRY_DELAY_MS = 5000;

/**
 * Telegram Channel — receives and sends messages via Telegram Bot API.
 * Uses grammy (official-ish, TypeScript-native, long polling).
 */
interface StreamState {
  messageId: number; // 0 = pending (initial send failed, chunks buffered)
  text: string;
  dirty: boolean;
  flushing: boolean;
  flushTimer?: ReturnType<typeof setInterval>;
  topicOpts?: { message_thread_id?: number };
}

/** Interval for refreshing Telegram "typing..." action (expires after ~5s). */
const TYPING_REFRESH_MS = 4500;

export class TelegramChannel {
  name = 'telegram';
  private bot: Bot | undefined;
  private streamStates = new Map<string, StreamState>();
  private chunkQueues = new Map<string, Promise<void>>();
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  private typingStartedAt = new Map<string, number>();
  private throttleMs = 500;
  /** Per-chat rate-limit tracking: chatId → timestamp when cooldown expires. */
  private rateLimitUntil = new Map<string, number>();
  /** Dedup: track recently sent message hashes to prevent duplicates (S6). */
  private sentHashes = new Map<string, number>();

  /** Get the bot instance (available after start). */
  getBot(): Bot | undefined {
    return this.bot;
  }

  async start(bus: MessageBus, config: JanusConfig, signal: AbortSignal, externalBot?: Bot, opts?: { agent?: AgentLoop; subagentRegistry?: SubagentRegistry; inviteStore?: InviteStore }): Promise<void> {
    const tg = config.telegram;

    if (!externalBot && !tg.token) {
      throw new Error('Telegram: token is required. Set TELEGRAM_BOT_TOKEN or telegram.token in janus.json');
    }

    const bot = externalBot ?? new Bot(tg.token!);
    this.bot = bot;

    // Global error handler — prevents unhandled rejections from crashing the process
    bot.catch((err) => {
      log.error(`Telegram bot error: ${err.message ?? err}`);
    });

    this.throttleMs = config.streaming?.telegramThrottleMs ?? 500;

    // Runtime allowlist — users added via invite links (survives until restart, also saved to config)
    const runtimeAllowlist = new Set<string>();

    // Register outbound handler — sends responses back to Telegram
    bus.registerHandler('telegram', async (msg: OutboundMessage) => {
      const { chatId: tgChatId, topicId: tgTopicId } = parseTelegramChatId(msg.chatId);
      const topicOpts = tgTopicId
        ? { message_thread_id: tgTopicId, allow_sending_without_reply: true as const }
        : { allow_sending_without_reply: true as const };

      if (msg.type === 'typing') {
        await this.startTyping(bot, msg.chatId);
        return;
      }

      if (msg.type === 'typing_stop') {
        this.stopTyping(msg.chatId);
        return;
      }

      if (msg.type === 'chunk') {
        // Serialize via promise chain — prevents race condition where
        // concurrent fire-and-forget calls from streamTo() each trigger
        // sendMessage before the first one sets up stream state.
        // Only the initial sendMessage blocks the chain; subsequent chunks
        // are instant (just buffer text). Edits are timer-driven.
        const prev = this.chunkQueues.get(msg.chatId) ?? Promise.resolve();
        const next = prev.then(() => this.handleChunk(bot, msg.chatId, msg.content, topicOpts));
        this.chunkQueues.set(msg.chatId, next.catch(() => {}));
        return;
      }

      if (msg.type === 'stream_end') {
        const pending = this.chunkQueues.get(msg.chatId);
        if (pending) await pending.catch(() => {});
        await this.handleStreamEnd(bot, msg.chatId);
        this.chunkQueues.delete(msg.chatId);
        return;
      }

      // File attachment — send via appropriate Telegram API method
      if (msg.filePath) {
        this.stopTyping(msg.chatId);
        try {
          const file = new InputFile(msg.filePath);
          const captionOpts = msg.content ? { caption: msg.content, ...topicOpts } : topicOpts;
          switch (msg.fileType ?? 'document') {
            case 'photo': await bot.api.sendPhoto(tgChatId, file, captionOpts); break;
            case 'audio': await bot.api.sendAudio(tgChatId, file, captionOpts); break;
            case 'video': await bot.api.sendVideo(tgChatId, file, captionOpts); break;
            case 'voice': await bot.api.sendVoice(tgChatId, file, captionOpts); break;
            default: await bot.api.sendDocument(tgChatId, file, captionOpts); break;
          }
        } catch (err) {
          log.error(`Telegram: failed to send file to ${msg.chatId}: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }

      // 'message' or undefined — backward compatible
      this.stopTyping(msg.chatId);

      // Dedup: skip if same content was sent to same chat recently (S6)
      const dedupKey = `${msg.chatId}:${simpleHash(msg.content)}`;
      const now = Date.now();
      if (this.sentHashes.has(dedupKey) && now - this.sentHashes.get(dedupKey)! < 30_000) {
        log.debug(`Telegram: dedup — skipping duplicate message to ${msg.chatId}`);
        return;
      }
      this.sentHashes.set(dedupKey, now);
      // Evict old entries every 100 messages
      if (this.sentHashes.size > 100) {
        for (const [k, t] of this.sentHashes) {
          if (now - t > 60_000) this.sentHashes.delete(k);
        }
      }

      const cleaned = cleanMarkdownUrls(msg.content).trim();
      if (!cleaned) {
        log.warn(`Telegram: skipping empty message for ${msg.chatId}`);
        return;
      }
      const chunks = chunkMessage(cleaned, MAX_TELEGRAM_MSG);
      for (const chunk of chunks) {
        try {
          await bot.api.sendMessage(tgChatId, chunk, topicOpts);
        } catch (err) {
          log.error(`Telegram: failed to send message to ${msg.chatId}: ${err instanceof Error ? err.message : err}`);
          // Retry once after 429 cooldown
          const retryAfter = parseRetryAfter(err);
          if (retryAfter) {
            await delay(retryAfter * 1000);
            try {
              await bot.api.sendMessage(tgChatId, chunk, topicOpts);
            } catch (retryErr) {
              log.error(`Telegram: retry also failed for ${msg.chatId}: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
            }
          }
        }
      }

      // Auto-TTS: send voice reply when responding to a voice message
      if (msg.voiceReply && config.tts?.enabled && config.tts.apiKey && cleaned.length <= 4096) {
        try {
          log.info(`Telegram: synthesizing TTS for ${msg.chatId} (${cleaned.length} chars)`);
          const audio = await synthesizeVoice(cleaned, config.tts.apiKey, config.tts.model, config.tts.voice);
          await bot.api.sendVoice(tgChatId, new InputFile(Buffer.from(audio), 'reply.ogg'), topicOpts);
          log.info(`Telegram: TTS voice sent to ${msg.chatId}`);
        } catch (err) {
          log.warn(`Telegram: TTS failed for ${msg.chatId}: ${err instanceof Error ? err.message : err}`);
        }
      }
    });

    // Inbound messages
    bot.on('message:text', async (ctx) => {
      const baseChatId = String(ctx.chat.id);
      // Forum topics: only isolate sessions for forum-enabled supergroups (not regular reply threads)
      const isForum = ctx.chat.type === 'supergroup' && (ctx.chat as unknown as { is_forum?: boolean }).is_forum === true;
      const topicId = isForum && ctx.message.message_thread_id ? ctx.message.message_thread_id : undefined;
      const chatId = topicId ? `${baseChatId}/${topicId}` : baseChatId;
      const author = ctx.from?.username || String(ctx.from?.id || 'unknown');
      log.info(`Telegram: incoming from ${author} (chat ${chatId}${topicId ? `, topic ${topicId}` : ''}): ${ctx.message.text?.substring(0, 80)}`);

      // /whoami — simple diagnostic command (no agent loop)
      if (ctx.message?.text?.trim() === '/whoami') {
        const userId = String(ctx.from.id);
        const username = ctx.from.username ? String(ctx.from.username) : '(none)';
        const type = String(ctx.chat.type);
        await ctx.reply(`chatId: ${chatId}\nuserId: ${userId}\nusername: ${username}\ntype: ${type}`);
        return;
      }

      // /model [name] — show or change current LLM model (I3)
      const modelMatch = ctx.message?.text?.trim().match(/^\/model(?:\s+(.+))?$/);
      if (modelMatch) {
        const newModel = modelMatch[1]?.trim();
        if (newModel) {
          const primary = config.resolved.providers[0];
          if (primary) {
            await saveConfig({ llm: { slots: { default: { [primary.name]: newModel } } } });
          } else {
            await saveConfig({ llm: { model: newModel } });
          }
          await ctx.reply(`Model changed to: ${newModel}\nRestart to apply.`);
        } else {
          const { getSlotModel } = await import('../config/config.js');
          const slot = getSlotModel(config.resolved, 'default');
          const display = slot ? `${slot.model} (${slot.provider})` : 'not configured';
          await ctx.reply(`Current model: ${display}`);
        }
        return;
      }

      // /stop — cancel running agent + subagents
      if (ctx.message?.text?.trim() === '/stop') {
        const result = opts?.agent?.stop();
        const subsCancelled = opts?.subagentRegistry?.cancelAll() ?? 0;
        if (result?.cancelled || subsCancelled > 0) {
          await ctx.reply(`Stopped.${subsCancelled > 0 ? ` Cancelled ${subsCancelled} subagent(s).` : ''}`);
        } else {
          await ctx.reply('Nothing running.');
        }
        return;
      }

      // Invite redemption — handle /start invite_TOKEN before allowlist check
      const inviteMatch = ctx.message?.text?.match(/^\/start\s+invite_(.+)$/);
      if (inviteMatch && opts?.inviteStore) {
        try {
          const invitedBy = opts.inviteStore.redeem(inviteMatch[1]);
          if (invitedBy) {
            const userId = String(ctx.from.id);
            const username = ctx.from.username ?? undefined;
            const firstName = ctx.from.first_name ?? 'User';
            runtimeAllowlist.add(chatId);

            // Persist to config — channel-agnostic short UUID
            const newUser = {
              id: randomUUID().slice(0, 8),
              name: firstName,
              identities: [{ channel: 'telegram', channelUserId: userId, ...(username ? { channelUsername: username } : {}) }],
            };
            const existingUsers = config.users ?? [];
            const alreadyExists = existingUsers.some(u =>
              u.identities.some(i => i.channel === 'telegram' && i.channelUserId === userId),
            );
            if (!alreadyExists) {
              existingUsers.push(newUser as typeof existingUsers[0]);

              // Also add to explicit telegram allowlist so it survives restart
              const allowlist = tg.allowlist.length > 0 ? [...tg.allowlist] : [];
              if (allowlist.length > 0 && !allowlist.includes(userId)) {
                allowlist.push(userId);
              }

              saveConfig({
                users: existingUsers,
                ...(allowlist.length > 0 ? { telegram: { ...tg, allowlist } } : {}),
              }).catch(err => {
                log.warn(`Failed to save invited user to config: ${err instanceof Error ? err.message : String(err)}`);
              });

              // Create per-user directory + default PROFILE.md (non-destructive)
              ensureUserDir(newUser.id, firstName, config.workspace.dir);
            }

            log.info(`Telegram: user ${firstName} (${userId}) joined via invite from ${invitedBy}`);
            ctx.reply(`Welcome, ${firstName}! You were invited by ${invitedBy}. You can now chat with me.`).catch(() => {});
          } else {
            log.info(`Telegram: expired/invalid invite from ${author} (chat ${chatId})`);
            ctx.reply('This invite link is invalid or has expired.').catch(() => {});
          }
        } catch (err) {
          log.error(`Telegram: invite handling failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }

      // Allowlist check — explicit allowlist, users-derived, or runtime (invite)
      // Use baseChatId for allowlist check (topic variant shouldn't bypass allowlist)
      const effectiveAllowlist = tg.allowlist.length > 0 ? tg.allowlist : deriveChannelAllowlist('telegram', config);
      const isAllowed = effectiveAllowlist.includes(baseChatId) || effectiveAllowlist.includes(author) || runtimeAllowlist.has(baseChatId);
      if (effectiveAllowlist.length > 0 && !isAllowed) {
        log.debug(`Telegram: ignoring message from ${author} (chat ${baseChatId}, not in allowlist)`);
        return;
      }
      if (effectiveAllowlist.length === 0 && tg.denyByDefault) {
        log.debug(`Telegram: denying message from ${author} (chat ${baseChatId}, deny-by-default, no allowlist configured)`);
        return;
      }

      // Group mention policy — in 'mention' mode, only respond when bot is @mentioned
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (isGroup) ensureChatDir(chatId, config.workspace.dir);
      if (isGroup && tg.groupPolicy === 'mention') {
        const botUsername = ctx.me.username;
        if (botUsername && !ctx.message.text.includes(`@${botUsername}`)) {
          log.debug(`Telegram: ignoring group message (mention policy, no @${botUsername})`);
          return;
        }
      }

      // Reject oversized messages (prevents token waste)
      if (ctx.message.text.length > MAX_INBOUND_CHARS) {
        log.warn(`Telegram: rejecting oversized message from ${author} (${ctx.message.text.length} chars)`);
        ctx.reply('Message too long. Please send shorter messages.').catch(() => {});
        return;
      }

      // Resolve user identity (explicit config first, then auto-identify from channel metadata)
      const channelUserId = ctx.from ? String(ctx.from.id) : undefined;
      const channelUsername = ctx.from?.username ?? undefined;
      const resolved = resolveUser('telegram', channelUserId, channelUsername, config)
        ?? autoIdentifyUser('telegram', channelUserId, channelUsername, ctx.from?.first_name, config.workspace.dir);

      // Determine scope
      let scope: InboundMessage['scope'];
      if (ctx.chat.type === 'private' && resolved) {
        scope = { kind: 'user', id: resolved.userId };
      } else if (config.family && config.family.groupChatIds.includes(baseChatId)) {
        scope = { kind: 'family', id: config.family.id };
      }
      // else: undefined (global/backward-compat)

      const replyContext = extractReplyContext(ctx.message.reply_to_message);
      const inbound: InboundMessage = {
        id: randomUUID(),
        channel: 'telegram',
        chatId,
        content: ctx.message.text,
        author,
        timestamp: new Date(),
        user: resolved ? {
          userId: resolved.userId,
          name: resolved.name,
          channelUserId: resolved.identity.channelUserId,
          channelUsername: resolved.identity.channelUsername,
        } : undefined,
        scope,
        topicId,
        replyContext,
        routingMeta: topicId ? { topicId } : undefined,
      };

      // If the agent is already processing this chat, buffer as steering message
      if (bus.isProcessing(chatId)) {
        bus.pushSteering(inbound);
        log.info(`Telegram: steering message buffered for ${chatId}`);
        return;
      }

      // Show "typing..." indicator while agent processes the message
      log.info(`Telegram: incoming from ${author} (chat=${chatId}, processing=${bus.isProcessing(chatId)})`);
      await this.startTyping(bot, chatId);

      try {
        await bus.publishInbound(inbound, signal);
        log.info(`Telegram: published to inbound queue (chat=${chatId})`);
      } catch {
        this.stopTyping(chatId);
      }
    });

    // Emoji reactions — convert to inbound message so agent can respond
    bot.on('message_reaction', async (ctx) => {
      const reaction = ctx.messageReaction;
      if (!reaction) return;

      // Only handle newly added emoji reactions (not custom emoji or removals)
      const added = reaction.new_reaction?.filter(r => r.type === 'emoji');
      if (!added || added.length === 0) return;

      const emoji = added.map(r => 'emoji' in r ? r.emoji : '').filter(Boolean).join('');
      if (!emoji) return;
      const baseChatId = String(reaction.chat.id);
      const chatId = baseChatId;
      const author = reaction.user?.username || String(reaction.user?.id || 'unknown');

      log.info(`Telegram: reaction ${emoji} from ${author} (chat ${chatId})`);

      // Allowlist check
      const effectiveAllowlist = tg.allowlist.length > 0 ? tg.allowlist : deriveChannelAllowlist('telegram', config);
      const isAllowed = effectiveAllowlist.includes(baseChatId) || effectiveAllowlist.includes(author) || runtimeAllowlist.has(baseChatId);
      if (effectiveAllowlist.length > 0 && !isAllowed) return;
      if (effectiveAllowlist.length === 0 && tg.denyByDefault) return;

      // Resolve user
      const channelUserId = reaction.user ? String(reaction.user.id) : undefined;
      const channelUsername = reaction.user?.username ?? undefined;
      const resolved = resolveUser('telegram', channelUserId, channelUsername, config)
        ?? autoIdentifyUser('telegram', channelUserId, channelUsername, reaction.user?.first_name, config.workspace.dir);

      let scope: InboundMessage['scope'];
      if (reaction.chat.type === 'private' && resolved) {
        scope = { kind: 'user', id: resolved.userId };
      } else if (config.family && config.family.groupChatIds.includes(baseChatId)) {
        scope = { kind: 'family', id: config.family.id };
      }

      const inbound: InboundMessage = {
        id: randomUUID(),
        channel: 'telegram',
        chatId,
        content: `[Reaction: ${emoji}]`,
        author,
        timestamp: new Date(),
        user: resolved ? {
          userId: resolved.userId,
          name: resolved.name,
          channelUserId: resolved.identity.channelUserId,
          channelUsername: resolved.identity.channelUsername,
        } : undefined,
        scope,
      };

      // If agent is already processing, buffer as steering message
      if (bus.isProcessing(chatId)) {
        bus.pushSteering(inbound);
        log.info(`Telegram: reaction steering message buffered for ${chatId}`);
        return;
      }

      try {
        await bus.publishInbound(inbound, signal);
        log.info(`Telegram: reaction published to inbound queue (chat=${chatId})`);
      } catch {
        // Reaction-triggered processing failed silently — not critical
      }
    });

    // Voice messages — auto-transcribe via Groq Whisper and process as text
    bot.on(['message:voice', 'message:audio'], async (ctx) => {
      if (!config.voice.enabled || !config.voice.apiKey) {
        log.debug('Telegram: voice message received but voice transcription not configured');
        return;
      }

      const voice = ctx.message.voice ?? ctx.message.audio;
      if (!voice) return;

      if (config.voice.maxDurationSec && voice.duration > config.voice.maxDurationSec) {
        log.warn(`Telegram: voice message too long (${voice.duration}s > ${config.voice.maxDurationSec}s limit)`);
        return;
      }

      const baseChatId = String(ctx.chat.id);
      const isForum = ctx.chat.type === 'supergroup' && (ctx.chat as unknown as { is_forum?: boolean }).is_forum === true;
      const topicId = isForum && ctx.message.message_thread_id ? ctx.message.message_thread_id : undefined;
      const chatId = topicId ? `${baseChatId}/${topicId}` : baseChatId;
      const author = ctx.from?.username || String(ctx.from?.id || 'unknown');

      // Allowlist check
      const effectiveAllowlist = tg.allowlist.length > 0 ? tg.allowlist : deriveChannelAllowlist('telegram', config);
      const isAllowed = effectiveAllowlist.includes(baseChatId) || effectiveAllowlist.includes(author) || runtimeAllowlist.has(baseChatId);
      if (effectiveAllowlist.length > 0 && !isAllowed) {
        log.debug(`Telegram: ignoring voice from ${author} (chat ${baseChatId}, not in allowlist)`);
        return;
      }
      if (effectiveAllowlist.length === 0 && tg.denyByDefault) {
        log.debug(`Telegram: denying voice from ${author} (chat ${baseChatId}, deny-by-default, no allowlist configured)`);
        return;
      }

      // Group mention policy — voice messages can't @mention, so skip in mention-only groups
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (isGroup && tg.groupPolicy === 'mention') {
        log.debug('Telegram: ignoring voice in group (mention policy)');
        return;
      }

      log.info(`Telegram: voice message from ${author} (chat ${chatId}, ${voice.duration}s)`);

      // Download file from Telegram
      let fileBuffer: Uint8Array;
      try {
        const file = await bot.api.getFile(voice.file_id);
        fileBuffer = await downloadTelegramFile(bot, file);
      } catch (err) {
        log.error(`Telegram: failed to download voice file: ${err instanceof Error ? err.message : err}`);
        return;
      }

      // Transcribe via Groq Whisper
      await this.startTyping(bot, chatId);
      let transcript: string;
      try {
        transcript = await transcribeVoice(fileBuffer, config.voice.apiKey, config.voice.language);
      } catch (err) {
        this.stopTyping(chatId);
        log.error(`Telegram: voice transcription failed: ${err instanceof Error ? err.message : err}`);
        return;
      }

      if (!transcript.trim()) {
        this.stopTyping(chatId);
        log.info('Telegram: voice transcription returned empty result');
        return;
      }

      log.info(`Telegram: transcribed voice (${voice.duration}s → ${transcript.length} chars): ${transcript.substring(0, 80)}`);

      // Resolve user (same logic as text messages)
      const channelUserId = ctx.from ? String(ctx.from.id) : undefined;
      const channelUsername = ctx.from?.username ?? undefined;
      const resolved = resolveUser('telegram', channelUserId, channelUsername, config)
        ?? autoIdentifyUser('telegram', channelUserId, channelUsername, ctx.from?.first_name, config.workspace.dir);

      let scope: InboundMessage['scope'];
      if (ctx.chat.type === 'private' && resolved) {
        scope = { kind: 'user', id: resolved.userId };
      } else if (config.family && config.family.groupChatIds.includes(baseChatId)) {
        scope = { kind: 'family', id: config.family.id };
      }

      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const replyContext = extractReplyContext(ctx.message.reply_to_message);
      const inbound: InboundMessage = {
        id: randomUUID(),
        channel: 'telegram',
        chatId,
        content: `[Voice message transcription]: ${transcript}${caption}`,
        author,
        timestamp: new Date(),
        isVoice: true,
        user: resolved ? {
          userId: resolved.userId,
          name: resolved.name,
          channelUserId: resolved.identity.channelUserId,
          channelUsername: resolved.identity.channelUsername,
        } : undefined,
        scope,
        topicId,
        replyContext,
        routingMeta: topicId ? { topicId } : undefined,
      };

      if (bus.isProcessing(chatId)) {
        bus.pushSteering(inbound);
        log.info(`Telegram: voice steering message buffered for ${chatId}`);
        return;
      }

      try {
        await bus.publishInbound(inbound, signal);
        log.info(`Telegram: voice published to inbound queue (chat=${chatId})`);
      } catch {
        this.stopTyping(chatId);
      }
    });

    // Start long polling with retry
    await this.startWithRetry(bot, signal);

    // Wait for abort signal
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

    try {
      await bot.stop();
    } catch (err) {
      log.warn(`Telegram: error during bot.stop(): ${err instanceof Error ? err.message : err}`);
    }
    this.clearAllTyping();
    this.bot = undefined;
  }

  stop(): void {
    try {
      this.bot?.stop();
    } catch (err) {
      log.warn(`Telegram: error during stop(): ${err instanceof Error ? err.message : err}`);
    }
    this.clearAllTyping();
    this.bot = undefined;
  }

  /** Send "typing..." chat action and keep refreshing it until stopped. */
  private async startTyping(bot: Bot, chatId: string): Promise<void> {
    this.stopTyping(chatId);
    log.info(`Telegram: startTyping for ${chatId}`);
    this.typingStartedAt.set(chatId, Date.now());
    const { chatId: tgChatId, topicId: tgTopicId } = parseTelegramChatId(chatId);
    const topicOpts = tgTopicId ? { message_thread_id: tgTopicId } : {};
    try {
      await bot.api.sendChatAction(tgChatId, 'typing', topicOpts);
    } catch (err) {
      log.warn(`Telegram: sendChatAction failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
    }
    const timer = setInterval(() => {
      // Skip typing refresh if rate-limited for this chat
      const limitUntil = this.rateLimitUntil.get(chatId);
      if (limitUntil && Date.now() < limitUntil) return;
      bot.api.sendChatAction(tgChatId, 'typing', topicOpts).catch(() => {});
    }, TYPING_REFRESH_MS);
    this.typingTimers.set(chatId, timer);
  }

  /** Stop the typing indicator for a chat. */
  private stopTyping(chatId: string): void {
    const timer = this.typingTimers.get(chatId);
    if (timer) {
      const started = this.typingStartedAt.get(chatId);
      const elapsed = started ? Date.now() - started : 0;
      log.info(`Telegram: stopTyping for ${chatId} (after ${elapsed}ms)`);
      clearInterval(timer);
      this.typingTimers.delete(chatId);
      this.typingStartedAt.delete(chatId);
    }
  }

  /** Clear all typing indicators (used during shutdown). */
  private clearAllTyping(): void {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
  }

  /**
   * Handle a streaming chunk (called within serialized promise chain).
   *
   * First chunk: await sendMessage (only blocking call in the chain).
   * Subsequent chunks: instant text buffer — no API call, chain unblocked.
   * Edits are driven by a periodic flush timer, not by individual chunks.
   */
  private async handleChunk(bot: Bot, chatId: string, content: string, topicOpts: { message_thread_id?: number } = {}): Promise<void> {
    const state = this.streamStates.get(chatId);

    if (state) {
      // Fast path — just buffer, no API call
      state.text += content;
      state.dirty = true;
      return;
    }

    // First chunk — stop typing indicator and send initial message
    this.stopTyping(chatId);
    const { chatId: tgChatId } = parseTelegramChatId(chatId);
    try {
      const sent = await bot.api.sendMessage(tgChatId, content, topicOpts);
      this.streamStates.set(chatId, {
        messageId: sent.message_id,
        text: content,
        dirty: false,
        flushing: false,
        flushTimer: setInterval(() => this.flushStream(bot, chatId), this.throttleMs),
        topicOpts,
      });
    } catch (err) {
      log.error(`Telegram: stream send failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
      // Set pending state (messageId=0) so subsequent chunks buffer instead of
      // retrying sendMessage on every chunk (prevents 429 cascade).
      const retryAfter = parseRetryAfter(err);
      if (retryAfter) {
        this.rateLimitUntil.set(chatId, Date.now() + retryAfter * 1000);
      }
      this.streamStates.set(chatId, {
        messageId: 0,
        text: content,
        dirty: true,
        flushing: false,
        flushTimer: setInterval(() => this.flushStream(bot, chatId), this.throttleMs),
        topicOpts,
      });
    }
  }

  /**
   * Periodic flush — edits message with accumulated text.
   * Skips if nothing changed or another edit is in flight.
   */
  private async flushStream(bot: Bot, chatId: string): Promise<void> {
    const state = this.streamStates.get(chatId);
    if (!state || !state.dirty || state.flushing) return;

    // Skip if rate-limited — chunks keep buffering, flush retries next tick
    const limitUntil = this.rateLimitUntil.get(chatId);
    if (limitUntil && Date.now() < limitUntil) return;

    state.flushing = true;
    state.dirty = false;

    const { chatId: tgChatId } = parseTelegramChatId(chatId);
    try {
      if (state.messageId === 0) {
        // Initial send failed — try sending now with buffered text
        const sent = await bot.api.sendMessage(tgChatId, state.text, state.topicOpts ?? {});
        state.messageId = sent.message_id;
      } else {
        await bot.api.editMessageText(tgChatId, state.messageId, state.text);
      }
      this.rateLimitUntil.delete(chatId);
    } catch (err) {
      log.debug(`Telegram: stream flush failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
      const retryAfter = parseRetryAfter(err);
      if (retryAfter) {
        this.rateLimitUntil.set(chatId, Date.now() + retryAfter * 1000);
      }
      state.dirty = true; // re-mark so next flush retries
    }

    state.flushing = false;
  }

  private async handleStreamEnd(bot: Bot, chatId: string): Promise<void> {
    const state = this.streamStates.get(chatId);
    if (!state) return;

    if (state.flushTimer) clearInterval(state.flushTimer);

    // Wait out rate limit before final send (message must be delivered)
    const limitUntil = this.rateLimitUntil.get(chatId);
    if (limitUntil && Date.now() < limitUntil) {
      await delay(limitUntil - Date.now());
    }

    // Final edit with complete text (clean markdown from URLs)
    const { chatId: tgChatId } = parseTelegramChatId(chatId);
    const finalText = cleanMarkdownUrls(state.text);
    try {
      if (state.messageId === 0) {
        await bot.api.sendMessage(tgChatId, finalText, state.topicOpts ?? {});
      } else {
        await bot.api.editMessageText(tgChatId, state.messageId, finalText);
      }
    } catch (err) {
      log.debug(`Telegram: stream final edit failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
      // One retry after rate-limit cooldown
      const retryAfter = parseRetryAfter(err);
      if (retryAfter) {
        await delay(retryAfter * 1000);
        try {
          if (state.messageId === 0) {
            await bot.api.sendMessage(tgChatId, finalText, state.topicOpts ?? {});
          } else {
            await bot.api.editMessageText(tgChatId, state.messageId, finalText);
          }
        } catch {
          log.error(`Telegram: stream final send failed after retry for ${chatId}`);
        }
      }
    }

    this.streamStates.delete(chatId);
    this.rateLimitUntil.delete(chatId);
  }

  private async startWithRetry(bot: Bot, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= START_MAX_RETRIES; attempt++) {
      if (signal.aborted) return;

      try {
        log.info(`Telegram: starting bot (attempt ${attempt}/${START_MAX_RETRIES})...`);
        // bot.start() returns a promise that resolves when the bot stops.
        // We run it in background but catch errors so they're not silently lost.
        const startPromise = bot.start({
          drop_pending_updates: true,
          allowed_updates: [
            'message', 'edited_message', 'callback_query',
            'message_reaction',
          ],
          onStart: (info) => {
            log.info(`Telegram: connected as @${info.username} — polling active`);
          },
        });
        // Handle background errors (e.g., deleteWebhook failure, getUpdates 409 conflict)
        startPromise?.catch((err: unknown) => {
          log.error(`Telegram: bot.start() background error: ${err instanceof Error ? err.message : err}`);
        });
        return;
      } catch (err) {
        log.error(`Telegram: start failed (attempt ${attempt}/${START_MAX_RETRIES}): ${err instanceof Error ? err.message : err}`);

        if (attempt < START_MAX_RETRIES) {
          log.info(`Telegram: retrying in ${START_RETRY_DELAY_MS / 1000}s...`);
          await delay(START_RETRY_DELAY_MS);
        } else {
          throw new Error(`Telegram: failed to start after ${START_MAX_RETRIES} attempts`);
        }
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strip markdown formatting (bold/italic) that wraps or touches URLs. */
export function cleanMarkdownUrls(text: string): string {
  // Remove **, *, __, _ wrapping URLs: **https://...** → https://...
  return text.replace(/(\*{1,2}|_{1,2})(https?:\/\/\S+?)\1/g, '$2')
    // Also handle trailing-only ** or * stuck to URLs (LLM sometimes only closes)
    .replace(/(https?:\/\/\S+?)(\*{1,2}|_{1,2})(?=\s|$)/g, '$1');
}

/** Parse composite chatId "12345/67" into baseChatId and optional topicId. */
export function parseTelegramChatId(chatId: string): { chatId: string; topicId?: number } {
  const idx = chatId.indexOf('/');
  if (idx === -1) return { chatId };
  const topicId = parseInt(chatId.slice(idx + 1), 10);
  return { chatId: chatId.slice(0, idx), topicId: isNaN(topicId) ? undefined : topicId };
}

/** Download a file from Telegram Bot API. Timeout + retry on failure (U4). */
async function downloadTelegramFile(bot: Bot, file: { file_path?: string }): Promise<Uint8Array> {
  if (!file.file_path) throw new Error('Telegram file has no file_path');
  const token = bot.token;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      if (attempt === 2) throw new Error(`Telegram file download failed after retry: ${err instanceof Error ? err.message : err}`);
      log.debug(`Telegram file download attempt ${attempt} failed, retrying: ${err instanceof Error ? err.message : err}`);
    }
  }
  throw new Error('Telegram file download failed');
}

/** Extract reply context from a Telegram reply_to_message. */
function extractReplyContext(replyMsg: { text?: string; caption?: string; from?: { username?: string; first_name?: string } } | undefined): string | undefined {
  if (!replyMsg) return undefined;
  const text = replyMsg.text ?? replyMsg.caption;
  if (!text) return undefined;
  const author = replyMsg.from?.username ?? replyMsg.from?.first_name ?? 'unknown';
  const truncated = text.length > 500 ? text.slice(0, 497) + '...' : text;
  return `${author}: ${truncated}`;
}

/** Extract retry_after seconds from a Telegram 429 error message. */
function parseRetryAfter(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = err.message.match(/retry after (\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

/** Simple string hash for dedup keys. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** Split long messages into chunks at newline or space boundaries. */
function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
