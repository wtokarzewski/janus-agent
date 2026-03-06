import { randomUUID } from 'node:crypto';
import { Bot } from 'grammy';
import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage } from '../bus/types.js';
import type { JanusConfig } from '../config/schema.js';
import type { AgentLoop } from '../agent/agent-loop.js';
import type { SubagentRegistry } from '../agent/subagent-registry.js';
import { resolveUser } from '../users/user-resolver.js';
import * as log from '../utils/logger.js';

const MAX_TELEGRAM_MSG = 4096;
const START_MAX_RETRIES = 3;
const START_RETRY_DELAY_MS = 5000;

/**
 * Telegram Channel — receives and sends messages via Telegram Bot API.
 * Uses grammy (official-ish, TypeScript-native, long polling).
 */
interface StreamState {
  messageId: number;
  text: string;
  dirty: boolean;
  flushing: boolean;
  flushTimer?: ReturnType<typeof setInterval>;
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

  /** Get the bot instance (available after start). */
  getBot(): Bot | undefined {
    return this.bot;
  }

  async start(bus: MessageBus, config: JanusConfig, signal: AbortSignal, externalBot?: Bot, opts?: { agent?: AgentLoop; subagentRegistry?: SubagentRegistry }): Promise<void> {
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

    // Register outbound handler — sends responses back to Telegram
    bus.registerHandler('telegram', async (msg: OutboundMessage) => {
      if (msg.type === 'chunk') {
        // Serialize via promise chain — prevents race condition where
        // concurrent fire-and-forget calls from streamTo() each trigger
        // sendMessage before the first one sets up stream state.
        // Only the initial sendMessage blocks the chain; subsequent chunks
        // are instant (just buffer text). Edits are timer-driven.
        const prev = this.chunkQueues.get(msg.chatId) ?? Promise.resolve();
        const next = prev.then(() => this.handleChunk(bot, msg.chatId, msg.content));
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

      // 'message' or undefined — backward compatible
      this.stopTyping(msg.chatId);
      const chunks = chunkMessage(msg.content, MAX_TELEGRAM_MSG);
      for (const chunk of chunks) {
        try {
          await bot.api.sendMessage(msg.chatId, chunk);
        } catch (err) {
          log.error(`Telegram: failed to send message to ${msg.chatId}: ${err instanceof Error ? err.message : err}`);
        }
      }
    });

    // Inbound messages
    bot.on('message:text', async (ctx) => {
      const chatId = String(ctx.chat.id);
      const author = ctx.from?.username || String(ctx.from?.id || 'unknown');

      // /whoami — simple diagnostic command (no agent loop)
      if (ctx.message?.text?.trim() === '/whoami') {
        const userId = String(ctx.from.id);
        const username = ctx.from.username ? String(ctx.from.username) : '(none)';
        const type = String(ctx.chat.type);
        await ctx.reply(`chatId: ${chatId}\nuserId: ${userId}\nusername: ${username}\ntype: ${type}`);
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

      // Allowlist check — always first
      if (tg.allowlist.length > 0 && !tg.allowlist.includes(chatId) && !tg.allowlist.includes(author)) {
        log.debug(`Telegram: ignoring message from ${author} (chat ${chatId}, not in allowlist)`);
        return;
      }

      // Resolve user identity
      const resolved = resolveUser(
        'telegram',
        ctx.from ? String(ctx.from.id) : undefined,
        ctx.from?.username ?? undefined,
        config,
      );

      // Determine scope
      let scope: InboundMessage['scope'];
      if (ctx.chat.type === 'private' && resolved) {
        scope = { kind: 'user', id: resolved.userId };
      } else if (config.family && config.family.groupChatIds.includes(chatId)) {
        scope = { kind: 'family', id: config.family.id };
      }
      // else: undefined (global/backward-compat)

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
      };

      // If the agent is already processing this chat, buffer as steering message
      if (bus.isProcessing(chatId)) {
        bus.pushSteering(inbound);
        log.info(`Telegram: steering message buffered for ${chatId}`);
        return;
      }

      // Show "typing..." indicator while agent processes the message
      await this.startTyping(bot, chatId);

      try {
        await bus.publishInbound(inbound, signal);
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
    try {
      await bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      log.warn(`Telegram: sendChatAction failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
    }
    const timer = setInterval(() => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {});
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
  private async handleChunk(bot: Bot, chatId: string, content: string): Promise<void> {
    const state = this.streamStates.get(chatId);

    if (state) {
      // Fast path — just buffer, no API call
      state.text += content;
      state.dirty = true;
      return;
    }

    // First chunk — stop typing indicator and send initial message
    this.stopTyping(chatId);
    try {
      const sent = await bot.api.sendMessage(chatId, content);
      this.streamStates.set(chatId, {
        messageId: sent.message_id,
        text: content,
        dirty: false,
        flushing: false,
        flushTimer: setInterval(() => this.flushStream(bot, chatId), this.throttleMs),
      });
    } catch (err) {
      log.error(`Telegram: stream send failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Periodic flush — edits message with accumulated text.
   * Skips if nothing changed or another edit is in flight.
   */
  private async flushStream(bot: Bot, chatId: string): Promise<void> {
    const state = this.streamStates.get(chatId);
    if (!state || !state.dirty || state.flushing) return;

    state.flushing = true;
    state.dirty = false;

    try {
      await bot.api.editMessageText(chatId, state.messageId, state.text);
    } catch (err) {
      log.debug(`Telegram: stream flush failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
    }

    state.flushing = false;
  }

  private async handleStreamEnd(bot: Bot, chatId: string): Promise<void> {
    const state = this.streamStates.get(chatId);
    if (!state) return;

    if (state.flushTimer) clearInterval(state.flushTimer);

    // Final edit with complete text
    try {
      await bot.api.editMessageText(chatId, state.messageId, state.text);
    } catch (err) {
      log.debug(`Telegram: stream final edit failed for ${chatId}: ${err instanceof Error ? err.message : err}`);
    }

    this.streamStates.delete(chatId);
  }

  private async startWithRetry(bot: Bot, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= START_MAX_RETRIES; attempt++) {
      if (signal.aborted) return;

      try {
        log.info(`Telegram: starting bot (attempt ${attempt}/${START_MAX_RETRIES})...`);
        bot.start({
          onStart: (info) => {
            log.info(`Telegram: connected as @${info.username}`);
          },
        });
        return; // bot.start() doesn't await — it starts polling in background
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
