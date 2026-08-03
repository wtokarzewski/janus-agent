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

  it('should trigger summarization when token estimate exceeds threshold', async () => {
    // Summary must be >500 chars (~200 tokens) to avoid triggering fallback chain retry
    const mockSummary = '## Goal\nUser is testing the diet tracking system with Janus. Currently logging meals on the dedicated diet channel.\n\n## Constraints & Preferences\n- Low carb approach with IF window 10:00-22:00\n- Target: 1743 kcal/day, protein 130g, fat 120g, carbs 50g, fiber 25g\n- Gym 3x/week (Mon/Wed/Fri) with cardio\n\n## Established Facts\n- Starting weight: 80.8 kg on 2026-04-20\n- Target weight: 75 kg by 2026-06-27\n- BMR: 1800 kcal, TDEE with exercise: 2290 kcal\n\n## Progress\n### Done\n- Completed week 1 of diet tracking\n\n## Key Decisions\n- Decided on low carb approach based on past experience\n\n## Open TODOs\n- Track body measurements weekly\n\n## Critical Context\nDiet day 7. Cheat meal today (bread sandwich). BF trending down.\n\n## Identifiers\nNone';
    const mock = new MockProvider([
      { content: 'Response' },
      { content: mockSummary }, // summarization call
    ]);

    const config = createTestConfig({
      agent: {
        summarizationThreshold: 100, // high message count threshold
        contextWindow: 5_000, // small context window → threshold = 5000 * 0.5 = 2500 tokens
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

    // Pre-fill session with enough content to exceed contextWindow * 0.5 token threshold.
    // contextWindow=5000 → effective=max(4000, 5000-8000)=4000 → threshold=2000 tokens.
    // 20000 chars / 2.5 = 8000 tokens → triggers.
    const sessionKey = 'cli:token-sum-test';
    await sessions.append(sessionKey, [
      { role: 'user', content: 'x'.repeat(10_000) },
      { role: 'assistant', content: 'y'.repeat(10_000) },
    ]);

    await agent.processDirect('check summarization', { channel: 'cli', chatId: 'token-sum-test' });

    // Wait for fire-and-forget summarization
    await new Promise(r => setTimeout(r, 100));

    // The mock provider should have received 2 calls: main + summarization
    expect(mock.calls.length).toBe(2);
  });

  // Removed: 'should flush memory before summarization when MemoryStore is available'.
  // Pre-compaction flush (inside doSummarization) was removed. Compaction and
  // memory flush are now independent paths — flush has its own count-based
  // trigger (>=20 unflushed messages) plus a shutdown trigger; it does NOT
  // run synchronously inside summarization. See spec at
  // docs/superpowers/specs/2026-05-16-context-management-redesign.md.
});
