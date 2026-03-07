import type { MessageBus } from '../bus/message-bus.js';
import type { InboundMessage, OutboundMessage } from '../bus/types.js';
import type { LLMMessage } from '../llm/types.js';
import type { ProviderRegistry } from '../llm/provider-registry.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { SessionManager } from '../session/session-manager.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import type { JanusConfig } from '../config/schema.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { GateService } from '../gates/types.js';
import { findUserProfile } from '../users/user-resolver.js';
import * as log from '../utils/logger.js';

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
  private _iterationController: AbortController | null = null;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  /** Set gate service for error recovery prompts (onToolError: 'ask'). */
  setGateService(service: GateService): void {
    this.deps.gateService = service;
  }

  /**
   * Stop the current iteration (if running) and cancel all subagents.
   * Returns true if something was actually cancelled.
   */
  stop(): { cancelled: boolean } {
    if (!this._iterationController) {
      return { cancelled: false };
    }
    this._iterationController.abort();
    this._iterationController = null;
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

    while (!signal.aborted) {
      let msg: InboundMessage | undefined;
      try {
        msg = await this.deps.bus.consumeInbound(signal);

        // Route system messages differently (cron, heartbeat, subagents)
        if (msg.channel === 'system') {
          await this.processSystemMessage(msg);
          continue;
        }

        this.deps.bus.markProcessing(msg.chatId);
        this._iterationController = new AbortController();
        let response;
        try {
          (msg as InboundMessage & { signal?: AbortSignal }).signal = this._iterationController.signal;
          response = await this.processMessage(msg);
        } finally {
          this._iterationController = null;
          this.deps.bus.clearProcessing(msg.chatId);
        }
        if (!response.streamed) {
          await this.deps.bus.publishOutbound(response, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        const errorText = err instanceof Error ? err.message : String(err);
        log.error(`Agent loop error: ${errorText}`);

        // Send error to user so they know something went wrong
        if (msg) {
          const errorResponse: OutboundMessage = {
            chatId: msg.chatId,
            channel: msg.channel,
            content: `Error: ${errorText}`,
            timestamp: new Date(),
          };
          await this.deps.bus.publishOutbound(errorResponse, signal).catch(() => {});
        }
      }
    }

    log.info('Agent loop stopped');
  }

  private async processMessage(msg: InboundMessage): Promise<OutboundMessage & { streamed?: boolean }> {
    const sessionKey = `${msg.channel}:${msg.chatId}`;

    // 1. Resolve user profile (if multi-user)
    const userProfile = msg.user?.userId
      ? findUserProfile(msg.user.userId, this.deps.config)
      : undefined;

    // 2. Update tool contexts
    this.deps.tools.setContext({
      workspaceDir: this.deps.config.workspace.dir,
      execDenyPatterns: [...this.deps.config.tools.execDenyPatterns, ...(this.deps.config.tools.execDenyPatternsExtra ?? [])],
      execTimeout: this.deps.config.tools.execTimeout,
      maxFileSize: this.deps.config.tools.maxFileSize,
      chatId: msg.chatId,
      userId: msg.user?.userId,
      userToolAllow: userProfile?.tools?.allow,
      userToolDeny: userProfile?.tools?.deny,
      toolPolicy: userProfile?.tools?.policy,
      cronDepth: msg.cronDepth,
    });

    // 3. Get session + build system prompt
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
    const cleanHistory = stripOrphanToolMessages(history);
    const maxTokens = this.deps.config.agent.tokenBudget;
    const trimmedHistory = trimHistoryToTokenBudget(cleanHistory, systemPrompt, msg.content, maxTokens);
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimmedHistory,
      { role: 'user', content: msg.content },
    ];

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
    const iterResult = await this.iterate(messages, toolDefs, maxIterations, sessionKey, streamCtx, (msg as InboundMessage & { signal?: AbortSignal }).signal, msg.chatId);

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
      // Route cron/heartbeat responses to the last known user channel
      if (msg.chatId.startsWith('cron:') || msg.chatId === 'heartbeat') {
        const targetChannel = this.deps.config.telegram?.enabled ? 'telegram' : 'cli';
        const targetChatId = this.deps.config.telegram?.allowlist?.[0] ?? 'default';
        response.channel = targetChannel;
        response.chatId = targetChatId;
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
  ): Promise<IterateResult> {
    let lastContent = '';
    let totalToolCalls = 0;
    let totalTokens = 0;
    let contextRetries = 0;
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

        log.error(`LLM error: ${errorText}`);
        if (this.deps.config.agent.onLLMError === 'retry') {
          log.info('LLM error recovery: retrying iteration...');
          await sleep(1000);
          continue;
        }
        const errorContent = lastContent || `LLM error: ${errorText}`;
        if (streamCtx) {
          this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'chunk', errorContent);
          this.deps.bus.streamTo(streamCtx.channel, streamCtx.chatId, 'stream_end');
        }
        return { content: errorContent, iterations: i + 1, toolCalls: totalToolCalls, totalTokens, outcome: 'error' };
      }

      lastContent = response.content;
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
        return { content: response.content, iterations: i + 1, toolCalls: totalToolCalls, totalTokens, outcome: 'success' };
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
        let rawResult = await this.deps.tools.execute(tc.function.name, args);

        for (let attempt = 1; attempt < maxRetries && rawResult.startsWith('Error:'); attempt++) {
          log.warn(`Tool "${tc.function.name}" failed (attempt ${attempt}/${maxRetries}), retrying...`);
          await sleep(500 * attempt);
          rawResult = await this.deps.tools.execute(tc.function.name, args);
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

    const flushResponse = await this.deps.llm.chat({
      model: this.deps.config.llm.model,
      messages: [
        { role: 'system', content: 'Extract important facts, decisions, and learnings from this conversation that should be remembered long-term. Output as bullet points. If nothing is worth remembering, respond with "NONE".' },
        { role: 'user', content: recentMessages.map(m => `${m.role}: ${'content' in m ? m.content : ''}`).join('\n') },
      ],
      temperature: 0.3,
      maxTokens: 512,
    }, 'flush');

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
    const halfIdx = Math.floor(messages.length / 2);
    const toSummarize = messages.slice(0, halfIdx);

    // Memory flush — extract key facts before discarding old messages
    try {
      await this.flushMemory(sessionKey, userId, scope);
    } catch (err) {
      log.warn(`Memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const summaryResponse = await this.deps.llm.chat({
      model: this.deps.config.llm.model,
      messages: [
        { role: 'system', content: 'Summarize this conversation concisely. Focus on: decisions made, key context, and current state. Be brief.' },
        { role: 'user', content: toSummarize.map(m => `${m.role}: ${'content' in m ? m.content : ''}`).join('\n') },
      ],
      temperature: 0.3,
      maxTokens: 1024,
    }, 'summarize');

    await this.deps.sessions.summarize(sessionKey, summaryResponse.content);
    log.info(`Session ${sessionKey} summarized`);
  }
}

/**
 * Strip orphan tool messages from the beginning of history.
 *
 * If session was saved mid-iteration (crash), history may start with
 * role="tool" messages that have no matching assistant+tool_calls.
 * The LLM will error on these. Strip them.
 */
function stripOrphanToolMessages(history: LLMMessage[]): LLMMessage[] {
  let startIdx = 0;
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === 'tool') {
      startIdx = i + 1;
    } else {
      break;
    }
  }
  if (startIdx > 0) {
    log.warn(`Stripped ${startIdx} orphan tool message(s) from session history`);
    return history.slice(startIdx);
  }
  return history;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const s = JSON.stringify(v);
      return `${k}=${s.length > 60 ? s.slice(0, 57) + '...' : s}`;
    })
    .join(', ');
}
