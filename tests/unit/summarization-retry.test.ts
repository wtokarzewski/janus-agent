import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Summarization quality retry removal', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should not contain scheduling quality retry heuristic', () => {
    expect(source).not.toContain('hasScheduling');
    expect(source).not.toContain('hasCriticalContext');
    expect(source).not.toContain('Summarization quality');
  });
});
