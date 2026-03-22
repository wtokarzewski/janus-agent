import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage, Lane } from '../bus/types.js';
import type { LLMMessage, ToolContentBlock } from '../llm/types.js';
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
import * as log from '../utils/logger.js';
import { stripControlTokens } from '../utils/sanitize.js';

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
  private flushState = new Map<string, { lastFlushed: number; userId?: string; userName?: string; scope?: InboundMessage['scope']; idleTimer?: ReturnType<typeof setTimeout>; flushing?: boolean }>();
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
    // Clear idle flush timers
    for (const state of this.flushState.values()) {
      if (state.idleTimer) clearTimeout(state.idleTimer);
    }
    return { cancelled: true };
  }

  /**
   * Process a single message directly — no bus round-trip.
   * Used for: single-message CLI mode, heartbeat, subagents.
   */
  async processDirect(content: string, opts?: {
    channel?: string;
    chatId?: string;
    contextMode?: 'full' | 'minimal';
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
    const sessionKey = `${msg.channel}:${msg.chatId}`;

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
    const familyUserIds = isFamilyChat
      ? this.deps.config.users.map(u => u.id)
      : undefined;

    // Owner check: ownerIds from config, or first user if not set
    const ownerIds = this.deps.config.ownerIds.length > 0
      ? this.deps.config.ownerIds
      : this.deps.config.users.length > 0 ? [this.deps.config.users[0].id] : [];
    const isOwner = !msg.user?.userId || ownerIds.includes(msg.user.userId);

    const reqCtx: RequestContext = {
      chatId: msg.chatId,
      userId: msg.user?.userId,
      isOwner,
      familyUserIds,
      userToolAllow: userProfile?.tools?.allow,
      userToolDeny: userProfile?.tools?.deny,
      toolPolicy: userProfile?.tools?.policy,
      sentTargets: externalReqCtx?.sentTargets ?? [],
    };

    // 3. Get session + build system prompt
    const t0 = Date.now();
    const session = await this.deps.sessions.getOrCreate(sessionKey);
    const systemPrompt = await this.deps.context.build({
      channel: msg.channel,
      chatId: msg.chatId,
      tools: this.deps.tools.summaries(isOwner),
      summary: session.metadata.summary,
      userMessage: msg.content,
      mode: msg.contextMode,
      user: msg.user,
      scope: msg.scope,
    });

    // 3. Build messages: [system, ...history, user]
    //    Trim history if estimated tokens exceed token budget
    const history = await this.deps.sessions.getHistory(sessionKey);
    const cleanHistory = repairToolMessages(history);
    const maxTokens = this.deps.config.agent.tokenBudget;
    const userContent = msg.replyContext
      ? `[Reply to ${msg.replyContext}]\n\n${msg.content}`
      : msg.content;
    const trimmedHistory = trimHistoryToTokenBudget(cleanHistory, systemPrompt, userContent, maxTokens);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory,
      { role: 'user', content: userContent },
    ];

    log.info(`[${sessionKey}] Context built in ${Date.now() - t0}ms`);

    // 4. Save user message to session BEFORE iteration
    await this.deps.sessions.append(sessionKey, [
      { role: 'user', content: userContent },
    ]);

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
      .map(m => `${m.role}: ${'content' in m ? String(m.content).slice(0, 200) : ''}`);

    const iterResult = await this.iterate(messages, toolDefs, sessionKey, streamCtx, (msg as InboundMessage & { signal?: AbortSignal }).signal, msg.chatId, reqCtx);

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

    // Reset idle flush timer
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (this.deps.memory) {
      const idleMs = this.deps.config.agent.memoryIdleFlushMs;
      state.idleTimer = setTimeout(() => {
        state.idleTimer = undefined;
        this.flushMemory(sessionKey, state.userId, state.scope).catch(err => {
          log.warn(`Idle memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, idleMs);
    }

    // Count-based flush trigger (pointer-based)
    const flushInterval = this.deps.config.agent.memoryFlushInterval;
    const unflushed = fullSession.messages.length - state.lastFlushed;
    if (this.deps.memory && !state.flushing && unflushed >= flushInterval) {
      this.flushMemory(sessionKey, state.userId, state.scope).catch(err => {
        log.warn(`Periodic memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // Token-aware flush trigger (60% of budget)
    const sessionTokenEstimate = estimateMessagesTokens(fullSession.messages);
    const tokenFlushThreshold = this.deps.config.agent.tokenBudget * 0.5;
    if (this.deps.memory && unflushed > 0 && !state.flushing && sessionTokenEstimate > tokenFlushThreshold) {
      this.flushMemory(sessionKey, state.userId, state.scope).catch(err => {
        log.warn(`Token-aware memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // 7. Maybe summarize (async, non-blocking)
    const tokenThreshold = this.deps.config.agent.tokenBudget * 0.75;
    if (fullSession.messages.length > this.deps.config.agent.summarizationThreshold
        || sessionTokenEstimate > tokenThreshold) {
      // Double-fire guard: skip if already summarizing this session (C2)
      if (this.summarizing.has(sessionKey)) {
        log.debug(`[${sessionKey}] Skipping summarization — already in progress`);
      } else {
        this.triggerSummarization(sessionKey, fullSession.messages, msg.channel, msg.chatId, msg.user?.userId, msg.scope, sessionTokenEstimate).catch(err => {
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

      // Proactive context overflow detection (CR-Q)
      const currentTokens = estimateMessagesTokens(messages);
      const tokenBudget = this.deps.config.agent.tokenBudget;
      if (currentTokens > tokenBudget * 0.9) {
        log.warn(`[${sessionKey}] Context at ${Math.round(currentTokens / tokenBudget * 100)}% of budget (${currentTokens}/${tokenBudget}), pruning old tool results`);
        pruneOldToolResults(messages);
        if (estimateMessagesTokens(messages) > tokenBudget * 0.95) {
          log.warn(`[${sessionKey}] Still over budget after pruning, forcing emergency compression`);
          const nonSystem = messages.slice(1);
          const half = Math.floor(nonSystem.length / 2);
          const kept = nonSystem.slice(Math.max(half, nonSystem.length - 2));
          messages.splice(1, messages.length - 1, ...kept);
        }
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
        temperature: i > 0 && r.toolTemperature != null
          ? r.toolTemperature
          : r.temperature,
        maxTokens: r.maxTokens,
        ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget } } : {}),
        ...(r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}),
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
          response = await this.deps.llm.chatStream(chatRequest, onChunk, 'chat');
        } else {
          response = await this.deps.llm.chat(chatRequest, 'chat');
        }
        log.info(`[${sessionKey}] LLM call done in ${Date.now() - llmStart}ms (tokens=${response.usage.totalTokens})`);
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        const isContextError = /token|context|length|too long/i.test(errorText);

        if (isContextError && contextRetries < 2) {
          contextRetries++;
          log.warn(`Context overflow, emergency compression (attempt ${contextRetries})`);
          // Keep system prompt (index 0) + drop oldest 50% of remaining messages
          const nonSystem = messages.slice(1);
          const half = Math.floor(nonSystem.length / 2);
          const kept = nonSystem.slice(Math.max(half, nonSystem.length - 2));
          messages = [messages[0], ...kept];
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

      // End current stream and show typing while tools execute
      if (streamCtx) {
        if (this.deps.config.streaming?.enabled ?? true) {
          this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'stream_end');
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
      for (const tc of uniqueCalls) {
        recentToolSigs.push(tc.function.name);
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
        `${m.role}: ${'content' in m ? m.content : ''}`,
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
        maxTokens: 2048,
      }, 'flush'), 90_000, 'Memory flush LLM call timed out');

      log.info(`[${sessionKey}] Memory flush: LLM call done in ${Date.now() - flushStart}ms`);

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

    // Clear idle timers — we're flushing everything now
    for (const state of this.flushState.values()) {
      if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = undefined; }
    }

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
    channel: string,
    chatId: string,
    userId?: string,
    scope?: InboundMessage['scope'],
    preTokenEstimate?: number,
  ): Promise<void> {
    // Double-fire guard (C2)
    this.summarizing.add(sessionKey);
    try {
      // Show typing indicator during compaction (non-intrusive, auto-expires)
      this.deps.bus.publishOutbound({
        chatId, channel, content: '', timestamp: new Date(), type: 'typing',
      }, new AbortController().signal).catch(() => {});

      await this.doSummarization(sessionKey, messages, userId, scope, preTokenEstimate);
    } finally {
      this.summarizing.delete(sessionKey);
      // Stop typing after compaction completes
      this.deps.bus.publishOutbound({
        chatId, channel, content: '', timestamp: new Date(), type: 'typing_stop',
      }, new AbortController().signal).catch(() => {});
    }
  }

  private async doSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    userId?: string,
    scope?: InboundMessage['scope'],
    preTokenEstimate?: number,
  ): Promise<void> {
    log.info(`[${sessionKey}] Summarization: start`);
    const sumStart = Date.now();
    const halfIdx = Math.floor(messages.length / 2);
    const toSummarize = messages.slice(0, halfIdx);
    const keepCount = 4; // must match SessionManager.summarize()
    const discardUpTo = messages.length - keepCount;

    // Memory flush — extract key facts from ALL messages about to be discarded
    // Retry up to 3 times with exponential backoff before giving up
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
      log.error(`[${sessionKey}] All flush attempts failed — proceeding with summarization. Some memory may be lost.`);
    }

    log.info(`[${sessionKey}] Summarization: LLM call start`);
    const llmStart = Date.now();
    const summaryResponse = await withTimeout(this.deps.llm.chat({
      model: '',
      messages: [
        { role: 'system', content: 'Summarize this conversation concisely. Focus on: 1) what task the user requested, 2) what progress was made, 3) what remains to be done, 4) key decisions and context. If the user had an active task in progress, make sure to preserve what it was and where it stopped.' },
        { role: 'user', content: toSummarize.map(m => `${m.role}: ${'content' in m ? m.content : ''}`).join('\n') },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    }, 'summarize'), 90_000, 'Summarization LLM call timed out');
    log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);

    // Sanity check: verify compaction actually reduced token count (C1)
    const postSession = await this.deps.sessions.getOrCreate(sessionKey);
    const summaryTokens = estimateTokens(summaryResponse.content);
    const keptTokens = estimateMessagesTokens(postSession.messages.slice(-keepCount));
    const postEstimate = summaryTokens + keptTokens;
    const preEstimate = preTokenEstimate ?? estimateMessagesTokens(messages);
    if (postEstimate >= preEstimate) {
      log.warn(`[${sessionKey}] Compaction sanity check failed: post (${postEstimate}) >= pre (${preEstimate}) — summary may be too long`);
    } else {
      log.info(`[${sessionKey}] Compaction: ${preEstimate} → ${postEstimate} tokens (${Math.round((1 - postEstimate / preEstimate) * 100)}% reduction)`);
    }

    await this.deps.sessions.summarize(sessionKey, summaryResponse.content);

    // Reset pointer AFTER summarization completes (prevents mismatch on crash)
    const state = this.flushState.get(sessionKey);
    if (state) state.lastFlushed = 0;

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

/** Extract estimatable string from message content (handles multimodal). */
function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ToolContentBlock[])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text).join('\n');
  }
  return '';
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
 * Trim history from the front until total estimated tokens fit within budget.
 * Preserves message pairs (assistant+tool) to avoid orphan tool messages.
 */
function trimHistoryToTokenBudget(
  history: LLMMessage[],
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): LLMMessage[] {
  const fixedTokens = estimateTokens(systemPrompt) + estimateTokens(userContent);
  let historyTokens = estimateMessagesTokens(history);

  if (fixedTokens + historyTokens <= maxTokens) return history;

  const trimmed = [...history];
  while (trimmed.length > 2 && fixedTokens + historyTokens > maxTokens) {
    const removed = trimmed.shift()!;
    historyTokens -= estimateTokens(contentToString('content' in removed ? removed.content : ''));

    // If we removed an assistant message, also remove following tool messages
    // to avoid orphan tool_call_id references
    while (trimmed.length > 0 && trimmed[0].role === 'tool') {
      const toolRemoved = trimmed.shift()!;
      historyTokens -= estimateTokens(contentToString('content' in toolRemoved ? toolRemoved.content : ''));
    }
  }

  if (trimmed.length < history.length) {
    log.warn(`Trimmed ${history.length - trimmed.length} messages from history to fit token budget (est. ${fixedTokens + estimateMessagesTokens(trimmed)} / ${maxTokens})`);
  }

  return trimmed;
}

/**
 * Prune old tool results in-place to reclaim context space (OD-B).
 * Replaces verbose tool results older than the last 4 turns with truncated summaries.
 * Preserves the most recent tool results (they're likely still relevant).
 */
function pruneOldToolResults(messages: LLMMessage[]): void {
  const KEEP_RECENT = 8; // Keep last 8 messages untouched
  const PRUNED_MAX = 200; // Max chars for pruned tool result
  const cutoff = messages.length - KEEP_RECENT;
  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > PRUNED_MAX) {
      (msg as { content: string }).content = msg.content.slice(0, PRUNED_MAX) + '\n[... pruned to save context space]';
    }
  }
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
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  const trimmed = result.length - MAX_TOOL_RESULT_CHARS;
  return `${result.slice(0, half)}\n\n[... truncated ${trimmed} characters ...]\n\n${result.slice(-half)}`;
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
