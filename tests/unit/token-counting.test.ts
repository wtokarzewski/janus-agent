/**
 * Tests for token estimation and emergency compression in agent-loop.
 *
 * Since estimateTokens is a module-private function, we test it indirectly
 * via the agent loop's behavior.
 */

import { describe, it, expect, vi } from 'vitest';
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
      agent: { onLLMError: 'stop' },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({
      name: 'test',
      providerName: 'test',
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

  it.each(['background', 'pre-call'])('triggers %s summarization when the request exceeds its threshold', async mode => {
    // Use the complete summarizer template.
    const mockSummary = '## Goal\nUser is testing the diet tracking system with Janus. Currently logging meals on the dedicated diet channel.\n\n## Constraints & Preferences\n- Low carb approach with IF window 10:00-22:00\n- Target: 1743 kcal/day, protein 130g, fat 120g, carbs 50g, fiber 25g\n- Gym 3x/week (Mon/Wed/Fri) with cardio\n\n## Established Facts\n- Starting weight: 80.8 kg on 2026-04-20\n- Target weight: 75 kg by 2026-06-27\n- BMR: 1800 kcal, TDEE with exercise: 2290 kcal\n\n## Progress\n### Done\n- Completed week 1 of diet tracking\n### In Progress\nNone\n\n## Key Decisions\n- Decided on low carb approach based on past experience\n\n## Open TODOs\n- Track body measurements weekly\n\n## Critical Context\nDiet day 7. Cheat meal today (bread sandwich). BF trending down.\n\n## Identifiers\nNone';
    const mock = new MockProvider([
      { content: mode === 'pre-call' ? mockSummary : 'Response' },
      { content: mode === 'pre-call' ? 'Response' : mockSummary },
    ]);

    const config = createTestConfig({
      agent: {
        summarizationThreshold: 100, // high message count threshold
        // Leave real room for the response and the compacted system prompt.
        contextWindow: mode === 'pre-call' ? 10_000 : 20_000,
        context: { keepRecentTokens: 100 },
      },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', providerName: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir });
    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });

    // Four removable messages trigger pre-call or background compaction depending
    // on the budget. Both paths must save the summary and retain the short tail.
    const sessionKey = 'main:cli:token-sum-test';
    await sessions.append(sessionKey, [
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'y'.repeat(4000) },
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'y'.repeat(4000) },
      { role: 'user', content: 'retained tail' },
      { role: 'assistant', content: 'tail reply' },
    ]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      expect(await agent.processDirect('check summarization', { channel: 'cli', chatId: 'token-sum-test' })).toBe('Response');
      await vi.waitFor(async () => {
        const saved = (await sessions.getOrCreate(sessionKey)).metadata.summary!;
        for (const line of mockSummary.split('\n').filter(Boolean)) expect(saved).toContain(line);
        if (mode === 'pre-call') expect(saved).toContain('Current request (verbatim data): "check summarization"');
        else expect(saved).toBe(mockSummary);
      });
      expect(mock.calls).toHaveLength(2);
      expect(await sessions.getHistory(sessionKey)).toContainEqual({ role: 'user', content: 'retained tail' });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // Durable pre-compaction flush is covered in compaction-transaction.test.ts.
});
