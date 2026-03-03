import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../../src/session/session-manager.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { JanusConfig } from '../../src/config/schema.js';

describe('SessionManager locking', () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(() => {
    dir = join(tmpdir(), `session-lock-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    manager = new SessionManager({
      workspace: { dir, sessionsDir: 'sessions' },
    } as JanusConfig);
  });

  it('concurrent appends do not lose messages', async () => {
    const key = 'test-concurrent';
    const count = 20;

    // Fire many concurrent appends
    const promises = Array.from({ length: count }, (_, i) =>
      manager.append(key, [{ role: 'user', content: `msg-${i}` }]),
    );
    await Promise.all(promises);

    const history = await manager.getHistory(key, 100);
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
    const [, ] = await Promise.all([
      manager.summarize(key, 'Summary of first half'),
      manager.append(key, [{ role: 'user', content: 'after-summarize' }]),
    ]);

    const history = await manager.getHistory(key, 100);
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
    const histA = await manager.getHistory('key-a', 10);
    const histB = await manager.getHistory('key-b', 10);
    expect(histA.length).toBe(1);
    expect(histB.length).toBe(1);
  });
});
