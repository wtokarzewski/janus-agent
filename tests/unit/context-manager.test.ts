import { describe, it, expect } from 'vitest';
import {
  resolveBudget,
  estimatePromptTokens,
  routeCall,
  softTrimOldToolResults,
  hardClearOldToolResults,
  estimateReducibleToolTokens,
  DEFAULT_TRANSFORM_SETTINGS,
  RESERVED_OUTPUT_TOKENS_DEFAULT,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
} from '../../src/context/context-manager.js';
import type { LLMMessage } from '../../src/llm/types.js';

const userMsg = (content: string): LLMMessage => ({ role: 'user', content });
const assistantMsg = (content: string): LLMMessage => ({ role: 'assistant', content });
const toolMsg = (id: string, content: string): LLMMessage => ({ role: 'tool', tool_call_id: id, content });

describe('resolveBudget', () => {
  it('uses configOverride when provided (highest priority)', () => {
    const b = resolveBudget({ modelContextWindow: 200_000, configOverride: 150_000 });
    expect(b.contextWindow).toBe(150_000);
    expect(b.source).toBe('config');
    expect(b.effective).toBe(150_000 - RESERVED_OUTPUT_TOKENS_DEFAULT);
  });

  it('uses modelContextWindow when no override', () => {
    const b = resolveBudget({ modelContextWindow: 200_000 });
    expect(b.contextWindow).toBe(200_000);
    expect(b.source).toBe('model');
    expect(b.effective).toBe(200_000 - RESERVED_OUTPUT_TOKENS_DEFAULT);
  });

  it('falls back to default 200k when neither provided', () => {
    const b = resolveBudget({});
    expect(b.contextWindow).toBe(200_000);
    expect(b.source).toBe('default');
  });

  it('clamps effective to hard min', () => {
    const b = resolveBudget({ configOverride: 1_000 });
    expect(b.effective).toBe(CONTEXT_WINDOW_HARD_MIN_TOKENS);
  });

  it('respects custom reservedForOutput', () => {
    const b = resolveBudget({ modelContextWindow: 200_000, reservedForOutput: 16_000 });
    expect(b.effective).toBe(184_000);
  });
});

describe('estimatePromptTokens', () => {
  it('estimates from string content', () => {
    const msgs: LLMMessage[] = [userMsg('hello world')];
    const tokens = estimatePromptTokens(msgs, 'system');
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles empty messages', () => {
    expect(estimatePromptTokens([], '')).toBe(0);
  });
});

