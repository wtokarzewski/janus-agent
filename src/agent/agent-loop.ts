import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage, Lane } from '../bus/types.js';
import type { LLMMessage, ToolCall, ToolContentBlock, UserContentBlock } from '../llm/types.js';
import { userContentText } from '../llm/types.js';
import type { ProviderRegistry } from '../llm/provider-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { RequestContext } from '../tools/types.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import type { JanusConfig } from '../config/schema.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { GateService } from '../gates/types.js';
import { findUserProfile } from '../users/user-resolver.js';
import { loadPrompt } from '../prompts/loader.js';
import * as log from '../utils/logger.js';
import { logTokenUsage } from '../utils/logger.js';
import { stripControlTokens, redactSecrets, stripOrphanSurrogates, safeSlice } from '../utils/sanitize.js';
import { localDateWithDay, localTimestamp } from '../utils/date.js';
import type { AgentResolver, AgentContext } from './agent-resolver.js';
import type { CronService } from '../services/cron-service.js';
import { ensureAgentDir } from '../users/user-resolver.js';
import { enforceContextBudget } from './context-budget.js';

const THINKING_LEVEL_BUDGETS: Record<string, number> = {
  off: 0, minimal: 2000, low: 5000, medium: 10000, high: 20000,
};

export interface AgentDeps {
  bus: MessageBus;
  llm: ProviderRegistry;
  tools: ToolRegistry;
  sessions: SessionManager;
  context: ContextBuilder;
  skills: SkillLoader;
  config: JanusConfig;
  learner?: { recordExecution(record: ExecutionRecord): Promise<void> };
  memory?: MemoryStore;
  gateService?: GateService;
  agentResolver?: AgentResolver;
  cronService?: CronService;
}

export interface ExecutionRecord {
  task: string;
  duration: number;
  iterations: number;
  toolCalls: number;
  tokenUsage: number;
  outcome: 'success' | 'error' | 'max_iterations';
  timestamp: string;
}

interface IterateResult {
  content: string;
  iterations: number;
  toolCalls: number;
  totalTokens: number;
  outcome: 'success' | 'error' | 'max_iterations';
}

/**
 * Core agent loop — consumes messages from bus, processes with LLM + tools, publishes responses.
 *
 * Flow:
 * 1. consume inbound → update tool contexts → get session
 * 2. build messages [system, ...history, user]
 * 3. save user message to session BEFORE iteration
 * 4. LLM iteration loop (save each tool call + result to session)
 * 5. save final assistant message to session
 * 6. maybe summarize (async, non-blocking)
 * 7. publish outbound
 */
export class AgentLoop {
  private deps: AgentDeps;
  private flushState = new Map<string, { lastFlushed: number; userId?: string; userName?: string; scope?: InboundMessage['scope']; flushing?: boolean }>();
  private _iterationControllers = new Map<string, AbortController>();
  /** Guard against concurrent summarization (C2) */
  private summarizing = new Set<string>();

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  /** Set gate service for error recovery prompts (onToolError: 'ask'). */
  setGateService(service: GateService): void {
    this.deps.gateService = service;
  }

  /**
   * Stop running iterations. If chatId provided, stops only that chat.
   * Otherwise stops all active iterations.
   */
  stop(chatId?: string): { cancelled: boolean } {
    if (chatId) {
      const ctrl = this._iterationControllers.get(chatId);
      if (!ctrl) return { cancelled: false };
      ctrl.abort();
      this._iterationControllers.delete(chatId);
      return { cancelled: true };
    }
    if (this._iterationControllers.size === 0) return { cancelled: false };
    for (const [, ctrl] of this._iterationControllers) {
      ctrl.abort();
    }
    this._iterationControllers.clear();
    return { cancelled: true };
  }

