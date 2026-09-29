import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import type { LLMMessage } from '../../src/llm/types.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'flush-cursor-'));
  dirs.push(dir);
  const config = createTestConfig({ workspace: { dir, sessionsDir: 'sessions' } });
  const manager = new SessionManager(config);
  const messages: LLMMessage[] = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `message ${i} ` + 'x'.repeat(100),
  }));
  await manager.append('test', messages);
  return { manager, config, dir };
}

describe('Durable memory flush cursor', () => {
  it('completes a captured flush after 12→2 rotation without skipping a later message, including restart', async () => {
    const { manager, config } = await fixture();
    const snapshot = await manager.prepareMemoryFlush('test');
    expect(snapshot.messages).toHaveLength(12);
    await manager.summarize('test', 'summary', 100);
    expect(await manager.getHistory('test')).toHaveLength(2);
    await manager.completeMemoryFlush('test', snapshot);
    await manager.append('test', [{ role: 'user', content: 'new correction' }]);
    const restarted = new SessionManager(config);
    const pending = await restarted.prepareMemoryFlush('test');
    expect(pending.messages).toEqual([{ role: 'user', content: 'new correction' }]);
    await restarted.completeMemoryFlush('test', pending);
    expect((await new SessionManager(config).prepareMemoryFlush('test')).messages).toEqual([]);
  });

  it('does not acknowledge tail messages just because compaction ran', async () => {
    const { manager, config } = await fixture();
    await manager.summarize('test', 'summary', 100);
    expect((await new SessionManager(config).prepareMemoryFlush('test')).messages).toHaveLength(2);
  });

  it('ignores a stale completion after clear and is idempotent', async () => {
    const { manager, config } = await fixture();
    const old = await manager.prepareMemoryFlush('test');
    await manager.clear('test');
    await manager.append('test', [{ role: 'user', content: 'new generation' }]);
    expect(await manager.completeMemoryFlush('test', old)).toBe(false);
    const current = await manager.prepareMemoryFlush('test');
    expect(current.messages).toHaveLength(1);
    expect(await manager.completeMemoryFlush('test', current)).toBe(true);
    expect(await manager.completeMemoryFlush('test', current)).toBe(true);
    expect((await new SessionManager(config).prepareMemoryFlush('test')).messages).toEqual([]);
  });

  it('keeps a failed checkpoint eligible in cache and after restart', async () => {
    const { manager, config, dir } = await fixture();
    const snapshot = await manager.prepareMemoryFlush('test');
    // A directory at the destination makes the atomic rename fail on all platforms.
    const path = join(dir, 'sessions', 'test.jsonl');
    const { rename } = await import('node:fs/promises');
    await rename(path, `${path}.backup`);
    await mkdir(path);
    await expect(manager.completeMemoryFlush('test', snapshot)).rejects.toThrow();
    expect((await manager.prepareMemoryFlush('test')).messages).toHaveLength(12);
    await rm(path, { recursive: true });
    await rename(`${path}.backup`, path);
    expect((await new SessionManager(config).prepareMemoryFlush('test')).messages).toHaveLength(12);
  });

  it('loads legacy JSONL conservatively without trusting a rotation-derived index', async () => {
    const { config, dir } = await fixture();
    await writeFile(join(dir, 'sessions', 'legacy.jsonl'), [
      JSON.stringify({ _type: 'metadata', key: 'legacy', lastFlushed: 12 }),
      JSON.stringify({ role: 'user', content: 'legacy fact' }),
    ].join('\n'));
    const manager = new SessionManager(config);
    const pending = await manager.prepareMemoryFlush('legacy');
    expect(pending.messages).toEqual([{ role: 'user', content: 'legacy fact' }]);
    await manager.completeMemoryFlush('legacy', pending);
    await manager.append('legacy', [{ role: 'user', content: 'new fact' }]);
    expect((await new SessionManager(config).prepareMemoryFlush('legacy')).messages).toEqual([{ role: 'user', content: 'new fact' }]);
  });
});
