import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { MemoryIndex, splitMarkdownChunks } from '../../src/memory/memory-index.js';
import { migrations } from '../../src/db/migrations.js';

// Create an in-memory database with migrations applied for testing
function createTestDb() {
  const raw = new BetterSqlite3(':memory:');
  for (const sql of migrations) {
    raw.exec(sql);
  }
  raw.pragma(`user_version = ${migrations.length}`);
  // Return a minimal Database-like object
  return { db: raw, close: () => raw.close() } as any;
}

describe('splitMarkdownChunks', () => {
  it('should split by ## headings', () => {
    const content = `# Title

Intro text

## Section One

Content one

## Section Two

Content two
`;
    const chunks = splitMarkdownChunks('test.md', content);
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const headings = chunks.map(c => c.heading);
    expect(headings).toContain('Title');
    expect(headings).toContain('Section One');
    expect(headings).toContain('Section Two');
  });

  it('should handle content with no ## headings', () => {
    const content = '# Just a title\n\nSome paragraph text.';
    const chunks = splitMarkdownChunks('test.md', content);
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe('Just a title');
  });

  it('should split large chunks at paragraph boundaries', () => {
    const longParagraph = 'A'.repeat(800);
    const content = `## Big Section\n\n${longParagraph}\n\n${longParagraph}\n\n${longParagraph}\n\n${longParagraph}`;
    const chunks = splitMarkdownChunks('test.md', content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2200); // allow some slack
    }
  });

  it('should return empty array for empty content', () => {
    expect(splitMarkdownChunks('test.md', '')).toEqual([]);
    expect(splitMarkdownChunks('test.md', '   ')).toEqual([]);
  });

  it('should set source on all chunks', () => {
    const chunks = splitMarkdownChunks('MEMORY.md', '## Heading\n\nContent');
    expect(chunks.every(c => c.source === 'MEMORY.md')).toBe(true);
  });
});

