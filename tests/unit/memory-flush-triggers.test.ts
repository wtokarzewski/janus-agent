import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Memory flush consolidation', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should not contain idle timer logic', () => {
    expect(source).not.toContain('idleTimer');
    expect(source).not.toContain('memoryIdleFlushMs');
  });

  it('should not contain count-based flush logic', () => {
    expect(source).not.toContain('lastFlushHash');
    expect(source).not.toContain('memoryFlushInterval');
  });

  it('should still contain token-aware flush', () => {
    expect(source).toContain('tokenFlushThreshold');
  });

  it('should use 0.4 threshold for token-aware flush', () => {
    expect(source).toContain('tokenBudget * 0.4');
  });
});
