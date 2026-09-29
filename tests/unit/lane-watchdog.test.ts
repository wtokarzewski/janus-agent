/**
 * Lane watchdog — a run that never settles must not leak its concurrency slot.
 * Regression test for the wedged cron/heartbeat lanes: once every slot was
 * held by a hung run, the lane silently stopped consuming its queue.
 */

import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, type AgentDeps } from '../../src/agent/agent-loop.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { SkillLoader } from '../../src/skills/skill-loader.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import type { LLMProvider, ChatRequest, ChatResponse, StreamCallback } from '../../src/llm/types.js';
import type { OutboundMessage } from '../../src/bus/types.js';

/** First call hangs forever; subsequent calls answer immediately. */
class HangThenAnswerProvider implements LLMProvider {
  private callCount = 0;
  firstRequest?: ChatRequest;

  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.callCount++;
    this.firstRequest ??= _request;
    if (this.callCount === 1) {
      return new Promise<ChatResponse>(() => {}); // never settles
    }
    return {
      content: 'ok',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    };
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    const response = await this.chat(request);
    onChunk(response.content);
    return response;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

describe('lane watchdog', () => {
  it('propagates shutdown to a running request without waiting for the watchdog', async () => {
    const config = createTestConfig({ agent: { laneTimeoutMs: 60_000 } });
    const bus = new MessageBus();
    const provider = new HangThenAnswerProvider();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', providerName: 'mock', provider, model: 'test', priority: 0, purpose: [] });
    const sessions = new SessionManager(config);
    const skills = new SkillLoader(config);
    const memory = new MemoryStore(config);
    const context = new ContextBuilder({ config, skills, memory });
    const agent = new AgentLoop({ config, bus, sessions, skills, context, tools: new ToolRegistry(), llm: registry });
    const ctrl = new AbortController();
    const running = agent.run(ctrl.signal);
    await bus.publishInbound({ id: 'shutdown', channel: 'cli', chatId: 'shutdown', content: 'work', author: 'test', timestamp: new Date() });
    await vi.waitFor(() => expect(provider.firstRequest).toBeDefined());
    ctrl.abort();
    await running;
    expect(provider.firstRequest?.signal?.aborted).toBe(true);
  });

  it.each(['cli', 'system'])('cancels %s runs and releases the leaked slot once', async channel => {
    const config = createTestConfig({
      agent: {
        summarizationThreshold: 100,
        laneTimeoutMs: 300,
        lanes: { user: 1, cron: 1, heartbeat: 1 },
      },
    });

    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    const provider = new HangThenAnswerProvider();
    registry.register({
      name: 'mock',
      providerName: 'mock',
      provider,
      model: 'test-model',
      purpose: [],
      priority: 0,
    });

    const tools = new ToolRegistry();
    tools.setContext({
      workspaceDir: config.workspace.dir,
      execDenyPatterns: [],
      execTimeout: 5000,
      maxFileSize: 1_000_000,
    });

    const memory = new MemoryStore(config);
    const sessions = new SessionManager(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });

    const deps: AgentDeps = { bus, llm: registry, tools, sessions, context, skills, config };
    const loop = new AgentLoop(deps);

    const ctrl = new AbortController();
    const running = loop.run(ctrl.signal);

    // First message hangs inside the LLM call and holds the only user-lane slot
    await bus.publishInbound({
      id: 'msg-hang',
      channel,
      chatId: 'chat-a',
      content: 'this one hangs',
      author: 'test',
      timestamp: new Date(),
    });

    // Second message must still be processed once the watchdog frees the slot
    await bus.publishInbound({
      id: 'msg-ok',
      channel,
      chatId: 'chat-b',
      content: 'hello',
      author: 'test',
      timestamp: new Date(),
    });

    let out: OutboundMessage;
    try {
      out = await withTimeout(bus.consumeOutbound(), 5_000, 'second message never processed — lane wedged');
    } finally {
      ctrl.abort();
    }
    expect(out.chatId).toBe('chat-b');
    expect(provider.firstRequest?.signal?.aborted).toBe(true);

    await running.catch(() => {});
  });
});
