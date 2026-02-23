/**
 * Tests for token estimation and emergency compression in agent-loop.
 *
 * Since estimateTokens is a module-private function, we test it indirectly
 * via the agent loop's behavior.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { SkillLoader } from '../../src/skills/skill-loader.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { SkillLearner } from '../../src/learner/learner.js';
import { MockProvider } from '../helpers/mock-llm.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import type { LearnerStorage, ExecutionRecord } from '../../src/learner/types.js';

class InMemoryLearnerStorage implements LearnerStorage {
  records: ExecutionRecord[] = [];
  async append(record: ExecutionRecord): Promise<void> { this.records.push(record); }
  async getAll(): Promise<ExecutionRecord[]> { return [...this.records]; }
  async getRecent(limit: number): Promise<ExecutionRecord[]> { return this.records.slice(-limit); }
}

describe('Token counting and emergency compression', () => {
  it('should handle context overflow by compressing messages', async () => {
    // Create a provider that fails once with a context error, then succeeds
    let callCount = 0;
    const failThenSucceed: MockProvider = {
      calls: [],
      streamCalls: [],
      async chat() {
        callCount++;
        if (callCount === 1) {
          throw new Error('maximum context length exceeded - token limit');
        }
        return {
          content: 'Recovered after compression',
          toolCalls: [],
          usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
          finishReason: 'stop',
        };
      },
    } as any;

    const config = createTestConfig({
      agent: { maxIterations: 5, onLLMError: 'stop' },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({
      name: 'test',
      provider: failThenSucceed,
      model: 'test',
      purpose: [],
      priority: 0,
    });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir });
    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });

    // Pre-populate session with many messages to give compression something to work with
    const sessionKey = 'cli:overflow-test';
    const historyMessages = [];
    for (let i = 0; i < 10; i++) {
      historyMessages.push({ role: 'user' as const, content: `Message ${i}: ${'x'.repeat(500)}` });
      historyMessages.push({ role: 'assistant' as const, content: `Response ${i}: ${'y'.repeat(500)}` });
    }
    await sessions.append(sessionKey, historyMessages);

    const result = await agent.processDirect('trigger overflow', { channel: 'cli', chatId: 'overflow-test' });

    // Should have recovered via emergency compression
    expect(result).toBe('Recovered after compression');
    // callCount >= 2: first call failed with context error, then at least one successful retry
    // (may be higher due to summarization triggered after recovery)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('should trigger summarization when token estimate exceeds threshold', async () => {
    const mock = new MockProvider([
      { content: 'Response' },
      { content: 'Summary of conversation' }, // summarization call
    ]);

    const config = createTestConfig({
      agent: {
        maxIterations: 5,
        summarizationThreshold: 100, // high message count threshold
        tokenBudget: 500, // very low token budget to trigger token-based summarization
      },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir });
    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });

    // Pre-fill session with enough content to exceed 500 * 0.75 = 375 token estimate
    const sessionKey = 'cli:token-sum-test';
    await sessions.append(sessionKey, [
      { role: 'user', content: 'x'.repeat(1000) },
      { role: 'assistant', content: 'y'.repeat(1000) },
    ]);

    await agent.processDirect('check summarization', { channel: 'cli', chatId: 'token-sum-test' });

    // Wait for fire-and-forget summarization
    await new Promise(r => setTimeout(r, 100));

    // The mock provider should have received 2 calls: main + summarization
    expect(mock.calls.length).toBe(2);
  });

  it('should flush memory before summarization when MemoryStore is available', async () => {
    const mock = new MockProvider([
      { content: 'Response' },
      { content: '- Decision: use SQLite for storage\n- Key fact: API limit is 100 req/s' }, // flush call
      { content: 'Summary of conversation' }, // summarization call
    ]);

    const config = createTestConfig({
      agent: {
        maxIterations: 5,
        summarizationThreshold: 100,
        tokenBudget: 500, // low budget to trigger summarization
      },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir });
    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    // Pass memory to AgentDeps
    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner, memory });

    // Pre-fill session to trigger summarization
    const sessionKey = 'cli:flush-test';
    await sessions.append(sessionKey, [
      { role: 'user', content: 'x'.repeat(1000) },
      { role: 'assistant', content: 'y'.repeat(1000) },
    ]);

    await agent.processDirect('check flush', { channel: 'cli', chatId: 'flush-test' });

    // Wait for fire-and-forget summarization + flush
    await new Promise(r => setTimeout(r, 200));

    // 3 calls: main response + flush + summarization
    expect(mock.calls.length).toBe(3);
    // Flush call should have the extraction prompt
    expect(mock.calls[1].messages[0].content).toContain('Extract important facts');

    // Verify daily note was written
    const daily = await memory.readDaily();
    expect(daily).toContain('Session notes');
    expect(daily).toContain('Decision: use SQLite');
  });
});
