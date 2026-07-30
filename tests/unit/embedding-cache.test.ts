/**
 * Reindexing on every start recomputed every embedding from scratch (~60s of CPU
 * on a real workspace). Embeddings are a pure function of chunk text, so unchanged
 * content must come from cache instead of the model.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { MemoryIndex } from '../../src/memory/memory-index.js';
import { migrations } from '../../src/db/migrations.js';

const embedCalls: string[] = [];

vi.mock('../../src/memory/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/embedder.js')>();
  return {
    ...actual,
    embed: async (text: string) => {
      embedCalls.push(text);
      // Deterministic stand-in for the model: unique per text, no download.
      return new Float32Array([text.length, 0, 1]);
    },
  };
});

function createTestDb() {
  const raw = new BetterSqlite3(':memory:');
  for (const sql of migrations) raw.exec(sql);
  raw.pragma(`user_version = ${migrations.length}`);
  return { db: raw } as any;
}

describe('MemoryIndex embedding cache', () => {
  let index: MemoryIndex;
  let db: any;

  beforeEach(() => {
    embedCalls.length = 0;
    db = createTestDb();
    index = new MemoryIndex(db);
  });

  it('does not call the model again when a file is reindexed unchanged', async () => {
    const content = '## Alpha\nfirst section\n\n## Beta\nsecond section\n';
    await index.indexFileWithEmbeddings('notes.md', content);
    const firstPass = embedCalls.length;
    embedCalls.length = 0;

    await index.indexFileWithEmbeddings('notes.md', content);

    expect(firstPass).toBeGreaterThan(0);
    expect(embedCalls).toEqual([]);
  });

  it('embeds only the chunk whose text changed', async () => {
    await index.indexFileWithEmbeddings('notes.md', '## Alpha\nfirst section\n\n## Beta\nsecond section\n');
    embedCalls.length = 0;

    await index.indexFileWithEmbeddings('notes.md', '## Alpha\nfirst section\n\n## Beta\nrewritten section\n');

    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toContain('rewritten section');
  });

  it('still stores the embedding on every chunk when served from cache', async () => {
    const content = '## Alpha\nfirst section\n\n## Beta\nsecond section\n';
    await index.indexFileWithEmbeddings('notes.md', content);

    await index.indexFileWithEmbeddings('notes.md', content);

    const rows = db.db.prepare('SELECT embedding FROM memory_chunks WHERE source = ?').all('notes.md');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { embedding: Buffer | null }) => r.embedding !== null)).toBe(true);
  });

  it('reuses an identical chunk across different files', async () => {
    await index.indexFileWithEmbeddings('a.md', '## Shared\nidentical body\n');
    embedCalls.length = 0;

    await index.indexFileWithEmbeddings('b.md', '## Shared\nidentical body\n');

    expect(embedCalls).toEqual([]);
  });
});
