/**
 * MemoryIndex — indexes markdown memory files into SQLite FTS5 for search.
 *
 * Chunks by ## headings (natural semantic boundaries in markdown).
 * Chunks over ~2000 chars split further at paragraph boundaries.
 */

import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import * as log from '../utils/logger.js';

/** Cache key for a chunk's embedding — model identity plus exact text. */
function hashContent(model: string, content: string): string {
  return createHash('sha256').update(`${model}\n${content}`).digest('hex');
}

export interface MemoryChunk {
  source: string;
  heading: string;
  content: string;
}

const MAX_CHUNK_CHARS = 2000;

export class MemoryIndex {
  private db: BetterSqlite3.Database;

  constructor(database: Database) {
    this.db = database.db;
  }

  /** Index a markdown file's content by splitting into heading-based chunks. */
  indexFile(source: string, content: string, owner = 'shared', scope = 'global', scopeId: string | null = null): void {
    const chunks = splitMarkdownChunks(source, content);
    if (chunks.length === 0) return;

    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM memory_chunks WHERE source = ? AND owner = ? AND scope = ?').run(source, owner, scope);
      const insert = this.db.prepare(
        'INSERT INTO memory_chunks (source, heading, content, updated_at, owner, scope, scope_id) VALUES (?, ?, ?, datetime(\'now\'), ?, ?, ?)',
      );
      for (const chunk of chunks) {
        insert.run(chunk.source, chunk.heading, chunk.content, owner, scope, scopeId);
      }
    });
    tx();
  }

  /** Search memory chunks by FTS5 query. Returns top-N ranked by bm25 with temporal decay. */
  search(query: string, limit = 5, scope?: { chatId?: string; userId?: string; agentId?: string }): MemoryChunk[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    try {
      // Fetch more candidates than needed, then re-rank with temporal decay
      const candidates = this.db.prepare(`
        SELECT mc.source, mc.heading, mc.content, mc.updated_at, mc.owner, mc.scope, mc.scope_id,
               bm25(memory_chunks_fts) AS bm25_score
        FROM memory_chunks_fts fts
        JOIN memory_chunks mc ON mc.id = fts.rowid
        WHERE memory_chunks_fts MATCH ?
        ORDER BY bm25(memory_chunks_fts)
        LIMIT ?
      `).all(sanitized, limit * 5) as Array<MemoryChunk & { updated_at: string; bm25_score: number; owner: string; scope: string; scope_id: string | null }>;

      // Filter by scope visibility
      const visible = this.filterByScope(candidates, scope);

      // Apply temporal decay: 30-day half-life
      // BM25 returns negative values (lower = better match), so negate for scoring
      const now = Date.now();
      const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

      const scored = visible.map(c => {
        const relevance = -c.bm25_score;
        const ageMs = now - new Date(c.updated_at).getTime();
        // MEMORY.md chunks are evergreen — no decay
        const isEvergreen = c.source === 'MEMORY.md';
        const decay = isEvergreen ? 1.0 : Math.pow(0.5, ageMs / HALF_LIFE_MS);
        return { ...c, finalScore: relevance * decay };
      });

      scored.sort((a, b) => b.finalScore - a.finalScore);

      return scored.slice(0, limit).map(({ source, heading, content }) => ({ source, heading, content }));
    } catch (err) {
      log.warn(`FTS search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Hybrid search: combines FTS5 (BM25) + vector similarity via Reciprocal Rank Fusion. */
  async hybridSearch(query: string, limit = 5, scope?: { chatId?: string; userId?: string; agentId?: string }, textWeight = 1.0, vectorWeight = 1.0): Promise<MemoryChunk[]> {
    // 1. FTS5 results (already scope-filtered)
    const ftsResults = this.search(query, limit * 2, scope);

    // 2. Vector results
    let vectorResults: Array<MemoryChunk & { similarity: number }> = [];
    try {
      const { embed, cosineSimilarity } = await import('./embedder.js');
      const queryEmbedding = await embed(query);

      const allChunks = this.db.prepare(
        'SELECT source, heading, content, embedding, owner, scope, scope_id FROM memory_chunks WHERE embedding IS NOT NULL',
      ).all() as Array<MemoryChunk & { embedding: Buffer; owner: string; scope: string; scope_id: string | null }>;

      // Filter by scope visibility
      const visibleChunks = this.filterByScope(allChunks, scope);

      vectorResults = visibleChunks
        .map(c => ({
          source: c.source,
          heading: c.heading,
          content: c.content,
          similarity: cosineSimilarity(queryEmbedding, new Float32Array(c.embedding.buffer.slice(c.embedding.byteOffset, c.embedding.byteOffset + c.embedding.byteLength))),
        }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit * 2);
    } catch (err) {
      log.warn(`Vector search failed, falling back to FTS only: ${err instanceof Error ? err.message : String(err)}`);
      return ftsResults.slice(0, limit);
    }

    // 3. Reciprocal Rank Fusion (k=60)
    const scores = new Map<string, number>();
    const chunkMap = new Map<string, MemoryChunk>();
    const k = 60;

    ftsResults.forEach((c, i) => {
      const key = `${c.source}:${c.heading}`;
      scores.set(key, (scores.get(key) ?? 0) + textWeight / (k + i + 1));
      chunkMap.set(key, c);
    });

    vectorResults.forEach((c, i) => {
      const key = `${c.source}:${c.heading}`;
      scores.set(key, (scores.get(key) ?? 0) + vectorWeight / (k + i + 1));
      if (!chunkMap.has(key)) chunkMap.set(key, { source: c.source, heading: c.heading, content: c.content });
    });

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([key]) => chunkMap.get(key)!);
  }

  /** Index a file and compute embeddings for each chunk. */
  async indexFileWithEmbeddings(source: string, content: string, owner = 'shared', scope = 'global', scopeId: string | null = null): Promise<void> {
    // First do the regular FTS index
    this.indexFile(source, content, owner, scope, scopeId);

    // Then compute and store embeddings (yields to event loop between chunks).
    // indexFile() above dropped and reinserted the rows, so every embedding column is
    // NULL again — but the vectors themselves only depend on the chunk text. Look them
    // up by content hash first, so an unchanged workspace costs no model inference.
    try {
      const { embed, EMBEDDING_MODEL } = await import('./embedder.js');
      const chunks = this.db.prepare(
        'SELECT id, content FROM memory_chunks WHERE source = ? AND owner = ? AND scope = ?',
      ).all(source, owner, scope) as Array<{ id: number; content: string }>;

      const updateStmt = this.db.prepare('UPDATE memory_chunks SET embedding = ? WHERE id = ?');
      const readCache = this.db.prepare('SELECT embedding FROM embedding_cache WHERE content_hash = ?');
      const writeCache = this.db.prepare(
        'INSERT OR REPLACE INTO embedding_cache (content_hash, embedding) VALUES (?, ?)',
      );

      let computed = 0;
      for (const chunk of chunks) {
        const hash = hashContent(EMBEDDING_MODEL, chunk.content);
        const cached = readCache.get(hash) as { embedding: Buffer } | undefined;

        let buffer: Buffer;
        if (cached) {
          buffer = cached.embedding;
        } else {
          const embedding = await embed(chunk.content);
          buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
          writeCache.run(hash, buffer);
          computed++;
        }
        updateStmt.run(buffer, chunk.id);
        // embed() already yields, but yield again after SQLite write
        // to keep event loop responsive during bulk indexing
      }

      if (computed > 0) {
        log.info(`Computed embeddings for ${computed}/${chunks.length} chunks from ${source}`);
      } else {
        log.debug(`Embeddings for ${source} served from cache (${chunks.length} chunks)`);
      }
    } catch (err) {
      log.warn(`Embedding computation failed for ${source}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Filter memory chunks by scope visibility rules:
   * - scope undefined (global/backward-compat): all chunks visible
   * - scope.kind === 'user': shared+global + user's own private chunks
   * - scope.kind === 'family': shared+global + family shared chunks (no user-private)
   */
  private filterByScope<T extends { owner: string; scope: string; scope_id: string | null }>(
    chunks: T[],
    scope?: { chatId?: string; userId?: string; agentId?: string },
  ): T[] {
    // Strict scoping: a search sees ONLY chunks of its own scope — no cross-scope merge.
    // Precedence mirrors MemoryStore.resolveMemDir: agent > chat > user > global.
    if (scope?.agentId) return chunks.filter(c => c.scope === 'agent' && c.scope_id === scope.agentId);
    if (scope?.chatId) return chunks.filter(c => c.scope === 'chat' && c.scope_id === scope.chatId);
    if (scope?.userId) return chunks.filter(c => c.scope === 'user' && c.scope_id === scope.userId);
    return chunks.filter(c => c.scope === 'global'); // chatless / global context
  }

  /** Reindex all provided files. */
  reindex(files: Array<{ source: string; content: string; owner?: string; scope?: string; scopeId?: string | null }>): void {
    let totalChunks = 0;
    for (const file of files) {
      if (!file.content.trim()) continue;
      this.indexFile(file.source, file.content, file.owner ?? 'shared', file.scope ?? 'global', file.scopeId ?? null);
      const count = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM memory_chunks WHERE source = ? AND owner = ? AND scope = ?',
      ).get(file.source, file.owner ?? 'shared', file.scope ?? 'global') as { cnt: number };
      totalChunks += count.cnt;
    }
    log.info(`Indexed ${totalChunks} chunks from ${files.length} file(s)`);
  }
}

/** Split markdown content into chunks by ## headings, with paragraph sub-splitting. */
export function splitMarkdownChunks(source: string, content: string): MemoryChunk[] {
  const chunks: MemoryChunk[] = [];
  const sections = content.split(/^## /m);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;

    let heading: string;
    let body: string;

    if (i === 0) {
      // Content before first ## heading
      const firstLineEnd = section.indexOf('\n');
      const firstLine = firstLineEnd === -1 ? section : section.slice(0, firstLineEnd).trim();
      heading = firstLine.startsWith('# ') ? firstLine.slice(2) : '(preamble)';
      body = firstLineEnd === -1 ? '' : section.slice(firstLineEnd + 1).trim();
    } else {
      const firstLineEnd = section.indexOf('\n');
      heading = (firstLineEnd === -1 ? section : section.slice(0, firstLineEnd)).trim();
      body = firstLineEnd === -1 ? '' : section.slice(firstLineEnd + 1).trim();
    }

    const fullText = body || heading;

    if (fullText.length <= MAX_CHUNK_CHARS) {
      chunks.push({ source, heading, content: fullText });
    } else {
      // Split at paragraph boundaries
      const paragraphs = fullText.split(/\n\n+/);
      let buffer = '';
      for (const para of paragraphs) {
        if (buffer && (buffer.length + para.length + 2) > MAX_CHUNK_CHARS) {
          chunks.push({ source, heading, content: buffer.trim() });
          buffer = '';
        }
        buffer += (buffer ? '\n\n' : '') + para;
      }
      if (buffer.trim()) {
        chunks.push({ source, heading, content: buffer.trim() });
      }
    }
  }

  return chunks;
}

/**
 * Sanitize user input for FTS5 MATCH.
 * Extracts words (3+ chars), joins with OR for broad matching.
 */
function sanitizeFtsQuery(query: string): string {
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);

  if (words.length === 0) return '';
  return words.join(' OR ');
}
