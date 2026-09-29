import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import type { LLMMessage } from '../../src/llm/types.js';

const faults = vi.hoisted(() => ({ operation: '', interrupted: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      if (faults.operation === 'archive') throw new Error('archive failure');
      await fs.copyFile(...args);
      await faults.interrupted?.();
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (faults.operation === 'write' && String(args[0]).endsWith('.tmp')) throw new Error('write failure');
      return fs.writeFile(...args);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (faults.operation === 'rename') throw new Error('rename failure');
      return fs.rename(...args);
    },
  };
});
const dirs: string[] = [];
afterEach(async () => { faults.operation = ''; faults.interrupted = undefined; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'compaction-recovery-')); dirs.push(dir);
  const config = createTestConfig({ workspace: { dir, sessionsDir: 'sessions' } });
  const manager = new SessionManager(config);
  const messages: LLMMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fact ${i} ` + 'x'.repeat(100) }));
  await manager.append('test', messages);
  await manager.summarize('test', 'previous facts: limit 17', 450);
  return { manager, config, dir, before: structuredClone(await manager.getOrCreate('test')) };
}

describe('Compaction recovery', () => {
  it.each(['archive', 'write', 'rename'])('keeps cache and live transcript intact on %s failure', async operation => {
    const { manager, config, before } = await fixture();
    faults.operation = operation;
    await expect(manager.summarize('test', 'replacement', 100)).rejects.toThrow();
    expect(await manager.getOrCreate('test')).toEqual(before);
    expect(await new SessionManager(config).getOrCreate('test')).toEqual(before);
  });

  it('allows restart between archiving and replacement with the complete previous state', async () => {
    const { manager, config, before } = await fixture();
    let observed = false;
    faults.interrupted = async () => {
      expect(await new SessionManager(config).getOrCreate('test')).toEqual(before);
      observed = true;
    };
    await manager.summarize('test', 'replacement', 100);
    expect(observed).toBe(true);
    expect((await new SessionManager(config).getOrCreate('test')).metadata.summary).toBe('replacement');
  });

  it('preserves the previous summary and an archive on lossy fallback', async () => {
    const { manager, config, dir, before } = await fixture();
    await manager.forceDropOldest('test', 0.5);
    const after = await new SessionManager(config).getOrCreate('test');
    expect(after.metadata.summary).toBe(before.metadata.summary);
    expect(after.messages.length).toBeLessThan(before.messages.length);
    expect(after.metadata.compactionFailure).toContain('force-dropped');
    const contents = await Promise.all((await readdir(join(dir, 'sessions'))).filter(name => /\.\d+\.jsonl$/.test(name)).map(name => readFile(join(dir, 'sessions', name), 'utf8')));
    expect(contents.some(text => before.messages.every(message => text.includes(String(message.content))))).toBe(true);
  });

  it('does not publish a shortened cache when fallback persistence fails', async () => {
    const { manager, config, before } = await fixture();
    faults.operation = 'write';
    await expect(manager.forceDropOldest('test', 0.5)).rejects.toThrow();
    expect(await manager.getOrCreate('test')).toEqual(before);
    expect(await new SessionManager(config).getOrCreate('test')).toEqual(before);
  });
});
