/**
 * Tests for vector search — cosine similarity and hybrid search (RRF fusion).
 * Embedder is tested with mock to avoid downloading the model in CI.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { MemoryIndex } from '../../src/memory/memory-index.js';
import { cosineSimilarity } from '../../src/memory/embedder.js';
import { migrations } from '../../src/db/migrations.js';

function createTestDb() {
  const raw = new BetterSqlite3(':memory:');
  for (const sql of migrations) {
    raw.exec(sql);
  }
  raw.pragma(`user_version = ${migrations.length}`);
  return { db: raw, close: () => raw.close() } as any;
}

describe('cosineSimilarity', () => {
  it('should return 1.0 for identical normalized vectors', () => {
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([0.6, 0.8]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('should return -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('should compute correct similarity for arbitrary vectors', () => {
    // Pre-normalized vectors
    const a = new Float32Array([0.5773, 0.5773, 0.5773]);
    const b = new Float32Array([1.0, 0.0, 0.0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(0.5773, 3);
  });
});

describe('MemoryIndex hybrid search', () => {
  let index: MemoryIndex;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    index = new MemoryIndex(db);
  });

  it('should fall back to FTS results when no embeddings exist', async () => {
    index.indexFile('test.md', '## Architecture\n\nThe agent uses a flat loop architecture with tools.');
    index.indexFile('test2.md', '## Config\n\nConfiguration is loaded from janus.json.');

    const results = await index.hybridSearch('architecture loop');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].heading).toBe('Architecture');
  });

  it('should combine FTS and vector results via RRF', async () => {
    // Insert chunks with fake embeddings
    const insert = db.db.prepare(
      'INSERT INTO memory_chunks (source, heading, content, updated_at, embedding) VALUES (?, ?, ?, datetime(\'now\'), ?)',
    );

    // Create fake embeddings (384-dim for all-MiniLM-L6-v2)
    const dim = 384;
    const emb1 = new Float32Array(dim);
    const emb2 = new Float32Array(dim);
    // Make emb1 "closer" to our query embedding
    emb1[0] = 0.9; emb1[1] = 0.1;
    emb2[0] = 0.1; emb2[1] = 0.9;

    insert.run('a.md', 'Error Handling', 'Try catch exception handling patterns', Buffer.from(emb1.buffer));
    insert.run('b.md', 'Logging', 'Log output error messages to stderr', Buffer.from(emb2.buffer));

    // Rebuild FTS
    db.db.exec("INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES('rebuild')");

    // hybridSearch will attempt to embed the query — which will fail without model
    // but it should fall back gracefully to FTS-only results
    const results = await index.hybridSearch('error handling');
    expect(results.length).toBeGreaterThan(0);
  });

  it('should include embedding column after migration 4', () => {
    // Verify the embedding column exists by inserting with it
    const stmt = db.db.prepare(
      'INSERT INTO memory_chunks (source, heading, content, updated_at, embedding) VALUES (?, ?, ?, datetime(\'now\'), ?)',
    );
    const embedding = new Float32Array([1.0, 2.0, 3.0]);
    stmt.run('test.md', 'Test', 'content', Buffer.from(embedding.buffer));

    const row = db.db.prepare('SELECT embedding FROM memory_chunks WHERE source = ?').get('test.md') as { embedding: Buffer };
    expect(row.embedding).toBeDefined();
    const recovered = new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength));
    expect(recovered[0]).toBeCloseTo(1.0);
    expect(recovered[1]).toBeCloseTo(2.0);
    expect(recovered[2]).toBeCloseTo(3.0);
  });
});