describe('softTrimOldToolResults', () => {
  const big = 'x'.repeat(20_000);

  it('does not trim within protected tail', () => {
    const msgs: LLMMessage[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      toolMsg('t1', big), // before tail
      assistantMsg('a2'),
      toolMsg('t2', big), // inside tail (a2, a3, a4 are last 3 assistants)
      assistantMsg('a3'),
      toolMsg('t3', big),
      assistantMsg('a4'),
    ];
    const out = softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect((out[2].content as string).length).toBeLessThan(big.length);
    expect(out[4].content).toBe(big);
    expect(out[6].content).toBe(big);
  });

  it('returns input unchanged when no trims needed', () => {
    const msgs: LLMMessage[] = [userMsg('hi'), assistantMsg('ok')];
    expect(softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS)).toBe(msgs);
  });

  it('does not mutate input', () => {
    const msgs: LLMMessage[] = [
      userMsg('q'), assistantMsg('a'), toolMsg('t', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const before = JSON.stringify(msgs);
    softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('does not trim tool results under maxChars threshold', () => {
    const small = 'short result';
    const msgs: LLMMessage[] = [
      userMsg('q'), assistantMsg('a'), toolMsg('t', small),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const out = softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).toBe(small);
  });

  it('preserves head+tail with marker for trimmed content', () => {
    const content = 'HEAD'.repeat(2_000) + 'MIDDLE' + 'TAIL'.repeat(2_000);
    const msgs: LLMMessage[] = [
      userMsg('q'), assistantMsg('a'), toolMsg('t', content),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const out = softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    const trimmed = out[2].content as string;
    expect(trimmed.startsWith('HEAD')).toBe(true);
    expect(trimmed.endsWith('TAIL')).toBe(true);
    expect(trimmed).toContain('[trimmed:');
  });
});

describe('hardClearOldToolResults', () => {
  it('replaces old tool results with placeholder', () => {
    const big = 'x'.repeat(60_000);
    const msgs: LLMMessage[] = [
      userMsg('q'), assistantMsg('a'), toolMsg('t', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const out = hardClearOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).toBe(DEFAULT_TRANSFORM_SETTINGS.hardClear.placeholder);
  });

  it('does not clear within protected tail', () => {
    const big = 'x'.repeat(60_000);
    const msgs: LLMMessage[] = [
      userMsg('q'),
      assistantMsg('a'),
      toolMsg('t', big), // inside tail (only 1 prior assistant means tail starts at a1)
      assistantMsg('b'),
      assistantMsg('c'),
    ];
    const out = hardClearOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).toBe(big);
  });

  it('respects disabled flag', () => {
    const big = 'x'.repeat(60_000);
    const msgs: LLMMessage[] = [
      userMsg('q'), assistantMsg('a'), toolMsg('t', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const out = hardClearOldToolResults(msgs, {
      ...DEFAULT_TRANSFORM_SETTINGS,
      hardClear: { enabled: false, placeholder: 'x' },
    });
    expect(out).toBe(msgs);
  });
});

describe('estimateReducibleToolTokens', () => {
  it('returns 0 when no old tool results', () => {
    const msgs: LLMMessage[] = [userMsg('q'), assistantMsg('a')];
    expect(estimateReducibleToolTokens(msgs, DEFAULT_TRANSFORM_SETTINGS)).toBe(0);
  });

  it('estimates reducible chars from old tool results', () => {
    const big = 'x'.repeat(20_000);
    const msgs: LLMMessage[] = [
      userMsg('q'), assistantMsg('a'), toolMsg('t', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const tokens = estimateReducibleToolTokens(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('routeCall', () => {
  const budget = { contextWindow: 200_000, reservedForOutput: 8_000, effective: 192_000, source: 'config' as const };

  it('returns fits when under budget', () => {
    const msgs: LLMMessage[] = [userMsg('hi')];
    const res = routeCall({ messages: msgs, systemPrompt: 'small', budget });
    expect(res.route.type).toBe('fits');
    expect(res.overflowTokens).toBe(0);
  });

  it('returns truncate_only when overflow recoverable by trimming old tool results', () => {
    const big = 'x'.repeat(700_000); // ~280k tokens
    const msgs: LLMMessage[] = [
      userMsg('hi'), assistantMsg('a'), toolMsg('t1', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const res = routeCall({ messages: msgs, systemPrompt: 'sp', budget });
    expect(res.route.type).toBe('truncate_only');
    expect(res.reducibleTokens).toBeGreaterThan(res.overflowTokens);
  });

  it('returns compact_only when nothing to truncate but overflowing', () => {
    const bigSystem = 'x'.repeat(700_000);
    const msgs: LLMMessage[] = [userMsg('hi')]; // no tool results
    const res = routeCall({ messages: msgs, systemPrompt: bigSystem, budget });
    expect(res.route.type).toBe('compact_only');
    expect(res.reducibleTokens).toBe(0);
  });

  it('returns compact_then_truncate when truncating alone wont fit', () => {
    const userBig = 'u'.repeat(600_000); // huge user content drives overflow; tail-tool helps but not enough
    const tailTool = 'x'.repeat(30_000); // some reducible but small
    const msgs: LLMMessage[] = [
      userMsg(userBig), assistantMsg('a'), toolMsg('t1', tailTool),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const res = routeCall({ messages: msgs, systemPrompt: 'sp', budget });
    expect(res.route.type).toBe('compact_then_truncate');
  });
});
