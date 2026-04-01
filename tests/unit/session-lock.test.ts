import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { JanusConfig } from '../../src/config/schema.js';

function makeConfig(dir: string, overrides?: { contextWindow?: number; toolResultMaxShare?: number; toolResultHardMax?: number }) {
  return {
    workspace: { dir, sessionsDir: 'sessions' },
    agent: {
      contextWindow: overrides?.contextWindow ?? 1_000_000,
      context: {
        toolResultMaxShare: overrides?.toolResultMaxShare ?? 0.3,
        toolResultHardMax: overrides?.toolResultHardMax ?? 400_000,
      },
    },
  } as JanusConfig;
}

describe('SessionManager locking', () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = join(tmpdir(), `session-lock-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    manager = new SessionManager(makeConfig(dir));
  });

  it('concurrent appends do not lose messages', async () => {
    const key = 'test-concurrent';
    const count = 20;

    // Fire many concurrent appends
    const promises = Array.from({ length: count }, (_, i) =>
      manager.append(key, [{ role: 'user', content: `msg-${i}` }]),
    );
    await Promise.all(promises);

    const history = await manager.getHistory(key);
    expect(history.length).toBe(count);

    // Verify all messages are present (order may vary but none lost)
    const contents = history.map(m => m.content);
    for (let i = 0; i < count; i++) {
      expect(contents).toContain(`msg-${i}`);
    }
  });

  it('concurrent append and summarize are serialized', async () => {
    const key = 'test-summarize';

    // Pre-fill with 12 messages
    for (let i = 0; i < 12; i++) {
      await manager.append(key, [{ role: 'user', content: `msg-${i}` }]);
    }

    // Concurrent summarize + append
    // keepRecentTokens=10: "msg-8"..msg-11" ≈ 2+2+3+3=10 tokens → keeps last 4 messages
    const [, ] = await Promise.all([
      manager.summarize(key, 'Summary of first half', 10),
      manager.append(key, [{ role: 'user', content: 'after-summarize' }]),
    ]);

    const history = await manager.getHistory(key);
    // Should have kept 4 from summarize + 1 appended = 5
    expect(history.length).toBe(5);
    expect(history[history.length - 1].content).toBe('after-summarize');
  });

  it('independent keys are not blocked by each other', async () => {
    const results: string[] = [];

    await Promise.all([
      manager.append('key-a', [{ role: 'user', content: 'a' }]).then(() => results.push('a')),
      manager.append('key-b', [{ role: 'user', content: 'b' }]).then(() => results.push('b')),
    ]);

    expect(results).toHaveLength(2);
    const histA = await manager.getHistory('key-a');
    const histB = await manager.getHistory('key-b');
    expect(histA.length).toBe(1);
    expect(histB.length).toBe(1);
  });
});

describe('SessionManager getHistory returns all messages', () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = join(tmpdir(), `session-history-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    manager = new SessionManager(makeConfig(dir));
  });

  it('returns all messages without any limit', async () => {
    const key = 'test-all-messages';
    const count = 100;

    for (let i = 0; i < count; i++) {
      await manager.append(key, [{ role: 'user', content: `msg-${i}` }]);
    }

    const history = await manager.getHistory(key);
    expect(history.length).toBe(count);

    // Verify first and last messages are present
    expect(history[0].content).toBe('msg-0');
    expect(history[count - 1].content).toBe(`msg-${count - 1}`);
  });
});

describe('SessionManager tool result truncation', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `session-truncate-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  it('truncates tool results exceeding dynamic cap on append', async () => {
    // contextWindow=1000, share=0.3 → dynamic cap = floor(1000 * 2.5 * 0.3) = 750
    // hardMax=400_000 → min(750, 400_000) = 750
    const manager = new SessionManager(makeConfig(dir, {
      contextWindow: 1000,
      toolResultMaxShare: 0.3,
      toolResultHardMax: 400_000,
    }));
    const key = 'test-truncate';
    const longContent = 'x'.repeat(2000);

    await manager.append(key, [{ role: 'tool' as const, content: longContent, tool_call_id: 'tu_1' }]);

    const history = await manager.getHistory(key);
    expect(history.length).toBe(1);
    const result = history[0].content as string;
    expect(result.length).toBeLessThan(longContent.length);
    expect(result).toContain('[truncated:');
    expect(result).toContain('chars removed to fit context budget');
  });

  it('does NOT truncate tool results under cap', async () => {
    // contextWindow=1_000_000, share=0.3 → dynamic cap = 750_000
    // hardMax=400_000 → min(750_000, 400_000) = 400_000
    const manager = new SessionManager(makeConfig(dir, {
      contextWindow: 1_000_000,
      toolResultMaxShare: 0.3,
      toolResultHardMax: 400_000,
    }));
    const key = 'test-no-truncate';
    const shortContent = 'hello world';

    await manager.append(key, [{ role: 'tool' as const, content: shortContent, tool_call_id: 'tu_2' }]);

    const history = await manager.getHistory(key);
    expect(history.length).toBe(1);
    expect(history[0].content).toBe(shortContent);
  });

  it('hard max applies even with huge context window', async () => {
    // contextWindow=10_000_000, share=0.3 → dynamic cap = 7_500_000
    // hardMax=1000 → min(7_500_000, 1000) = 1000
    const manager = new SessionManager(makeConfig(dir, {
      contextWindow: 10_000_000,
      toolResultMaxShare: 0.3,
      toolResultHardMax: 1000,
    }));
    const key = 'test-hard-max';
    const longContent = 'y'.repeat(5000);

    await manager.append(key, [{ role: 'tool' as const, content: longContent, tool_call_id: 'tu_3' }]);

    const history = await manager.getHistory(key);
    expect(history.length).toBe(1);
    const result = history[0].content as string;
    expect(result).toContain('[truncated:');
    // Head (70% of 1000=700) + marker + tail (30% of 1000=300) — total should be around 1000 + marker length
    expect(result.length).toBeLessThan(longContent.length);
    // The head and tail should come from the original content
    expect(result.startsWith('y'.repeat(700))).toBe(true);
    expect(result.endsWith('y'.repeat(300))).toBe(true);
  });
});
