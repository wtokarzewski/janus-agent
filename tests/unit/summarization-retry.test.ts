import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Summarization quality validation', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should not contain old scheduling quality retry heuristic', () => {
    expect(source).not.toContain('hasScheduling');
    expect(source).not.toContain('hasCriticalContext');
  });

  it('should use proportional quality check', () => {
    expect(source).toContain('isTooShort');
    expect(source).toContain('inputTokens * 0.1');
  });

  it('should have fallback chain: retry with temp=0, then aggressive prompt', () => {
    expect(source).toContain('temperature: 0,');
    expect(source).toContain('summarization/aggressive');
  });
});

describe('Aggressive summarization prompt', () => {
  it('should exist as a prompt file', () => {
    const prompt = readFileSync('src/prompts/summarization/aggressive.md', 'utf-8');
    expect(prompt).toContain('fact-focused');
    expect(prompt.length).toBeGreaterThan(100);
  });
});