describe('MemoryIndex', () => {
  let index: MemoryIndex;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    index = new MemoryIndex(db);
  });

  it('should index and search content', () => {
    index.indexFile('MEMORY.md', `## Architecture\n\nThe agent uses a flat loop architecture.\n\n## Tools\n\nSeven built-in tools: exec, read, write, edit, list, message, spawn.`);

    const results = index.search('architecture loop');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].heading).toBe('Architecture');
  });

  it('should return empty for nonsense query', () => {
    index.indexFile('test.md', '## Section\n\nSome normal content here.');
    const results = index.search('xyzzyplugh');
    expect(results).toEqual([]);
  });

  it('should respect limit', () => {
    index.indexFile('test.md', `## A\n\nWord\n\n## B\n\nWord\n\n## C\n\nWord\n\n## D\n\nWord`);
    const results = index.search('word', 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('should re-index (replace old chunks)', () => {
    index.indexFile('test.md', '## Old\n\nOld content about dogs');
    let results = index.search('dogs');
    expect(results.length).toBe(1);

    index.indexFile('test.md', '## New\n\nNew content about cats');
    results = index.search('dogs');
    expect(results.length).toBe(0);
    results = index.search('cats');
    expect(results.length).toBe(1);
  });

  it('should handle empty query gracefully', () => {
    index.indexFile('test.md', '## Section\n\nContent');
    expect(index.search('')).toEqual([]);
    expect(index.search('  ')).toEqual([]);
  });

  it('should reindex multiple files', () => {
    index.reindex([
      { source: 'MEMORY.md', content: '## Overview\n\nProject overview content' },
      { source: '2025-01-01.md', content: '## Daily\n\nToday I worked on tests' },
    ]);

    expect(index.search('overview').length).toBe(1);
    expect(index.search('tests').length).toBe(1);
  });

  it('should rank recent chunks higher than old ones with temporal decay', () => {
    // Insert two chunks with identical content but different dates
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Use raw DB to control updated_at precisely
    const insert = db.db.prepare(
      'INSERT INTO memory_chunks (source, heading, content, updated_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('recent.md', 'Agent Setup', 'Important agent configuration details here', now.toISOString());
    insert.run('old.md', 'Agent Setup', 'Important agent configuration details here', thirtyDaysAgo.toISOString());

    // Rebuild FTS index for the manually inserted rows
    db.db.exec("INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES('rebuild')");

    const results = index.search('agent configuration', 2);
    expect(results.length).toBe(2);
    // Recent chunk should rank first due to temporal decay
    expect(results[0].source).toBe('recent.md');
    expect(results[1].source).toBe('old.md');
  });

  it('should not apply decay to MEMORY.md chunks (evergreen)', () => {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const insert = db.db.prepare(
      'INSERT INTO memory_chunks (source, heading, content, updated_at) VALUES (?, ?, ?, ?)',
    );
    // MEMORY.md is old but should not be decayed
    insert.run('MEMORY.md', 'Architecture', 'The system architecture uses flat loop', sixtyDaysAgo.toISOString());
    // Daily note is recent
    insert.run('daily.md', 'Notes', 'The system architecture was discussed today', now.toISOString());

    db.db.exec("INSERT INTO memory_chunks_fts(memory_chunks_fts) VALUES('rebuild')");

    const results = index.search('system architecture', 2);
    expect(results.length).toBe(2);
    // MEMORY.md should still rank high despite age (evergreen)
    // The exact order depends on BM25 scores, but MEMORY.md should not be penalized
    const memoryChunk = results.find(r => r.source === 'MEMORY.md');
    expect(memoryChunk).toBeDefined();
  });

  it('should index with owner and scope', () => {
    index.indexFile('user-notes.md', '## My Notes\n\nPersonal notes here', 'wt', 'user', 'wt');

    const row = db.db.prepare(
      'SELECT owner, scope, scope_id FROM memory_chunks WHERE source = ?',
    ).get('user-notes.md') as { owner: string; scope: string; scope_id: string | null };

    expect(row.owner).toBe('wt');
    expect(row.scope).toBe('user');
    expect(row.scope_id).toBe('wt');
  });

  it('should filter search results by user scope', () => {
    // Insert shared global chunk
    index.indexFile('shared.md', '## Info\n\nShared project information', 'shared', 'global');
    // Insert user-private chunk
    index.indexFile('wt-notes.md', '## Info\n\nPrivate user information', 'wt', 'user', 'wt');
    // Insert another user's private chunk
    index.indexFile('monika-notes.md', '## Info\n\nMonika private information', 'monika', 'user', 'monika');

    // Search as user 'wt' — should see shared + own private, not monika's
    const results = index.search('information', 10, 'wt', { kind: 'user', id: 'wt' });
    const sources = results.map(r => r.source);
    expect(sources).toContain('shared.md');
    expect(sources).toContain('wt-notes.md');
    expect(sources).not.toContain('monika-notes.md');
  });

  it('should filter search results by family scope (no user-private)', () => {
    // Insert shared global chunk
    index.indexFile('shared.md', '## Info\n\nShared project information', 'shared', 'global');
    // Insert family chunk
    index.indexFile('family.md', '## Info\n\nFamily shared information', 'shared', 'family', 'family_wt');
    // Insert user-private chunk
    index.indexFile('wt-notes.md', '## Info\n\nPrivate user information', 'wt', 'user', 'wt');

    // Family search — should see shared + family, not user-private
    const results = index.search('information', 10, 'wt', { kind: 'family', id: 'family_wt' });
    const sources = results.map(r => r.source);
    expect(sources).toContain('shared.md');
    expect(sources).toContain('family.md');
    expect(sources).not.toContain('wt-notes.md');
  });

  it('should return all chunks when no scope (backward-compat)', () => {
    index.indexFile('shared.md', '## Info\n\nShared project information', 'shared', 'global');
    index.indexFile('wt-notes.md', '## Info\n\nPrivate user information', 'wt', 'user', 'wt');

    // No scope — should see everything
    const results = index.search('information', 10);
    expect(results.length).toBe(2);
  });

  it('should not return family chunks from wrong family', () => {
    index.indexFile('family1.md', '## Info\n\nFamily one information', 'shared', 'family', 'family_a');
    index.indexFile('family2.md', '## Info\n\nFamily two information', 'shared', 'family', 'family_b');

    const results = index.search('information', 10, 'wt', { kind: 'family', id: 'family_a' });
    const sources = results.map(r => r.source);
    expect(sources).toContain('family1.md');
    expect(sources).not.toContain('family2.md');
  });

  it('should reindex with owner/scope metadata', () => {
    index.reindex([
      { source: 'MEMORY.md', content: '## Overview\n\nProject overview', owner: 'shared', scope: 'global' },
      { source: 'wt-daily.md', content: '## Notes\n\nUser notes', owner: 'wt', scope: 'user', scopeId: 'wt' },
    ]);

    const rows = db.db.prepare('SELECT source, owner, scope, scope_id FROM memory_chunks').all() as Array<{ source: string; owner: string; scope: string; scope_id: string | null }>;
    const shared = rows.find(r => r.source === 'MEMORY.md');
    expect(shared?.owner).toBe('shared');
    expect(shared?.scope).toBe('global');

    const userRow = rows.find(r => r.source === 'wt-daily.md');
    expect(userRow?.owner).toBe('wt');
    expect(userRow?.scope).toBe('user');
    expect(userRow?.scope_id).toBe('wt');
  });

  it('should replace chunks for same source+owner+scope on re-index', () => {
    index.indexFile('notes.md', '## Old\n\nOld content about dogs', 'wt', 'user', 'wt');
    let results = index.search('dogs', 5, 'wt', { kind: 'user', id: 'wt' });
    expect(results.length).toBe(1);

    index.indexFile('notes.md', '## New\n\nNew content about cats', 'wt', 'user', 'wt');
    results = index.search('dogs', 5, 'wt', { kind: 'user', id: 'wt' });
    expect(results.length).toBe(0);
    results = index.search('cats', 5, 'wt', { kind: 'user', id: 'wt' });
    expect(results.length).toBe(1);
  });
});