  /**
   * Process a single message directly — no bus round-trip.
   * Used for: single-message CLI mode, heartbeat, subagents.
   */
  async processDirect(content: string, opts?: {
    channel?: string;
    chatId?: string;
    contextMode?: 'full' | 'minimal' | 'background';
    user?: InboundMessage['user'];
    scope?: InboundMessage['scope'];
    signal?: AbortSignal;
  }): Promise<string> {
    const msg = {
      id: `direct-${Date.now()}`,
      channel: opts?.channel ?? 'cli',
      chatId: opts?.chatId ?? 'direct',
      content,
      author: 'user',
      timestamp: new Date(),
      contextMode: opts?.contextMode,
      user: opts?.user,
      scope: opts?.scope,
      signal: opts?.signal,
    } as InboundMessage & { signal?: AbortSignal };

    try {
      const response = await this.processMessage(msg);
      return response.content;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      log.error(`processDirect error: ${errorText}`);
      return `Error: ${errorText}`;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    log.info('Agent loop started');

    const lanes = this.deps.config.agent.lanes;
    const promises: Promise<void>[] = [];

    for (const [lane, concurrency] of Object.entries(lanes)) {
      promises.push(this.runLane(lane as Lane, concurrency, signal));
    }

    await Promise.all(promises);
    log.info('Agent loop stopped');
  }

  private async runLane(lane: Lane, concurrency: number, signal: AbortSignal): Promise<void> {
    let active = 0;
    const waiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

    const acquire = (signal: AbortSignal): Promise<void> => {
      if (active < concurrency) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject };
        waiters.push(entry);
        // If abort fires while waiting for a slot, reject so the loop can break
        signal.addEventListener('abort', () => {
          const idx = waiters.indexOf(entry);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(new Error('Aborted'));
          }
        }, { once: true });
      });
    };

    const release = () => {
      active--;
      const next = waiters.shift();
      if (next) {
        active++;
        next.resolve();
      }
    };

    while (!signal.aborted) {
      try {
        log.debug(`Lane "${lane}": waiting for message (active=${active}/${concurrency})`);
        const msg = await this.deps.bus.consumeInbound(signal, lane);
        log.info(`Lane "${lane}": received ${msg.channel}:${msg.chatId} (active=${active}/${concurrency})`);
        await acquire(signal);
        log.info(`Lane "${lane}": slot acquired (active=${active}/${concurrency})`);

        // Fire-and-forget: process message concurrently, release slot when done
        this.processLaneMessage(msg, signal)
          .catch(err => {
            if (!signal.aborted) {
              log.error(`Lane "${lane}" message error: ${err instanceof Error ? err.message : String(err)}`);
            }
          })
          .finally(() => release());
      } catch (err) {
        if (signal.aborted) break;
        log.error(`Lane "${lane}" error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async processLaneMessage(msg: InboundMessage, signal: AbortSignal): Promise<void> {
    const tag = `${msg.channel}:${msg.chatId}`;
    try {
      // Route system messages differently (cron, heartbeat, subagents)
      if (msg.channel === 'system') {
        await this.processSystemMessage(msg);
        return;
      }

      log.info(`[${tag}] Processing: "${msg.content.slice(0, 80)}"`);
      const processStart = Date.now();
      this.deps.bus.markProcessing(msg.chatId);
      const iterCtrl = new AbortController();
      this._iterationControllers.set(msg.chatId, iterCtrl);
      let response;
      try {
        (msg as InboundMessage & { signal?: AbortSignal }).signal = iterCtrl.signal;
        response = await this.processMessage(msg);
      } finally {
        this._iterationControllers.delete(msg.chatId);
        this.deps.bus.clearProcessing(msg.chatId);
      }
      if (!response.streamed) {
        await this.deps.bus.publishOutbound(response, signal);
      }
      log.info(`[${tag}] Done in ${Date.now() - processStart}ms (streamed=${!!response.streamed})`);
    } catch (err) {
      if (signal.aborted) return;
      const errorText = err instanceof Error ? err.message : String(err);
      log.error(`[${tag}] Error: ${errorText}`);

      const errorResponse: OutboundMessage = {
        chatId: msg.chatId,
        channel: msg.channel,
        content: `Error: ${errorText}`,
        timestamp: new Date(),
      };
      await this.deps.bus.publishOutbound(errorResponse, signal).catch(() => {});
    }
  }

  private async processMessage(msg: InboundMessage, externalReqCtx?: Partial<RequestContext>): Promise<OutboundMessage & { streamed?: boolean }> {
    // LLM purpose routing: heartbeat → background (Haiku), everything else → default (Opus)
    const llmPurpose = msg.lane === 'heartbeat' ? 'heartbeat' : 'chat';

    // 0. Resolve agent from bindings
    const agentCtx = this.deps.agentResolver?.resolve(msg);
    const agentId = agentCtx?.id ?? 'main';
    if (agentCtx && !agentCtx.memoryShared) {
      ensureAgentDir(agentId, this.deps.config.workspace.dir);
    }
    const sessionKey = this.deps.agentResolver
      ? this.deps.agentResolver.resolveSessionKey(agentId, msg)
      : `${agentId}:${msg.channel}:${msg.chatId}`;

    // 1. Resolve user profile (if multi-user)
    const userProfile = msg.user?.userId
      ? findUserProfile(msg.user.userId, this.deps.config)
      : undefined;

    // 2. Update tool contexts (static — workspace/deny patterns, safe to share across lanes)
    this.deps.tools.setContext({
      workspaceDir: this.deps.config.workspace.dir,
      execDenyPatterns: [...this.deps.config.tools.execDenyPatterns, ...(this.deps.config.tools.execDenyPatternsExtra ?? [])],
      execTimeout: this.deps.config.tools.execTimeout,
      maxFileSize: this.deps.config.tools.maxFileSize,
      webFetchTimeoutMs: this.deps.config.tools.webFetchTimeoutMs,
      webFetchMaxBytes: this.deps.config.tools.webFetchMaxBytes,
      cronDepth: msg.cronDepth,
      browserChromePath: this.deps.config.browserOperator?.chromePath,
      browserProfileDir: this.deps.config.browserOperator?.profileDir,
      browserHeadless: this.deps.config.browserOperator?.headless,
    });

    // Per-request context — passed to execute(), not shared across concurrent lanes
    const family = this.deps.config.family;
    const isFamilyChat = family && msg.chatId && family.groupChatIds.includes(msg.chatId);
    // Family members see each other's reminders even in private chats (cross-user visibility)
    const isFamilyMember = family && msg.user?.userId
      && this.deps.config.users.some(u => u.id === msg.user?.userId);
    const familyUserIds = (isFamilyChat || isFamilyMember)
      ? this.deps.config.users.map(u => u.id)
      : undefined;

    // Owner check: ownerIds from config, or first user if not set.
    // In multi-user mode (users configured), unknown userId is NOT owner.
    // In single-user CLI mode (no users), assume owner for backward compat.
    const ownerIds = this.deps.config.ownerIds.length > 0
      ? this.deps.config.ownerIds
      : this.deps.config.users.length > 0 ? [this.deps.config.users[0].id] : [];
    const hasMultiUser = this.deps.config.users.length > 0;
    const isOwner = hasMultiUser
      ? !!msg.user?.userId && ownerIds.includes(msg.user.userId)
      : !msg.user?.userId || ownerIds.includes(msg.user.userId);

    // Merge agent + user tool filters: allow ∩ (both must allow), deny ∪ (either can deny)
    const mergedToolAllow = agentCtx?.toolAllow && userProfile?.tools?.allow
      ? agentCtx.toolAllow.filter(t => userProfile.tools!.allow!.includes(t))
      : agentCtx?.toolAllow ?? userProfile?.tools?.allow;
    const mergedToolDeny = [
      ...(agentCtx?.toolDeny ?? []),
      ...(userProfile?.tools?.deny ?? []),
    ];

    const reqCtx: RequestContext = {
      chatId: msg.chatId,
      userId: msg.user?.userId,
      isOwner,
      familyUserIds,
      userToolAllow: mergedToolAllow,
      userToolDeny: mergedToolDeny.length > 0 ? mergedToolDeny : undefined,
      toolPolicy: userProfile?.tools?.policy,
      sentTargets: externalReqCtx?.sentTargets ?? [],
    };

    // 3. Get session + build system prompt (split into static/dynamic for prompt caching)
    const t0 = Date.now();
    const session = await this.deps.sessions.getOrCreate(sessionKey);
    const { staticPart, dynamicPart } = await this.deps.context.build({
      channel: msg.channel,
      chatId: msg.chatId,
      tools: this.deps.tools.summaries(isOwner),
      summary: session.metadata.summary,
      userMessage: msg.content,
      mode: msg.contextMode,
      user: msg.user,
      scope: msg.scope,
      agentCtx,
    });
    // dynamicPart moves to user message for Anthropic prefix cache stability
    const systemPrompt = staticPart;

    // 3. Build messages: [system, ...history, user]
    //    Trim history if estimated tokens exceed token budget
    const history = await this.deps.sessions.getHistory(sessionKey);
    const cleanHistory = repairToolMessages(history);
    let userContent = msg.replyContext
      ? `[Reply to ${msg.replyContext}]\n\n${msg.content}`
      : msg.content;

    // Context injection: for cron/heartbeat jobs, inject recent messages from the target user's
    // primary session so the cron agent can see confirmations like "done" or "cancel".
    if (msg.cronDepth && msg.cronDepth > 0) {
      const injected = await this.injectTargetSessionContext(msg, agentId);
      if (injected) {
        userContent = `${injected}\n\n${userContent}`;
      }
    }

    // Dynamic context in user message — system blocks stay stable for Anthropic prefix cache.
    // Order: <context>dynamic</context> → cron injection → reply context → user message
    if (dynamicPart) {
      userContent = `<context>\n${dynamicPart}\n</context>\n\n${userContent}`;
    }

    // Build user message — multimodal if images attached, plain string otherwise
    const userMessage: LLMMessage = msg.images?.length
      ? {
          role: 'user',
          content: [
            { type: 'text', text: userContent },
            ...msg.images.map(img => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mimeType, data: img.data },
            })),
          ],
        }
      : { role: 'user', content: userContent };

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...cleanHistory,
      userMessage,
    ];
    enforceContextBudget(messages, this.deps.config.agent);

    log.info(`[${sessionKey}] Context built in ${Date.now() - t0}ms`);

    // 4. Save user message to session BEFORE iteration
    await this.deps.sessions.append(sessionKey, [userMessage]);

    // 5. LLM iteration loop — saves tool calls to session during iteration
    const toolDefs = this.deps.tools.list();
    const startTime = Date.now();
    const streamCtx = (this.deps.config.streaming?.enabled ?? true) && msg.channel !== 'system'
      ? { channel: msg.channel, chatId: msg.chatId }
      : undefined;

    // Inject recent messages for cron context (last 5 user/assistant messages)
    reqCtx.recentMessages = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-5)
      .map(m => {
        const text = 'content' in m ? (typeof m.content === 'string' ? m.content : userContentText(m.content)) : '';
        return `${m.role}: ${safeSlice(text, 0, 200)}`;
      });

    const systemParts = { staticPart, dynamicPart };
    const iterResult = await this.iterate(messages, toolDefs, sessionKey, streamCtx, (msg as InboundMessage & { signal?: AbortSignal }).signal, msg.chatId, reqCtx, agentCtx, llmPurpose, msg.lane, systemParts);

    // 6. Save final assistant message
    await this.deps.sessions.append(sessionKey, [
      { role: 'assistant', content: iterResult.content },
    ]);

    // 6b. Record execution for learner (fire and forget)
    if (this.deps.learner) {
      this.deps.learner.recordExecution({
        task: msg.content.slice(0, 200),
        duration: Date.now() - startTime,
        iterations: iterResult.iterations,
        toolCalls: iterResult.toolCalls,
        tokenUsage: iterResult.totalTokens,
        outcome: iterResult.outcome,
        timestamp: new Date().toISOString(),
      }).catch(err => {
        log.warn(`Learner record failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    const content = iterResult.content;

    // 6c. Pointer-based memory flush tracking
    const fullSession = await this.deps.sessions.getOrCreate(sessionKey);

    // Initialize flush state from session metadata (migration-safe)
    if (!this.flushState.has(sessionKey)) {
      this.flushState.set(sessionKey, {
        lastFlushed: fullSession.metadata.lastFlushed ?? 0,
      });
    }
    const state = this.flushState.get(sessionKey)!;
    state.userId = msg.user?.userId;
    state.userName = msg.user?.name;
    state.scope = msg.scope;

    // Token-aware flush trigger (40% of budget)
    const unflushed = fullSession.messages.length - state.lastFlushed;
    const sessionTokenEstimate = estimateMessagesTokens(fullSession.messages);
    const tokenFlushThreshold = this.deps.config.agent.tokenBudget * 0.4;
    if (this.deps.memory && unflushed > 0 && !state.flushing && sessionTokenEstimate > tokenFlushThreshold) {
      this.flushMemory(sessionKey, state.userId, state.scope).catch(err => {
        log.warn(`Token-aware memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // 7. Maybe summarize (async, non-blocking)
    // CR-AU: Skip compaction for heartbeat/cron — they're short-lived, compaction wastes tokens
    const isEphemeralLane = msg.lane === 'heartbeat' || msg.lane === 'cron';
    const tokenThreshold = this.deps.config.agent.tokenBudget * 0.75;
    if (!isEphemeralLane && (fullSession.messages.length > this.deps.config.agent.summarizationThreshold
        || sessionTokenEstimate > tokenThreshold)) {
      // Double-fire guard: skip if already summarizing this session (C2)
      if (this.summarizing.has(sessionKey)) {
        log.debug(`[${sessionKey}] Skipping summarization — already in progress`);
      } else {
        this.triggerSummarization(sessionKey, fullSession.messages, msg.user?.userId, msg.scope, sessionTokenEstimate).catch(err => {
          log.warn(`Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    return {
      chatId: msg.chatId,
      channel: msg.channel,
      content,
      timestamp: new Date(),
      streamed: !!streamCtx,
      voiceReply: msg.isVoice && !!this.deps.config.tts?.enabled,
    };
  }

  /** Handle system messages (cron, heartbeat, subagents). */
  private async processSystemMessage(msg: InboundMessage): Promise<void> {
    log.info(`System message: ${msg.content.slice(0, 100)}`);

    // Track targets the message tool sent to during this turn (for dedup)
    const sentTargets: Array<{ channel: string; chatId: string }> = [];

    // Process as a regular message but with system session key
    const response = await this.processMessage(msg, { sentTargets });

    // Suppress no-op / internal summary responses from heartbeat/cron
    const trimmed = response.content.trim();
    const isNoOp = /^(HEARTBEAT_OK|no.?op|nothing to do|all good)/i.test(trimmed);
    const isSummary = /^(\*\*)?run summary/i.test(trimmed) || /^(task|job) (completed|done|finished)/i.test(trimmed);
    if (isNoOp || isSummary) {
      log.debug(`Suppressing system response: "${trimmed.slice(0, 80)}"`);
      return;
    }

    if (!response.streamed && msg.chatId !== 'internal') {
      // Route cron/heartbeat responses to the correct channel
      if (msg.chatId.startsWith('cron:') || msg.chatId.startsWith('heartbeat')) {
        // Per-user routing: find user's channel identity
        if (msg.user?.userId) {
          const userProfile = findUserProfile(msg.user.userId, this.deps.config);
          const identity = userProfile?.identities.find(i => i.channelUserId);
          if (identity?.channelUserId) {
            response.channel = identity.channel;
            response.chatId = identity.channelUserId;
            if (sentTargets.some(t => t.channel === response.channel && t.chatId === response.chatId)) {
              log.debug(`Suppressing system response — message tool already delivered to ${response.channel}:${response.chatId}`);
              return;
            }
          } else {
            log.warn(`Cron response for user "${msg.user.userId}" has no channel identity — suppressing`);
            return;
          }
        } else {
          // No userId — broadcast to all users via their configured channels
          if (this.deps.config.users.length > 0 && this.deps.bus.hasHandlers) {
            for (const user of this.deps.config.users) {
              const identity = user.identities.find(i => i.channelUserId);
              if (identity?.channelUserId) {
                if (sentTargets.some(t => t.channel === identity.channel && t.chatId === identity.channelUserId)) continue;
                await this.deps.bus.publishOutbound({
                  ...response,
                  channel: identity.channel,
                  chatId: identity.channelUserId,
                }, new AbortController().signal).catch(() => {});
              }
            }
            return;
          }
          if (!this.deps.bus.hasHandlers) {
            response.channel = 'cli';
          } else {
            log.warn(`Cron response has no userId and no users configured — suppressing`);
            return;
          }
        }
      } else if (msg.channel === 'system' && !msg.chatId.startsWith('cron:') && !msg.chatId.startsWith('heartbeat')) {
        // Group chat cron job — chatId is a real chat ID, find the registered channel
        const registeredChannel = this.findChannelForChat(msg.chatId);
        response.channel = registeredChannel;
        response.chatId = msg.chatId;
      }

      if (sentTargets.some(t => t.channel === response.channel && t.chatId === response.chatId)) {
        log.debug(`Suppressing system response — message tool already delivered to ${response.channel}:${response.chatId}`);
        return;
      }

      await this.deps.bus.publishOutbound(response, new AbortController().signal).catch(err => {
        log.warn(`Failed to publish system message response: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Clear cron/heartbeat sessions after each run — they're stateless
    // (tasks fetch fresh data via tools, user replies go to telegram session)
    if (msg.lane === 'heartbeat' || msg.lane === 'cron') {
      const agentId = this.deps.agentResolver?.resolve(msg)?.id ?? 'main';
      const sessionKey = `${agentId}:${msg.channel}:${msg.chatId}`;
      try {
        const session = await this.deps.sessions.getOrCreate(sessionKey);
        const estimate = estimateMessagesTokens(session.messages);
        if (estimate > 80_000) {
          log.warn(`[${sessionKey}] Cron session reached ~${Math.round(estimate / 1000)}K tokens`);
        }
        log.info(`[${sessionKey}] Cron session cleared (~${Math.round(estimate / 1000)}K tokens)`);
        await this.deps.sessions.clear(sessionKey);
      } catch (err) {
        log.warn(`Failed to clear cron session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Inject recent messages from target users' sessions into cron context.
   * Multi-target: looks up job targets, builds status summary, injects messages from pending targets.
   * Fallback: for legacy jobs without targets, delegates to injectOwnerSessionContext.
   */
  private async injectTargetSessionContext(msg: InboundMessage, agentId: string): Promise<string | null> {
    // Extract job ID from message content
    const jobIdMatch = typeof msg.content === 'string' ? msg.content.match(/\(id: ([a-f0-9-]+)\)/) : null;
    if (!jobIdMatch) {
      return this.injectOwnerSessionContext(msg, agentId);
    }

    const jobId = jobIdMatch[1];
    const job = this.deps.cronService?.getJob(jobId);
    if (!job || !job.targets.length) {
      return this.injectOwnerSessionContext(msg, agentId);
    }

    const targets = job.targets;
    const userTargets = targets.filter(t => t.userId);
    const pendingTargets = userTargets.filter(t => t.status === 'pending');

    // Build status summary
    const statusLines = targets.map(t => {
      const id = t.userId ?? t.chatId ?? 'unknown';
      return `- ${id}: ${t.status}${t.statusAt ? ` (${t.statusAt})` : ''}`;
    }).join('\n');

    // Inject recent messages from pending targets (max 3 targets, 5 msgs each)
    let recentMessages = '';
    const injectTargets = pendingTargets.slice(0, 3);
    for (const target of injectTargets) {
      if (!target.userId) continue;
      const profile = findUserProfile(target.userId, this.deps.config);
      const identity = profile?.identities.find(i => i.channelUserId);
      if (!identity) {
        recentMessages += `\n--- Cannot read session for ${target.userId} — profile or identity not found ---\n`;
        log.warn(`Cron context injection: cannot resolve session for user ${target.userId}`);
        continue;
      }
      const sessionKey = this.deps.agentResolver
        ? this.deps.agentResolver.resolveSessionKey(agentId, { ...msg, channel: identity.channel, chatId: identity.channelUserId! })
        : `${agentId}:${identity.channel}:${identity.channelUserId}`;
      try {
        const history = await this.deps.sessions.getHistory(sessionKey);
        const textMsgs = history
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-5);
        if (textMsgs.length > 0) {
          recentMessages += `\n--- Recent messages from ${target.userId} ---\n`;
          recentMessages += textMsgs.map(m => `${m.role}: ${safeSlice(userContentText(m.content as string | UserContentBlock[]), 0, 300)}`).join('\n');
          recentMessages += `\n--- End ---\n`;
        }
      } catch {
        recentMessages += `\n--- Cannot read session for ${target.userId} ---\n`;
      }
    }

    if (pendingTargets.length > 3) {
      recentMessages += `\n(${pendingTargets.length - 3} more pending targets — messages not shown)\n`;
    }

    return loadPrompt('cron/cron-context-injection', {
      name: job.name,
      jobId: job.id,
      owner: job.userId ?? 'system',
      targetStatus: statusLines,
      recentMessages,
    });
  }

  /** Fallback: inject from owner's session for self-reminder/legacy jobs (old behavior). */
  private async injectOwnerSessionContext(msg: InboundMessage, agentId: string): Promise<string | null> {
    let sourceSessionKey: string | null = null;

    // 1. Real group chat ID → use group session
    if (msg.chatId && !msg.chatId.startsWith('cron:') && !msg.chatId.startsWith('heartbeat')) {
      const channel = this.findChannelForChat(msg.chatId);
      sourceSessionKey = this.deps.agentResolver
        ? this.deps.agentResolver.resolveSessionKey(agentId, { ...msg, channel, chatId: msg.chatId })
        : `${agentId}:${channel}:${msg.chatId}`;
    }
    // 2. User-targeted job → find user's primary DM session
    else if (msg.user?.userId) {
      const profile = findUserProfile(msg.user.userId, this.deps.config);
      const identity = profile?.identities.find(i => i.channelUserId);
      if (identity?.channelUserId) {
        sourceSessionKey = this.deps.agentResolver
          ? this.deps.agentResolver.resolveSessionKey(agentId, {
              ...msg,
              channel: identity.channel,
              chatId: identity.channelUserId,
            })
          : `${agentId}:${identity.channel}:${identity.channelUserId}`;
      }
    }

    if (!sourceSessionKey) return null;

    try {
      const recentMessages = await this.deps.sessions.getHistory(sourceSessionKey);
      const textMessages = recentMessages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-10);

      if (textMessages.length === 0) return null;

      const formatted = textMessages
        .map(m => `${m.role}: ${safeSlice(userContentText(m.content as string | UserContentBlock[]), 0, 300)}`)
        .join('\n');

      // Use inline format for legacy injection (prompt template now uses multi-target variables)
      return `[Recent messages from target user's conversation:\n${formatted}\nEnd of recent messages — if the user already confirmed or rejected the task, update the cron job status accordingly using cron update.]`;
    } catch {
      return null;
    }
  }

  /** Resolve which registered channel can deliver to a given chatId. */
  private findChannelForChat(_chatId: string): string {
    // Use the first registered messaging channel (non-CLI)
    const channels = this.deps.bus.registeredChannels;
    return channels.find(c => c !== 'cli') ?? channels[0] ?? 'cli';
  }

  /**
   * LLM iteration loop — iterate until no tool_calls or max iterations.
   * Each tool call + result is saved to session for crash recovery.
   */
  private async iterate(
    messages: LLMMessage[],
    tools: ReturnType<ToolRegistry['list']>,
    sessionKey: string,
    streamCtx?: { channel: string; chatId: string },
    signal?: AbortSignal,
    chatId?: string,
    reqCtx?: RequestContext,
    agentCtx?: AgentContext,
    llmPurpose: string = 'chat',
    lane?: string,
    systemParts?: { staticPart: string; dynamicPart: string },
  ): Promise<IterateResult> {
    let lastContent = '';
    let totalToolCalls = 0;
    let totalTokens = 0;
    let contextRetries = 0;
    let llmRetries = 0;
    const seenToolCalls = new Set<string>();
    const toolFailCounts = new Map<string, number>(); // tool name → consecutive failure count
    const MAX_ITERATIONS = 200; // Hard safety limit — prevent infinite loops
    const recentToolSigs: string[] = []; // Track recent tool call signatures for loop detection
    const LOOP_WINDOW = 6; // Check last N tool calls for repeating patterns

    for (let i = 0; ; i++) {
      // Iteration hard limit (OD-A)
      if (i >= MAX_ITERATIONS) {
        log.warn(`[${sessionKey}] Hit iteration limit (${MAX_ITERATIONS})`);
        return { content: lastContent || `Stopped: reached ${MAX_ITERATIONS} iteration safety limit.`, iterations: i, toolCalls: totalToolCalls, totalTokens, outcome: 'error' };
      }

      if (signal?.aborted) {
        if (streamCtx) {
          this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'stream_end');
        }
        return { content: lastContent || 'Stopped.', iterations: i, toolCalls: totalToolCalls, totalTokens, outcome: 'error' };
      }

      // Inject steering messages from user (sent while agent was processing)
      if (chatId) {
        const steering = this.deps.bus.drainSteering(chatId);
        for (const s of steering) {
          const steerMsg: LLMMessage = { role: 'user', content: s.content };
          messages.push(steerMsg);
          await this.deps.sessions.append(sessionKey, [steerMsg]);
          log.info(`Steering injected: "${s.content.slice(0, 80)}"`);
        }
      }

      // Proactive context budget enforcement
      enforceContextBudget(messages, this.deps.config.agent);
      // Emergency: if still over threshold, run without protected tail
      const emergencyThreshold = this.deps.config.agent.context.emergencyThreshold;
      if (estimateMessagesTokens(messages) > this.deps.config.agent.tokenBudget * emergencyThreshold) {
        log.warn(`[${sessionKey}] Emergency compression — over ${Math.round(emergencyThreshold * 100)}% budget`);
        enforceContextBudget(messages, this.deps.config.agent, true);
      }

      let response;
      const r = this.deps.config.resolved;
      const thinkingConfig = r.thinking;
      const thinkingLevel = thinkingConfig?.level;
      const thinkingEnabled = thinkingLevel ? thinkingLevel !== 'off' : thinkingConfig?.enabled;
      const thinkingBudget = thinkingLevel ? (THINKING_LEVEL_BUDGETS[thinkingLevel] ?? 10000) : (thinkingConfig?.budgetTokens ?? 10000);
      // Model is empty — ProviderRegistry fills it from the registered entry
      const chatRequest = {
        model: '',
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: agentCtx?.params?.temperature
          ?? (i > 0 && r.toolTemperature != null ? r.toolTemperature : r.temperature),
        maxTokens: agentCtx?.params?.maxTokens ?? r.maxTokens,
        ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget } } : {}),
        ...(r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}),
        // Split system prompt for Anthropic prompt caching (static cached, dynamic uncached)
        ...(systemParts ? { systemParts } : {}),
      };

      try {
        const llmStart = Date.now();
        log.info(`[${sessionKey}] LLM call start (iteration ${i + 1})`);
        const streamingEnabled = this.deps.config.streaming?.enabled ?? true;
        if (streamingEnabled && streamCtx) {
          // Use streaming — chunks go to the channel in real-time
          const onChunk = (chunk: string) => {
            this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'chunk', chunk);
          };
          response = await this.deps.llm.chatStream(chatRequest, onChunk, llmPurpose);
        } else {
          response = await this.deps.llm.chat(chatRequest, llmPurpose);
        }
        log.info(`[${sessionKey}] LLM call done in ${Date.now() - llmStart}ms (tokens=${response.usage.totalTokens})`);
        logTokenUsage(lane ?? 'chat', response.usage, response.provider, response.model);
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        const isContextError = /token|context|length|too long/i.test(errorText);
        const isTimeout = /timeout|timed out|ETIMEDOUT|ECONNRESET/i.test(errorText);

        // CR-BW: Timeout with high context usage → likely context too large, compress
        if (isTimeout && contextRetries < 2 && messages.length > 6) {
          const estTokens = estimateMessagesTokens(messages);
          if (estTokens > this.deps.config.agent.tokenBudget * 0.7) {
            contextRetries++;
            log.warn(`[${sessionKey}] LLM timeout with high context (${estTokens}/${this.deps.config.agent.tokenBudget}), compressing`);
            enforceContextBudget(messages, this.deps.config.agent, true);
            continue;
          }
        }

        if (isContextError && contextRetries < 2) {
          contextRetries++;
          log.warn(`Context overflow, emergency compression (attempt ${contextRetries})`);
          enforceContextBudget(messages, this.deps.config.agent, true);
          continue;
        }

        // Detect orphaned tool_use (missing tool_result) and auto-repair
        if (/tool_use.*without.*tool_result/i.test(errorText)) {
          log.warn('Detected orphaned tool_use — repairing message history');
          messages = [messages[0], ...repairToolMessages(messages.slice(1))];
          continue;
        }

        log.error(`LLM error: ${errorText}`);

        // Don't retry client errors (400) — they never self-heal
        const isClientError = /^4\d\d\s|"status":\s*4\d\d|invalid_request|malformed/i.test(errorText);

        if (this.deps.config.agent.onLLMError === 'retry' && !isClientError && llmRetries < 5) {
          llmRetries++;
          const delay = Math.min(1000 * 2 ** (llmRetries - 1), 30_000);
          log.info(`LLM error recovery: retry ${llmRetries}/5 in ${delay}ms...`);
          if (llmRetries === 1 && streamCtx) {
            this.deps.bus.publishOutbound({
              chatId: streamCtx.chatId,
              channel: streamCtx.channel,
              content: '⏳ API is temporarily overloaded, retrying...',
              timestamp: new Date(),
              type: 'message',
            }).catch(() => {});
          }
          await sleep(delay, signal);
          continue;
        }
        const isOverloaded = /overloaded/i.test(errorText);
        const userMessage = isOverloaded
          ? 'API is overloaded — could not get a response. Please try again shortly.'
          : 'API error — could not get a response. Please try again.';
        const errorContent = lastContent || userMessage;
        if (streamCtx) {
          // Send as standalone message, not stream chunk (stream state may be stale)
          this.deps.bus.publishOutbound({
            chatId: streamCtx.chatId,
            channel: streamCtx.channel,
            content: errorContent,
            timestamp: new Date(),
            type: 'message',
          }).catch(() => {});
        }
        return { content: errorContent, iterations: i + 1, toolCalls: totalToolCalls, totalTokens, outcome: 'error' };
      }

      lastContent = stripControlTokens(response.content);
      totalTokens += response.usage.totalTokens;

      // Normalize tool call IDs (Anthropic max 64 chars, OpenAI can generate 400+)
      for (const tc of response.toolCalls) {
        if (tc.id.length > 64) {
          tc.id = tc.id.slice(0, 64);
        }
      }

      // No tool calls — done
      if (response.toolCalls.length === 0) {
        if (streamCtx && (this.deps.config.streaming?.enabled ?? true)) {
          this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'stream_end');
        }
        return { content: lastContent, iterations: i + 1, toolCalls: totalToolCalls, totalTokens, outcome: 'success' };
      }

      // Flush current stream text (keep state alive) and show typing while tools execute
      if (streamCtx) {
        if (this.deps.config.streaming?.enabled ?? true) {
          this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'stream_flush');
        }
        this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'typing');
      }

      // Add assistant message with tool_calls to context
      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      messages.push(assistantMsg);

      // Note: assistant+tool_calls saved together with tool results below (atomic)

      // Execute tool calls — parallel when multiple, sequential for single
      const uniqueCalls: typeof response.toolCalls = [];
      const dupMessages: LLMMessage[] = [];

      for (const tc of response.toolCalls) {
        const callSig = `${tc.function.name}:${tc.function.arguments}`;
        if (seenToolCalls.has(callSig)) {
          dupMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Skipped: identical tool call already executed. Try a different approach.' });
        } else {
          seenToolCalls.add(callSig);
          uniqueCalls.push(tc);
        }
      }

      // Add duplicate skip messages to context (persisted with tool results below)
      for (const msg of dupMessages) {
        messages.push(msg);
      }

      // Execute unique tool calls (parallel when >1)
      const executeOne = async (tc: typeof uniqueCalls[0]): Promise<LLMMessage> => {
        let args: Record<string, unknown>;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        log.info(`Tool: ${tc.function.name}(${summarizeArgs(args)})`);
        totalToolCalls++;
        const maxRetries = this.deps.config.agent.toolRetries;
        let rawResult = await this.deps.tools.execute(tc.function.name, args, reqCtx);

        for (let attempt = 1; attempt < maxRetries && rawResult.startsWith('Error:'); attempt++) {
          log.warn(`Tool "${tc.function.name}" failed (attempt ${attempt}/${maxRetries}), retrying...`);
          await sleep(500 * attempt, signal);
          rawResult = await this.deps.tools.execute(tc.function.name, args, reqCtx);
        }

        // Error recovery: ask user whether to continue after persistent failure
        if (rawResult.startsWith('Error:') && this.deps.config.agent.onToolError === 'ask' && this.deps.gateService) {
          const allowed = await this.deps.gateService.confirm({
            tool: tc.function.name,
            action: `Tool "${tc.function.name}" failed: ${rawResult.slice(0, 200)}. Continue?`,
            args,
          });
          if (!allowed) {
            return { role: 'tool', tool_call_id: tc.id, content: 'Stopped by user after tool error.' };
          }
        }

        // Track consecutive failures per tool name for loop detection
        if (rawResult.startsWith('Error:')) {
          const count = (toolFailCounts.get(tc.function.name) ?? 0) + 1;
          toolFailCounts.set(tc.function.name, count);
          if (count >= 3) {
            const hint = `\n\n[Circuit breaker: "${tc.function.name}" has failed ${count} consecutive times. Stop using this tool and try a completely different approach.]`;
            return { role: 'tool', tool_call_id: tc.id, content: truncateToolResult(rawResult) + hint };
          }
        } else {
          toolFailCounts.delete(tc.function.name); // Reset on success
        }

        return { role: 'tool', tool_call_id: tc.id, content: parseToolResult(rawResult) };
      };

      const toolResults = uniqueCalls.length > 1
        ? await Promise.all(uniqueCalls.map(executeOne))
        : uniqueCalls.length === 1
          ? [await executeOne(uniqueCalls[0])]
          : [];

      // Append results in original order (preserves determinism)
      for (const toolMsg of toolResults) {
        messages.push(toolMsg);
      }

      // Cross-tool loop detection (OD-A): track tool call signatures
      // Include args hash so web_fetch(url1) ≠ web_fetch(url2) — prevents false positives on parallel batch calls
      for (const tc of uniqueCalls) {
        const argsHash = tc.function.arguments.length > 0 ? simpleHash(tc.function.arguments) : '';
        recentToolSigs.push(`${tc.function.name}:${argsHash}`);
        if (recentToolSigs.length > LOOP_WINDOW * 2) recentToolSigs.shift();
      }
      if (recentToolSigs.length >= LOOP_WINDOW) {
        const recent = recentToolSigs.slice(-LOOP_WINDOW);
        const half = LOOP_WINDOW / 2;
        const firstHalf = recent.slice(0, half).join(',');
        const secondHalf = recent.slice(half).join(',');
        if (firstHalf === secondHalf) {
          log.warn(`[${sessionKey}] Cross-tool loop detected: ${firstHalf} repeating`);
          messages.push({ role: 'user', content: '[System: Repeating tool call pattern detected. You are stuck in a loop. Stop calling tools and respond to the user with what you have so far.]' });
        }
      }

      // Atomic save: assistant + tool_calls + dup skip messages + tool results
      // Prevents orphan tool_use without matching tool_result on crash
      const toSave: LLMMessage[] = [assistantMsg, ...dupMessages, ...toolResults];
      if (toSave.length > 0) {
        await this.deps.sessions.append(sessionKey, toSave);
      }

      // Append significant tool calls to HISTORY.md (fire and forget)
      if (this.deps.memory && response.toolCalls.length > 0) {
        const historySummary = response.toolCalls.map(tc => {
          try { return `${tc.function.name}(${summarizeArgs(JSON.parse(tc.function.arguments))})`; }
          catch { return tc.function.name; }
        }).join(', ');
        this.deps.memory.appendHistory(historySummary).catch(() => {});
      }

      // Reflection nudge — reduce tool thrashing by prompting analysis
      if (response.toolCalls.length >= 2) {
        const reflectMsg: LLMMessage = {
          role: 'user',
          content: '[Reflect on the tool results above before proceeding. Are you on track?]',
        };
        messages.push(reflectMsg);
      }

    }

    // Unreachable — loop terminates via: no tool calls, /stop, token budget,
    // circuit breaker, tool dedup, or LLM error exhaustion.
    return { content: lastContent, iterations: 0, toolCalls: totalToolCalls, totalTokens, outcome: 'success' };
  }

  /** Extract key facts from messages and save to daily notes + HISTORY.md + MEMORY.md. */
  private async flushMemory(sessionKey: string, userId?: string, scope?: InboundMessage['scope'], upToIndex?: number): Promise<void> {
    if (!this.deps.memory) return;

    const state = this.flushState.get(sessionKey);
    if (!state) return;
    if (state.flushing) return;
    state.flushing = true;

    const session = await this.deps.sessions.getOrCreate(sessionKey);
    const from = state.lastFlushed;
    const to = upToIndex ?? session.messages.length;
    const messagesToFlush = session.messages.slice(from, to);
    if (messagesToFlush.length === 0) { state.flushing = false; return; }
    try {
      // Build context: session summary + current MEMORY.md
      const currentMemory = await this.deps.memory.readMemory(userId);
      const sessionSummary = session.metadata.summary ?? '';
      const contextParts: string[] = [];
      const userName = this.flushState.get(sessionKey)?.userName;
      if (userName || userId) {
        contextParts.push(`This conversation is with user "${userName ?? userId}" (ID: ${userId ?? 'unknown'}). Attribute facts to this user, not to others.`);
      }
      if (sessionSummary) contextParts.push(`Previous conversation context:\n${sessionSummary}`);
      if (currentMemory.trim()) contextParts.push(`Current MEMORY.md:\n${currentMemory}`);
      const contextStr = contextParts.length > 0 ? contextParts.join('\n\n') + '\n\n' : '';

      const messagesText = messagesToFlush.map(m =>
        `${m.role}: ${'content' in m ? (typeof m.content === 'string' ? m.content : userContentText(m.content)) : ''}`,
      ).join('\n');

      log.info(`[${sessionKey}] Memory flush: ${messagesToFlush.length} messages (${from}→${to}), LLM call start`);
      const flushStart = Date.now();

      const flushResponse = await withTimeout(this.deps.llm.chat({
        model: '',
        messages: [
          { role: 'system', content: `You are a memory manager. Extract and preserve important information from conversation messages.

${contextStr}Respond in this exact format:

<summary>1-2 sentence summary of what happened. Include specific names, numbers, decisions.</summary>
<facts>
- Key fact 1
- Key fact 2
(Write NONE if nothing worth remembering)
</facts>
<memory>
Full updated MEMORY.md with new facts merged into existing content. Keep valid existing info, add new details, remove outdated info. Organize by topic.
(Write UNCHANGED if no updates needed)
</memory>` },
          { role: 'user', content: `New messages to process:\n${messagesText}` },
        ],
        temperature: 0.3,
        // CR-AT: Reserve headroom — cap completion tokens so prompt + output fits context
        maxTokens: Math.min(2048, Math.max(512, Math.floor(this.deps.config.agent.tokenBudget * 0.1))),
      }, 'summarize'), 90_000, 'Memory flush LLM call timed out');

      log.info(`[${sessionKey}] Memory flush: LLM call done in ${Date.now() - flushStart}ms`);
      logTokenUsage('flush', flushResponse.usage, flushResponse.provider, flushResponse.model);

      const response = flushResponse.content;
      const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/);
      const factsMatch = response.match(/<facts>([\s\S]*?)<\/facts>/);
      const memoryMatch = response.match(/<memory>([\s\S]*?)<\/memory>/);

      const summary = summaryMatch?.[1]?.trim() ?? '';
      const facts = factsMatch?.[1]?.trim() ?? '';
      const memoryUpdate = memoryMatch?.[1]?.trim() ?? '';

      // HISTORY.md — append-only safety net (never lost)
      if (summary && summary !== 'NONE') {
        await this.deps.memory.appendHistory(`[memory flush] ${summary}`);
      }

      // Daily notes — for temporal search (FTS5 + vector)
      if (facts && facts !== 'NONE') {
        await this.deps.memory.appendDaily(`## Session notes\n${facts}`, userId, scope);
      }

      // MEMORY.md — holistic update (merge new facts into existing, per-user when userId available)
      if (memoryUpdate && memoryUpdate !== 'UNCHANGED' && memoryUpdate !== 'NONE') {
        await this.deps.memory.writeMemory(memoryUpdate, userId);
      }

      // Fallback: if XML parsing failed, treat whole response as daily notes
      if (!summaryMatch && !factsMatch && !memoryMatch && response.trim() !== 'NONE') {
        await this.deps.memory.appendDaily(`## Session notes\n${response}`, userId, scope);
        await this.deps.memory.appendHistory(`[memory flush] Session notes extracted`);
      }

      // Update pointer
      state.lastFlushed = to;
      session.metadata.lastFlushed = to;

      log.info(`[${sessionKey}] Memory flush: saved (pointer ${from}→${to})`);
    } finally {
      state.flushing = false;
    }
  }

  /** Flush memory for all sessions with unflushed messages. Call on shutdown. */
  async flushAllSessions(): Promise<void> {
    if (!this.deps.memory) return;

    // Find sessions with unflushed messages
    const toFlush: Array<[string, typeof this.flushState extends Map<string, infer V> ? V : never]> = [];
    for (const [sessionKey, state] of this.flushState.entries()) {
      const session = await this.deps.sessions.getOrCreate(sessionKey);
      if (state.lastFlushed < session.messages.length) {
        toFlush.push([sessionKey, state]);
      }
    }

    if (toFlush.length === 0) return;
    log.info(`Flushing memory for ${toFlush.length} session(s)...`);

    const timeout = AbortSignal.timeout(30_000);
    const promises = toFlush.map(([sessionKey, state]) =>
      this.flushMemory(sessionKey, state.userId, state.scope),
    );

    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Flush timeout')))),
      ]);
    } catch {
      log.warn('Session-end flush timed out (30s)');
    }
  }

  private async triggerSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    userId?: string,
    scope?: InboundMessage['scope'],
    preTokenEstimate?: number,
  ): Promise<void> {
    // Double-fire guard (C2)
    this.summarizing.add(sessionKey);
    try {
      await this.doSummarization(sessionKey, messages, userId, scope, preTokenEstimate);
    } finally {
      this.summarizing.delete(sessionKey);
    }
  }

  private async doSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    userId?: string,
    scope?: InboundMessage['scope'],
    _preTokenEstimate?: number,
  ): Promise<void> {
    log.info(`[${sessionKey}] Summarization: start`);
    const sumStart = Date.now();
    const keepRecentTokens = this.deps.config.agent.context.keepRecentTokens;

    // Token-based cut point: walk backwards keeping keepRecentTokens
    let tokens = 0;
    let cutIndex = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const content = 'content' in msg ? msg.content : '';
      let msgTokens: number;
      if (typeof content === 'string') {
        msgTokens = Math.ceil(content.length / 2.5);
      } else if (Array.isArray(content)) {
        const textLen = content.reduce((sum: number, b: { type: string; text?: string }) => sum + (b.type === 'text' && b.text ? b.text.length : 0), 0);
        const imageCount = content.filter((b: { type: string }) => b.type === 'image').length;
        msgTokens = Math.ceil(textLen / 2.5) + imageCount * 1000;
      } else {
        msgTokens = 100;
      }
      if (tokens + msgTokens > keepRecentTokens) {
        cutIndex = i + 1;
        // Snap forward to user message boundary
        for (let j = cutIndex; j < messages.length; j++) {
          if (messages[j].role === 'user') { cutIndex = j; break; }
        }
        break;
      }
      tokens += msgTokens;
    }

    const toSummarize = messages.slice(0, cutIndex);
    if (toSummarize.length < 4) {
      log.info(`[${sessionKey}] Summarization: too few messages to summarize, skipping`);
      return;
    }

    // Pre-compaction memory flush
    const discardUpTo = cutIndex;
    let flushed = false;
    for (let attempt = 1; attempt <= 3 && !flushed; attempt++) {
      try {
        await this.flushMemory(sessionKey, userId, scope, discardUpTo);
        flushed = true;
      } catch (err) {
        log.warn(`Pre-summarization flush attempt ${attempt}/3 failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt < 3) await sleep(2000 * attempt);
      }
    }
    if (!flushed) {
      log.error(`[${sessionKey}] All flush attempts failed — proceeding with summarization.`);
    }

    // Build conversation text for summarization.
    // Include tool interactions (truncated) — they carry essential context
    // that the summarizer needs (file contents, data written, search results).
    const TOOL_RESULT_MAX = 300;
    const rawConversation = toSummarize.map(m => {
      if (m.role === 'user') {
        const content = 'content' in m ? m.content : '';
        return `user: ${typeof content === 'string' ? content : userContentText(content as any)}`;
      }
      if (m.role === 'assistant') {
        const msg = m as { content: string; tool_calls?: ToolCall[] };
        const parts: string[] = [];
        if (msg.content) parts.push(msg.content);
        if (msg.tool_calls?.length) {
          const calls = msg.tool_calls.map(tc => tc.function.name).join(', ');
          parts.push(`[calls: ${calls}]`);
        }
        return `assistant: ${parts.join(' ')}`;
      }
      if (m.role === 'tool') {
        const content = 'content' in m ? m.content : '';
        const text = typeof content === 'string' ? content : userContentText(content as any);
        const truncated = text.length > TOOL_RESULT_MAX ? text.slice(0, TOOL_RESULT_MAX) + '…' : text;
        return `tool: ${truncated}`;
      }
      return '';
    }).filter(Boolean).join('\n');
    // Anchor the summary with current date so temporal context survives summarization.
    const conversationText = `[Current date: ${localDateWithDay()}, time: ${localTimestamp()}]\n\n${rawConversation}`;

    // Check for previous summary → iterative merge
    const session = await this.deps.sessions.getOrCreate(sessionKey);
    const previousSummary = session.metadata.summary;

    // If previous summary is too short it's likely corrupt from a broken
    // summarization cycle — discard and do a fresh initial summary.
    const MIN_USABLE_SUMMARY_TOKENS = 100;
    const prevTokens = previousSummary ? Math.ceil(previousSummary.length / 2.5) : 0;
    let systemContent: string;
    if (previousSummary && prevTokens >= MIN_USABLE_SUMMARY_TOKENS) {
      systemContent = loadPrompt('summarization/update', { previousSummary });
    } else {
      if (previousSummary && prevTokens < MIN_USABLE_SUMMARY_TOKENS) {
        log.warn(`[${sessionKey}] Previous summary too short (${prevTokens} tokens), using initial prompt instead`);
      }
      systemContent = loadPrompt('summarization/initial');
    }

    // Scale maxTokens to input size: target ~15% of input, clamped to 1024–4096.
    // At 48K input tokens, 2048 maxTokens was producing 342 tokens (0.7%) — too little.
    const inputTokens = Math.ceil(conversationText.length / 2.5);
    const summaryMaxTokens = Math.min(4096, Math.max(1024, Math.ceil(inputTokens * 0.15)));

    log.info(`[${sessionKey}] Summarization: LLM call start (input ~${inputTokens} tokens, maxTokens=${summaryMaxTokens})`);
    const llmStart = Date.now();
    const summaryResponse = await withTimeout(this.deps.llm.chat({
      model: '',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: conversationText },
      ],
      temperature: 0.3,
      maxTokens: summaryMaxTokens,
    }, 'summarize'), 90_000, 'Summarization LLM call timed out');
    log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);
    logTokenUsage('summarize', summaryResponse.usage, summaryResponse.provider, summaryResponse.model);

    let summary = summaryResponse.content;

    // Debug: log first 200 chars of summary + conversation text size to diagnose short output
    log.info(`[${sessionKey}] Summarization: output preview (${summary.length} chars): ${summary.slice(0, 200).replace(/\n/g, '\\n')}`);
    log.info(`[${sessionKey}] Summarization: conversation text ${conversationText.length} chars, system prompt ${systemContent.length} chars`);

    // Fallback chain: if summary is disproportionately short relative to input,
    // retry with lower temperature, then fall back to aggressive fact-extraction prompt.
    // Restores the safety net removed in Phase 14; uses proportional check instead of
    // the old keyword-based heuristic.
    let summaryTokens = Math.ceil(summary.length / 2.5);
    const isTooShort = inputTokens > 500 && summaryTokens < inputTokens * 0.1;

    if (isTooShort) {
      // Step 1: retry same prompt with temperature 0 (more deterministic)
      log.warn(`[${sessionKey}] Summary too short (${summaryTokens}/${inputTokens} tokens, ${Math.round(summaryTokens / inputTokens * 100)}%), retrying with temp=0`);
      try {
        const retryResponse = await withTimeout(this.deps.llm.chat({
          model: '',
          messages: [
            { role: 'system', content: systemContent },
            { role: 'user', content: conversationText },
          ],
          temperature: 0,
          maxTokens: summaryMaxTokens,
        }, 'summarize'), 90_000, 'Summarization retry timed out');
        logTokenUsage('summarize-retry', retryResponse.usage, retryResponse.provider, retryResponse.model);
        const retryTokens = Math.ceil(retryResponse.content.length / 2.5);
        if (retryTokens > summaryTokens) {
          log.info(`[${sessionKey}] Summary retry improved: ${summaryTokens} → ${retryTokens} tokens`);
          summary = retryResponse.content;
          summaryTokens = retryTokens;
        }
      } catch (err) {
        log.warn(`[${sessionKey}] Summary retry failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Step 2: if still too short, aggressive fact-extraction prompt
      if (summaryTokens < inputTokens * 0.1) {
        log.warn(`[${sessionKey}] Summary still too short (${summaryTokens} tokens), trying aggressive prompt`);
        try {
          const aggressiveResponse = await withTimeout(this.deps.llm.chat({
            model: '',
            messages: [
              { role: 'system', content: loadPrompt('summarization/aggressive') },
              { role: 'user', content: conversationText },
            ],
            temperature: 0,
            maxTokens: summaryMaxTokens,
          }, 'summarize'), 90_000, 'Aggressive summarization timed out');
          logTokenUsage('summarize-aggressive', aggressiveResponse.usage, aggressiveResponse.provider, aggressiveResponse.model);
          const aggressiveTokens = Math.ceil(aggressiveResponse.content.length / 2.5);
          if (aggressiveTokens > summaryTokens) {
            log.info(`[${sessionKey}] Aggressive summary improved: ${summaryTokens} → ${aggressiveTokens} tokens`);
            summary = aggressiveResponse.content;
            summaryTokens = aggressiveTokens;
          }
        } catch (err) {
          log.warn(`[${sessionKey}] Aggressive summarization failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    log.info(`[${sessionKey}] Summarization: ${summaryTokens} tokens (${Math.round(summaryTokens / inputTokens * 100)}% of input)`);

    await this.deps.sessions.summarize(sessionKey, summary, keepRecentTokens);

    // Sync flush pointer with post-compaction session state.
    // summarize() sets lastFlushed = remaining message count, so idle flush
    // won't re-process messages that were already covered by pre-compaction flush.
    const state = this.flushState.get(sessionKey);
    if (state) {
      const postSession = await this.deps.sessions.getOrCreate(sessionKey);
      state.lastFlushed = postSession.metadata.lastFlushed ?? postSession.messages.length;
    }

    log.info(`[${sessionKey}] Summarization: complete in ${Date.now() - sumStart}ms`);
  }
}

/**
 * Repair tool message integrity in history.
 *
 * Fixes two crash-recovery scenarios:
 * 1. Orphan tool_result at the start (no preceding assistant+tool_calls)
 * 2. Assistant with tool_calls but missing tool_result responses
 *    → adds synthetic "Error: tool execution interrupted" results
 */
function repairToolMessages(history: LLMMessage[]): LLMMessage[] {
  // 1. Strip leading orphan tool messages
  let startIdx = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'tool') {
      startIdx = i + 1;
    } else {
      break;
    }
  }

  const result: LLMMessage[] = startIdx > 0 ? history.slice(startIdx) : [...history];

  if (startIdx > 0) {
    log.warn(`Stripped ${startIdx} orphan tool message(s) from session start`);
  }

  // 2. Find assistant messages with tool_calls and ensure each has matching tool_result
  const repaired: LLMMessage[] = [];
  for (let i = 0; i < result.length; i++) {
    repaired.push(result[i]);
    const msg = result[i];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // Collect tool_result IDs that follow
      const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
      let j = i + 1;
      while (j < result.length && result[j].role === 'tool') {
        const toolMsg = result[j] as { role: 'tool'; tool_call_id: string; content: string };
        expectedIds.delete(toolMsg.tool_call_id);
        j++;
      }

      // Add synthetic results for missing tool_call_ids
      for (const missingId of expectedIds) {
        log.warn(`Repairing missing tool_result for ${missingId}`);
        repaired.push({
          role: 'tool',
          tool_call_id: missingId,
          content: 'Error: tool execution was interrupted (crash recovery)',
        });
      }
    }
  }

  return repaired;
}

/** Conservative token estimation: ~2.5 chars per token (better to over-estimate). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}


function estimateMessagesTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if ('content' in m && m.content) {
      if (typeof m.content === 'string') {
        total += estimateTokens(m.content);
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'text') total += estimateTokens(b.text);
          else if (b.type === 'image') total += 1000; // approximate image token cost
        }
      }
    }
    if ('tool_calls' in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += estimateTokens(tc.function.name + tc.function.arguments);
      }
    }
  }
  return total;
}

/**
 * Parse tool result string for multimodal content.
 * Tools can return structured results by prefixing with `__MULTIMODAL__\n`
 * followed by JSON: [{ type: 'text', text: '...' }, { type: 'image', source: { ... } }]
 */
const MULTIMODAL_PREFIX = '__MULTIMODAL__\n';

function parseToolResult(rawResult: string): string | ToolContentBlock[] {
  if (!rawResult.startsWith(MULTIMODAL_PREFIX)) return truncateToolResult(rawResult);
  try {
    const json = rawResult.slice(MULTIMODAL_PREFIX.length);
    const blocks = JSON.parse(json) as ToolContentBlock[];
    if (Array.isArray(blocks) && blocks.length > 0) {
      // Truncate text blocks only
      return blocks.map(b => b.type === 'text' ? { ...b, text: truncateToolResult(b.text) } : b);
    }
  } catch { /* fall through */ }
  return truncateToolResult(rawResult);
}

const MAX_TOOL_RESULT_CHARS = 4000;

function truncateToolResult(result: string): string {
  // Redact secrets before sending to LLM (CR-BE)
  const safe = redactSecrets(result);
  if (safe.length <= MAX_TOOL_RESULT_CHARS) return stripOrphanSurrogates(safe);
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  const trimmed = safe.length - MAX_TOOL_RESULT_CHARS;
  return `${safeSlice(safe, 0, half)}\n\n[... truncated ${trimmed} characters ...]\n\n${safeSlice(safe, safe.length - half)}`;
}

/** Fast non-crypto hash for loop detection signatures. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = JSON.stringify(v);
      return `${k}=${s.length > 60 ? s.slice(0, 57) + '...' : s}`;
    })
    .join(', ');
}
