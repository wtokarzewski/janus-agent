import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Summarization implementation', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should not have quality retry chain (removed as over-engineering)', () => {
    expect(source).not.toContain('summarize-retry');
    expect(source).not.toContain('summarize-aggressive');
    expect(source).not.toContain('summarization/aggressive');
    expect(source).not.toContain('isTooShort');
  });

  // Short-summary preservation is covered by summary-validation.test.ts.

  it('should include tool results in summarization input', () => {
    expect(source).toContain('TOOL_RESULT_MAX');
    expect(source).toContain("m.role === 'tool'");
  });
});
