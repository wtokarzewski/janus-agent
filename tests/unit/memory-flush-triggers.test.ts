import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Memory flush consolidation (post context-management redesign)', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should not contain idle timer logic', () => {
    expect(source).not.toContain('idleTimer');
    expect(source).not.toContain('memoryIdleFlushMs');
  });

  it('should not contain pre-compaction flush block', () => {
    // The pre-compaction flush inside doSummarization was removed because it
    // raced with the token-aware flush via a shared `state.flushing` guard.
    expect(source).not.toContain('Pre-summarization flush attempt');
    expect(source).not.toContain('Pre-compaction memory flush');
  });

  it('should use count-based trigger (>=20 unflushed)', () => {
    expect(source).toContain('unflushed >= 20');
  });

  it('should not use the legacy tokenBudget threshold for flush', () => {
    // Legacy: `tokenBudget * 0.4` — 5x too high (never fired) and prone to race
    // with pre-compaction flush.
    expect(source).not.toContain('tokenBudget * 0.4');
  });
});
