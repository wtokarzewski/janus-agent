import { describe, it, expect } from 'vitest';
import { enforceContextBudget, type ContextBudgetConfig } from '../../src/agent/context-budget.js';
import type { LLMMessage } from '../../src/llm/types.js';

function makeConfig(overrides: Partial<ContextBudgetConfig> = {}): ContextBudgetConfig {
  return {
    tokenBudget: 1000,
    context: {
      softTrimChars: 100,
      compactionThresholds: [0.75, 0.80, 0.85] as [number, number, number],
      emergencyThreshold: 0.95,
      protectedTailTurns: 3,
    },
    ...overrides,
  };
}

/** Create a string of exactly N characters (all 'x'). */
function chars(n: number): string {
  return 'x'.repeat(n);
}

describe('enforceContextBudget', () => {
  it('does nothing when under 75% budget', () => {
    const config = makeConfig({ tokenBudget: 10_000 });
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ];
    const snapshot = JSON.stringify(messages);
    enforceContextBudget(messages, config);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('Phase 1: soft-trims old tool results', () => {
    // Budget = 1000 tokens → 75% = 750.
    // System (short) + user (short) + tool (big enough to push over 75%).
    const bigContent = chars(2000); // ~800 tokens, exceeds 750
    const config = makeConfig({ tokenBudget: 1000 });
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a' },
      { role: 'tool', tool_call_id: 't1', content: bigContent },
      // Recent tail (3 assistant turns = protected)
      { role: 'assistant', content: 'r1' },
      { role: 'assistant', content: 'r2' },
      { role: 'assistant', content: 'r3' },
    ];

    enforceContextBudget(messages, config);

    const toolMsg = messages.find(m => m.role === 'tool')!;
    expect(typeof toolMsg.content).toBe('string');
    const content = toolMsg.content as string;
    expect(content).toContain('[trimmed]');
    // Trimmed content should be much shorter than the original
    expect(content.length).toBeLessThan(bigContent.length);
    // Head + tail each ~37.5% of softTrimChars (100) = 37 chars + marker
    expect(content.length).toBeLessThanOrEqual(100 + 20); // trimmed marker overhead
  });

  it('never modifies user messages', () => {
    // Big user message that pushes well over budget — must remain intact.
    const bigUser = chars(5000); // ~2000 tokens, way over budget
    const config = makeConfig({ tokenBudget: 1000 });
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: bigUser },
      { role: 'assistant', content: 'a' },
    ];

    enforceContextBudget(messages, config);

    const userMsg = messages.find(m => m.role === 'user')!;
    expect(userMsg.content).toBe(bigUser);
  });

  it('protected tail: does not trim recent assistant turns within protectedTailTurns', () => {
    // 3 protected tail turns. The tool result in the tail should not be touched.
    const bigTailTool = chars(2000);
    const config = makeConfig({ tokenBudget: 1000 });
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      // Old zone
      { role: 'assistant', content: 'old' },
      { role: 'tool', tool_call_id: 't-old', content: chars(500) },
      // Protected tail (3 assistant turns)
      { role: 'assistant', content: 'recent1' },
      { role: 'tool', tool_call_id: 't-recent', content: bigTailTool },
      { role: 'assistant', content: 'recent2' },
      { role: 'assistant', content: 'recent3' },
    ];

    enforceContextBudget(messages, config);

    // The tool result in the protected tail should be untouched
    const recentTool = messages.find(m => m.role === 'tool' && (m as any).tool_call_id === 't-recent')!;
    expect(recentTool.content).toBe(bigTailTool);
  });

  it('Phase 3: drops old assistant+tool turns as groups, preserves ALL user messages', () => {
    // Create enough content to stay above 85% even after phase 1+2.
    // We need total tokens > 85% of budget.
    const config = makeConfig({ tokenBudget: 200, context: {
      softTrimChars: 100,
      compactionThresholds: [0.10, 0.15, 0.20] as [number, number, number], // very low → jump straight to phase 3
      emergencyThreshold: 0.95,
      protectedTailTurns: 0, // no protection, simplify test
    }});
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: chars(200) }, // ~80 tokens
      { role: 'tool', tool_call_id: 't1', content: chars(200) }, // ~80 tokens
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: chars(200) }, // ~80 tokens
      { role: 'tool', tool_call_id: 't2', content: chars(200) }, // ~80 tokens
      { role: 'user', content: 'third question' },
    ];

    enforceContextBudget(messages, config);

    // All user messages must survive
    const userMessages = messages.filter(m => m.role === 'user');
    expect(userMessages.length).toBe(3);
    expect(userMessages[0].content).toBe('first question');
    expect(userMessages[1].content).toBe('second question');
    expect(userMessages[2].content).toBe('third question');

    // At least one assistant+tool group should have been dropped
    const totalNonSystem = messages.filter(m => m.role !== 'system').length;
    expect(totalNonSystem).toBeLessThan(7); // originally 7 non-system messages
  });

  it('never splits assistant from its tool results', () => {
    const config = makeConfig({ tokenBudget: 200, context: {
      softTrimChars: 100,
      compactionThresholds: [0.10, 0.15, 0.20] as [number, number, number],
      emergencyThreshold: 0.95,
      protectedTailTurns: 0,
    }});
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: chars(200), tool_calls: [{ id: 't1', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: chars(200) },
      { role: 'tool', tool_call_id: 't2', content: chars(200) },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'final' },
    ];

    enforceContextBudget(messages, config);

    // After enforcement, verify no orphan tool messages exist.
    // A tool message at index i should always be preceded by an assistant or another tool at i-1.
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'tool') {
        const prev = messages[i - 1];
        expect(prev).toBeDefined();
        expect(['assistant', 'tool']).toContain(prev.role);
      }
    }
  });

  it('emergency mode: no protected tail, trims everything except user messages', () => {
    // In emergency mode, even the most recent tool results get trimmed.
    const bigRecent = chars(2000);
    const config = makeConfig({ tokenBudget: 1000 });
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      // Recent tail — normally protected
      { role: 'assistant', content: 'recent1' },
      { role: 'tool', tool_call_id: 't1', content: bigRecent },
      { role: 'assistant', content: 'recent2' },
      { role: 'assistant', content: 'recent3' },
    ];

    enforceContextBudget(messages, config, true);

    // User message must survive
    const userMsg = messages.find(m => m.role === 'user')!;
    expect(userMsg.content).toBe('hi');

    // The tool result should have been trimmed (not protected in emergency)
    const toolMsg = messages.find(m => m.role === 'tool');
    if (toolMsg) {
      const content = typeof toolMsg.content === 'string' ? toolMsg.content : '';
      expect(content.length).toBeLessThan(bigRecent.length);
    }
    // OR the entire assistant+tool group may have been dropped — either way, budget decreased
  });
});
