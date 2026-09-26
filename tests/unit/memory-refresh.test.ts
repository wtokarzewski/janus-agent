import { describe, it, expect, vi } from 'vitest';
import { writeFile, unlink, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../src/db/database.js';
import { migrations } from '../../src/db/migrations.js';
import { MemoryIndex } from '../../src/memory/memory-index.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import { WriteFileTool } from '../../src/tools/builtin/write-file.js';
import { EditFileTool } from '../../src/tools/builtin/edit-file.js';
import { AppendFileTool } from '../../src/tools/builtin/append-file.js';
import { embed } from '../../src/memory/embedder.js';

vi.mock('../../src/memory/embedder.js', () => ({
  EMBEDDING_MODEL: 'mock', embed: vi.fn(async () => new Float32Array([1, 0])),
}));

function setup() {
  const config = createTestConfig({ memory: { vectorSearch: false } });
  const db = new BetterSqlite3(':memory:');
  for (const sql of migrations) db.exec(sql);
  const index = new MemoryIndex({ db } as Database);
  const memory = new MemoryStore(config);
  memory.setIndex(index);
  return { config, db, index, memory };
}

describe('memory index freshness', () => {
  it.each([
    [{}, 'memory'],
    [{ userId: 'alice' }, '.janus/users/alice/memory'],
    [{ chatId: 'group' }, '.janus/chats/group/memory'],
    [{ agentId: 'isolated' }, '.janus/agents/isolated/memory'],
  ] as const)('replaces stale facts and removes empty/deleted files in scope %j', async (scope, dir) => {
    const { config, index, memory, db } = setup();
    try {
      await memory.writeMemory('## Facts\napricot original', scope);
      await memory.reindex();
      expect(await memory.search('apricot', 5, scope)).toHaveLength(1);
      await memory.writeMemory('## Facts\nblueberry replacement', scope);
      expect(await memory.search('apricot', 5, scope)).toEqual([]);
      expect(await memory.search('blueberry', 5, scope)).toHaveLength(1);
      expect(await memory.search('blueberry', 5, { userId: 'other' })).toEqual([]);
      const path = join(config.workspace.dir, dir, 'MEMORY.md');
      await writeFile(path, '');
      expect(await memory.search('blueberry', 5, scope)).toEqual([]);
      await writeFile(path, '## Facts\ncoconut external');
      expect(await memory.search('coconut', 5, scope)).toHaveLength(1);
      await unlink(path);
      const restarted = new MemoryStore(config);
      restarted.setIndex(index);
      expect(await restarted.search('coconut', 5, scope)).toEqual([]);
    } finally { db.close(); }
  });

  it('refreshes validated write/edit/append tool changes without rebuilding unchanged files', async () => {
    const { config, memory, index, db } = setup();
    try {
      const scope = { userId: 'alice' };
      await memory.writeMemory('## Facts\noriginal', scope);
      await memory.reindex();
      const path = '.janus/users/alice/memory/MEMORY.md';
      const ctx = { workspaceDir: config.workspace.dir, onFileChanged: (path: string) => memory.refreshFile(path) };
      const request = { userId: 'alice' };
      const writer = new WriteFileTool(); writer.setContext(ctx);
      const editor = new EditFileTool(); editor.setContext(ctx);
      const appender = new AppendFileTool(); appender.setContext(ctx);
      await writer.execute({ path, content: '## Facts\nnectarine' }, request);
      expect(index.search('nectarine', 5, scope)).toHaveLength(1);
      await editor.execute({ path, old_string: 'nectarine', new_string: 'peach' }, request);
      expect(await memory.search('nectarine', 5, scope)).toEqual([]);
      expect(index.search('peach', 5, scope)).toHaveLength(1);
      await appender.execute({ path, content: '\nquince' }, request);
      expect(index.search('quince', 5, scope)).toHaveLength(1);
      const spy = vi.spyOn(index, 'indexFile');
      await memory.search('quince', 5, scope);
      await memory.search('peach', 5, scope);
      expect(spy).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it('keeps FTS writes responsive while old embeddings wait or fail', async () => {
    const { config, memory, index, db } = setup();
    config.memory.vectorSearch = true;
    let release!: (value: Float32Array) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(embed).mockImplementationOnce(async () => {
      started();
      return new Promise<Float32Array>(resolve => { release = resolve; });
    });
    try {
      await memory.writeMemory('## Facts\nraspberry old');
      await waiting;
      await memory.writeMemory('## Facts\nstrawberry current');
      expect(index.search('raspberry')).toEqual([]);
      expect(index.search('strawberry')).toHaveLength(1);
      release(new Float32Array([1, 0]));
      vi.mocked(embed).mockRejectedValueOnce(new Error('offline embedder'));
      await memory.reindexWithEmbeddings();
      expect(await memory.search('strawberry')).toHaveLength(1);
    } finally { db.close(); }
  });

  it('never attaches a delayed vector to a replacement row or another scope', async () => {
    const { index, db } = setup();
    let release!: (value: Float32Array) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(embed).mockImplementationOnce(async () => {
      started();
      return new Promise<Float32Array>(resolve => { release = resolve; });
    });
    try {
      const pending = index.indexFileWithEmbeddings('MEMORY.md', '## Old\nold tomato', 'alice', 'user', 'alice');
      await waiting;
      index.indexFile('MEMORY.md', '', 'alice', 'user', 'alice');
      index.indexFile('MEMORY.md', '## New\nnew walnut', 'bob', 'user', 'bob');
      release(new Float32Array([1, 0]));
      await pending;
      const rows = db.prepare('SELECT owner, embedding FROM memory_chunks').all();
      expect(rows).toEqual([{ owner: 'bob', embedding: null }]);
    } finally { db.close(); }
  });

  it('discovers isolated memory on startup while excluding mixed-scope logs and backups', async () => {
    const { config, memory, index, db } = setup();
    try {
      const dir = join(config.workspace.dir, '.janus/agents/isolated/memory');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'MEMORY.md'), '## Facts\nvanilla agent');
      await memory.appendHistory('mixedprivate log');
      await writeFile(join(config.workspace.dir, 'memory/MEMORY.backup.1.md'), '## Backup\nmixedprivate old');
      await memory.reindex();
      expect(index.search('vanilla', 5, { agentId: 'isolated' })).toHaveLength(1);
      expect(index.search('mixedprivate')).toEqual([]);
    } finally { db.close(); }
  });

  it('keeps simultaneous users, chats and isolated agents separate when refreshing', async () => {
    const { config, memory, db } = setup();
    const scopes = [{ userId: 'one' }, { userId: 'two' }, { chatId: 'one' }, { chatId: 'two' }, { agentId: 'one' }, { agentId: 'two' }];
    try {
      await Promise.all(scopes.map((scope, i) => memory.writeMemory(`## Facts\nsharedkeyword private-${i}`, scope)));
      for (const [i, scope] of scopes.entries()) {
        const results = await memory.search('sharedkeyword', 10, scope);
        expect(results).toHaveLength(1);
        expect(results[0].content).toBe(`sharedkeyword private-${i}`);
      }
      await writeFile(join(config.workspace.dir, '.janus/users/one/memory/MEMORY.md'), '');
      expect(await memory.search('sharedkeyword', 10, scopes[0])).toEqual([]);
      expect((await memory.search('sharedkeyword', 10, scopes[2]))[0].content).toBe('sharedkeyword private-2');
    } finally { db.close(); }
  });

  it('does not import another scope through a symlink', async () => {
    const { config, memory, db } = setup();
    try {
      await memory.writeMemory('## Facts\nprivatepapaya', { userId: 'bob' });
      const dir = join(config.workspace.dir, '.janus/users/alice/memory');
      await mkdir(dir, { recursive: true });
      await symlink(join(config.workspace.dir, '.janus/users/bob/memory/MEMORY.md'), join(dir, 'MEMORY.md'));
      expect(await memory.search('privatepapaya', 5, { userId: 'alice' })).toEqual([]);
    } finally { db.close(); }
  });
});
