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
import { findUserProfile } from '../users/user-resolver.js';
import * as log from '../utils/logger.js';

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

  constructor(deps: AgentDeps) {
    this.deps = deps;
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
  }): Promise<string> {
    const msg: InboundMessage = {
      id: `direct-${Date.now()}`,
      channel: opts?.channel ?? 'cli',
      chatId: opts?.chatId ?? 'direct',
      content,
      author: 'user',
      timestamp: new Date(),
      contextMode: opts?.contextMode,
      user: opts?.user,
      scope: opts?.scope,
    };

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

        const response = await this.processMessage(msg);
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
      execDenyPatterns: this.deps.config.tools.execDenyPatterns,
      execTimeout: this.deps.config.tools.execTimeout,
      maxFileSize: this.deps.config.tools.maxFileSize,
      chatId: msg.chatId,
      userId: msg.user?.userId,
      userToolAllow: userProfile?.tools?.allow,
      userToolDeny: userProfile?.tools?.deny,
      toolPolicy: userProfile?.tools?.policy,
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
    const iterResult = await this.iterate(messages, toolDefs, maxIterations, sessionKey, streamCtx);

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
  ): Promise<IterateResult> {
    let lastContent = '';
    let totalToolCalls = 0;
    let totalTokens = 0;
    let contextRetries = 0;

    for (let i = 0; i < maxIterations; i++) {
      let response;
      const chatRequest = {
        model: this.deps.config.llm.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        temperature: this.deps.config.llm.temperature,
        maxTokens: this.deps.config.llm.maxTokens,
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
        return { content: lastContent || `LLM error: ${errorText}`, iterations: i + 1, toolCalls: totalToolCalls, totalTokens, outcome: 'error' };
      }

      lastContent = response.content;
      totalTokens += response.usage.totalTokens;

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

      // Execute each tool call (with retry on error)
      for (const tc of response.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = {};
        }

        log.info(`Tool: ${tc.function.name}(${summarizeArgs(args)})`);
        totalToolCalls++;
        const maxRetries = this.deps.config.agent.toolRetries;
        let rawResult = await this.deps.tools.execute(tc.function.name, args);

        for (let attempt = 1; attempt < maxRetries && rawResult.startsWith('Error:'); attempt++) {
          log.warn(`Tool "${tc.function.name}" failed (attempt ${attempt}/${maxRetries}), retrying...`);
          await sleep(500 * attempt);
          rawResult = await this.deps.tools.execute(tc.function.name, args);
        }

        const result = truncateToolResult(rawResult);

        const toolMsg: LLMMessage = {
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        };
        messages.push(toolMsg);

        // Save tool result to session immediately
        await this.deps.sessions.append(sessionKey, [toolMsg]);
      }
    }

    log.warn(`Max iterations (${maxIterations}) reached`);
    return {
      content: lastContent || 'I reached the maximum number of iterations. Please continue with a follow-up message.',
      iterations: maxIterations,
      toolCalls: totalToolCalls,
      totalTokens,
      outcome: 'max_iterations',
    };
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
    if (this.deps.memory) {
      try {
        const flushResponse = await this.deps.llm.chat({
          model: this.deps.config.llm.model,
          messages: [
            { role: 'system', content: 'Extract important facts, decisions, and learnings from this conversation that should be remembered long-term. Output as bullet points. If nothing is worth remembering, respond with "NONE".' },
            { role: 'user', content: toSummarize.map(m => `${m.role}: ${'content' in m ? m.content : ''}`).join('\n') },
          ],
          temperature: 0.3,
          maxTokens: 512,
        }, 'flush');

        if (flushResponse.content.trim() !== 'NONE') {
          await this.deps.memory.appendDaily(`## Session notes\n${flushResponse.content}`, userId, scope);
          log.info('Memory flush: saved notes before summarization');
        }
      } catch (err) {
        log.warn(`Memory flush failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
