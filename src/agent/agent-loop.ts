import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage, Lane } from '../bus/types.js';
import type { LLMMessage } from '../llm/types.js';
import type { ProviderRegistry } from '../llm/provider-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { RequestContext } from '../tools/types.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import type { JanusConfig } from '../config/schema.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { GateService } from '../gates/types.js';
import { findUserProfile, deriveChannelAllowlist } from '../users/user-resolver.js';
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
  private messageCounters = new Map<string, { count: number; userId?: string; scope?: InboundMessage['scope'] }>();
  private _iterationControllers = new Map<string, AbortController>();

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

  private async processMessage(msg: InboundMessage): Promise<OutboundMessage & { streamed?: boolean }> {
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
    });

    // Per-request context — passed to execute(), not shared across concurrent lanes
    const reqCtx: RequestContext = {
      chatId: msg.chatId,
      userId: msg.user?.userId,
      userToolAllow: userProfile?.tools?.allow,
      userToolDeny: userProfile?.tools?.deny,
      toolPolicy: userProfile?.tools?.policy,
    };

    // 3. Get session + build system prompt
    const t0 = Date.now();
    const session = await this.deps.sessions.getOrCreate(sessionKey);
    const systemPrompt = await this.deps.context.build({
      channel: msg.channel,
      chatId: msg.chatId,
      tools: this.deps.tools.summaries(),
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
    const trimmedHistory = trimHistoryToTokenBudget(cleanHistory, systemPrompt, msg.content, maxTokens);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory,
      { role: 'user', content: msg.content },
    ];

    log.info(`[${sessionKey}] Context built in ${Date.now() - t0}ms`);

    // 4. Save user message to session BEFORE iteration
    await this.deps.sessions.append(sessionKey, [
      { role: 'user', content: msg.content },
    ]);

    // 5. LLM iteration loop — saves tool calls to session during iteration
    const toolDefs = this.deps.tools.list();
    const maxIterations = this.deps.config.agent.maxIterations;
    const startTime = Date.now();
    const streamCtx = (this.deps.config.streaming?.enabled ?? true)
      ? { channel: msg.channel, chatId: msg.chatId }
      : undefined;
    const iterResult = await this.iterate(messages, toolDefs, maxIterations, sessionKey, streamCtx, (msg as InboundMessage & { signal?: AbortSignal }).signal, msg.chatId, reqCtx);

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

    // 6c. Track message count for periodic memory flush
    const flushInterval = this.deps.config.agent.memoryFlushInterval;
    const counter = this.messageCounters.get(sessionKey) ?? { count: 0, userId: msg.user?.userId, scope: msg.scope };
    counter.count++;
    counter.userId = msg.user?.userId;
    counter.scope = msg.scope;
    this.messageCounters.set(sessionKey, counter);

    if (this.deps.memory && counter.count >= flushInterval) {
      counter.count = 0;
      this.flushMemory(sessionKey, counter.userId, counter.scope).catch(err => {
        log.warn(`Periodic memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // 7. Maybe summarize (async, non-blocking)
    const fullSession = await this.deps.sessions.getOrCreate(sessionKey);
    const sessionTokenEstimate = estimateMessagesTokens(fullSession.messages);
    const tokenThreshold = this.deps.config.agent.tokenBudget * 0.75;
    if (fullSession.messages.length > this.deps.config.agent.summarizationThreshold
        || sessionTokenEstimate > tokenThreshold) {
      // Fire and forget — don't block response
      this.triggerSummarization(sessionKey, fullSession.messages, msg.user?.userId, msg.scope).catch(err => {
        log.warn(`Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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

    // Process as a regular message but with system session key
    const response = await this.processMessage(msg);

    // Suppress no-op responses from heartbeat/cron (avoid noisy messages to user)
    const isNoOp = /^(HEARTBEAT_OK|no.?op|nothing to do|all good)/i.test(response.content.trim());
    if (isNoOp) {
      log.debug(`Suppressing no-op system response: "${response.content.slice(0, 50)}"`);
      return;
    }

    if (!response.streamed && msg.chatId !== 'internal') {
      // Route cron/heartbeat responses to the correct user channel
      if (msg.chatId.startsWith('cron:') || msg.chatId.startsWith('heartbeat')) {
        const tgAllowlist = this.deps.config.telegram?.allowlist?.length
          ? this.deps.config.telegram.allowlist
          : deriveChannelAllowlist('telegram', this.deps.config);
        const tgEnabled = this.deps.config.telegram?.enabled || tgAllowlist.length > 0;

        // Per-user routing: find the user's Telegram chatId
        if (msg.user?.userId) {
          const userProfile = findUserProfile(msg.user.userId, this.deps.config);
          const tgIdentity = userProfile?.identities.find(
            i => i.channel === 'telegram' && i.channelUserId,
          );
          if (tgIdentity?.channelUserId) {
            response.channel = 'telegram';
            response.chatId = tgIdentity.channelUserId;
          } else {
            response.channel = tgEnabled ? 'telegram' : 'cli';
            response.chatId = tgAllowlist[0] ?? 'default';
          }
        } else {
          // Global task: existing behavior
          response.channel = tgEnabled ? 'telegram' : 'cli';
          response.chatId = tgAllowlist[0] ?? 'default';
        }
      }

      await this.deps.bus.publishOutbound(response, new AbortController().signal).catch(err => {
        log.warn(`Failed to publish system message response: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * LLM iteration loop — iterate until no tool_calls or max iterations.
   * Each tool call + result is saved to session for crash recovery.
   */
  private async iterate(
    messages: LLMMessage[],
    tools: ReturnType<ToolRegistry['list']>,
    maxIterations: number,
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

    for (let i = 0; i < maxIterations; i++) {
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

      let response;
      const thinkingConfig = this.deps.config.llm.thinking;
      const thinkingLevel = thinkingConfig?.level;
      const thinkingEnabled = thinkingLevel ? thinkingLevel !== 'off' : thinkingConfig?.enabled;
      const thinkingBudget = thinkingLevel ? (THINKING_LEVEL_BUDGETS[thinkingLevel] ?? 10000) : (thinkingConfig?.budgetTokens ?? 10000);
      const chatRequest = {
        model: this.deps.config.llm.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: i > 0 && this.deps.config.llm.toolTemperature != null
          ? this.deps.config.llm.toolTemperature
          : this.deps.config.llm.temperature,
        maxTokens: this.deps.config.llm.maxTokens,
        ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget } } : {}),
        ...(this.deps.config.llm.reasoningEffort ? { reasoningEffort: this.deps.config.llm.reasoningEffort as 'low' | 'medium' | 'high' } : {}),
      };

      try {
        const llmStart = Date.now();
        log.info(`[${sessionKey}] LLM call start (iteration ${i + 1}/${maxIterations})`);
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

      // Add assistant message with tool_calls to context
      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      };
      messages.push(assistantMsg);

      // Save assistant+tool_calls to session
      await this.deps.sessions.append(sessionKey, [assistantMsg]);

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

      // Append duplicate skip messages
      for (const msg of dupMessages) {
        messages.push(msg);
        await this.deps.sessions.append(sessionKey, [msg]);
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

        return { role: 'tool', tool_call_id: tc.id, content: truncateToolResult(rawResult) };
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
      if (toolResults.length > 0) {
        await this.deps.sessions.append(sessionKey, toolResults);
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

    log.warn(`Max iterations (${maxIterations}) reached`);
    const maxIterContent = lastContent || 'I reached the maximum number of iterations. Please continue with a follow-up message.';
    if (streamCtx) {
      this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'chunk', maxIterContent);
      this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'stream_end');
    }
    return {
      content: maxIterContent,
      iterations: maxIterations,
      toolCalls: totalToolCalls,
      totalTokens,
      outcome: 'max_iterations',
    };
  }

  /** Extract key facts from recent messages and append to daily notes. */
  private async flushMemory(sessionKey: string, userId?: string, scope?: InboundMessage['scope']): Promise<void> {
    if (!this.deps.memory) return;

    const session = await this.deps.sessions.getOrCreate(sessionKey);
    const flushInterval = this.deps.config.agent.memoryFlushInterval;
    const recentMessages = session.messages.slice(-flushInterval);
    if (recentMessages.length === 0) return;

    log.info(`[${sessionKey}] Memory flush: LLM call start`);
    const flushStart = Date.now();
    const flushResponse = await withTimeout(this.deps.llm.chat({
      model: this.deps.config.llm.model,
      messages: [
        { role: 'system', content: 'Extract important facts, decisions, and learnings from this conversation that should be remembered long-term. Output as bullet points. If nothing is worth remembering, respond with "NONE".' },
        { role: 'user', content: recentMessages.map(m => `${m.role}: ${'content' in m ? m.content : ''}`).join('\n') },
      ],
      temperature: 0.3,
      maxTokens: 512,
    }, 'flush'), 90_000, 'Memory flush LLM call timed out');
    log.info(`[${sessionKey}] Memory flush: LLM call done in ${Date.now() - flushStart}ms`);

    if (flushResponse.content.trim() !== 'NONE') {
      await this.deps.memory.appendDaily(`## Session notes\n${flushResponse.content}`, userId, scope);
      log.info('Memory flush: saved session notes');
    }
  }

  /** Flush memory for all sessions with unflushed messages. Call on shutdown. */
  async flushAllSessions(): Promise<void> {
    if (!this.deps.memory) return;

    const unflushed = [...this.messageCounters.entries()].filter(([, c]) => c.count > 0);
    if (unflushed.length === 0) return;

    log.info(`Flushing memory for ${unflushed.length} session(s)...`);

    const timeout = AbortSignal.timeout(10_000);
    const promises = unflushed.map(([sessionKey, counter]) =>
      this.flushMemory(sessionKey, counter.userId, counter.scope)
        .then(() => { counter.count = 0; }),
    );

    try {
      await Promise.race([
        Promise.allSettled(promises),
        new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('Flush timeout')))),
      ]);
    } catch {
      log.warn('Session-end flush timed out (10s)');
    }
  }

  private async triggerSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    userId?: string,
    scope?: InboundMessage['scope'],
  ): Promise<void> {
    log.info(`[${sessionKey}] Summarization: start`);
    const sumStart = Date.now();
    const halfIdx = Math.floor(messages.length / 2);
    const toSummarize = messages.slice(0, halfIdx);

    // Memory flush — extract key facts before discarding old messages
    try {
      await this.flushMemory(sessionKey, userId, scope);
    } catch (err) {
      log.warn(`Memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    log.info(`[${sessionKey}] Summarization: LLM call start`);
    const llmStart = Date.now();
    const summaryResponse = await withTimeout(this.deps.llm.chat({
      model: this.deps.config.llm.model,
      messages: [
        { role: 'system', content: 'Summarize this conversation concisely. Focus on: decisions made, key context, and current state. Be brief.' },
        { role: 'user', content: toSummarize.map(m => `${m.role}: ${'content' in m ? m.content : ''}`).join('\n') },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    }, 'summarize'), 90_000, 'Summarization LLM call timed out');
    log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);

    await this.deps.sessions.summarize(sessionKey, summaryResponse.content);
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
    if ('content' in m && m.content) total += estimateTokens(m.content);
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
    historyTokens -= estimateTokens('content' in removed && removed.content ? removed.content : '');

    // If we removed an assistant message, also remove following tool messages
    // to avoid orphan tool_call_id references
    while (trimmed.length > 0 && trimmed[0].role === 'tool') {
      const toolRemoved = trimmed.shift()!;
      historyTokens -= estimateTokens('content' in toolRemoved && toolRemoved.content ? toolRemoved.content : '');
    }
  }

  if (trimmed.length < history.length) {
    log.warn(`Trimmed ${history.length - trimmed.length} messages from history to fit token budget (est. ${fixedTokens + estimateMessagesTokens(trimmed)} / ${maxTokens})`);
  }

  return trimmed;
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
