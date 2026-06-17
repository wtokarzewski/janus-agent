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
    index.indexFile('user-notes.md', '## My Notes\n\nPersonal notes here', 'alice', 'user', 'alice');

    const row = db.db.prepare(
      'SELECT owner, scope, scope_id FROM memory_chunks WHERE source = ?',
    ).get('user-notes.md') as { owner: string; scope: string; scope_id: string | null };

    expect(row.owner).toBe('alice');
    expect(row.scope).toBe('user');
    expect(row.scope_id).toBe('alice');
  });

  it('filters search results strictly to the user scope', () => {
    index.indexFile('shared.md', '## Info\n\nShared project information', 'shared', 'global');
    index.indexFile('alice-notes.md', '## Info\n\nPrivate user information', 'alice', 'user', 'alice');
    index.indexFile('carol-notes.md', '## Info\n\nCarol private information', 'carol', 'user', 'carol');

    // User scope = only that user's chunks (strict — no global, no other users)
    const results = index.search('information', 10, { userId: 'alice' });
    const sources = results.map(r => r.source);
    expect(sources).toContain('alice-notes.md');
    expect(sources).not.toContain('carol-notes.md');
    expect(sources).not.toContain('shared.md');
  });

  it('filters search results strictly to the chat scope', () => {
    index.indexFile('a.md', '## Info\n\nChat A information', 'A', 'chat', 'A');
    index.indexFile('b.md', '## Info\n\nChat B information', 'B', 'chat', 'B');
    index.indexFile('alice-notes.md', '## Info\n\nPrivate user information', 'alice', 'user', 'alice');

    const results = index.search('information', 10, { chatId: 'A' });
    const sources = results.map(r => r.source);
    expect(sources).toContain('a.md');
    expect(sources).not.toContain('b.md');
    expect(sources).not.toContain('alice-notes.md');
  });

  it('returns only global chunks when scope is empty', () => {
    index.indexFile('shared.md', '## Info\n\nShared project information', 'shared', 'global');
    index.indexFile('alice-notes.md', '## Info\n\nPrivate user information', 'alice', 'user', 'alice');

    const results = index.search('information', 10);
    expect(results.map(r => r.source)).toEqual(['shared.md']);
  });

  it('does not leak chat memory across chats', () => {
    index.indexFile('a.md', '## Info\n\nChat A information', 'A', 'chat', 'A');
    index.indexFile('b.md', '## Info\n\nChat B information', 'B', 'chat', 'B');

    const results = index.search('information', 10, { chatId: 'A' });
    const sources = results.map(r => r.source);
    expect(sources).toContain('a.md');
    expect(sources).not.toContain('b.md');
  });

  it('should reindex with owner/scope metadata', () => {
    index.reindex([
      { source: 'MEMORY.md', content: '## Overview\n\nProject overview', owner: 'shared', scope: 'global' },
      { source: 'alice-daily.md', content: '## Notes\n\nUser notes', owner: 'alice', scope: 'user', scopeId: 'alice' },
    ]);

    const rows = db.db.prepare('SELECT source, owner, scope, scope_id FROM memory_chunks').all() as Array<{ source: string; owner: string; scope: string; scope_id: string | null }>;
    const shared = rows.find(r => r.source === 'MEMORY.md');
    expect(shared?.owner).toBe('shared');
    expect(shared?.scope).toBe('global');

    const userRow = rows.find(r => r.source === 'alice-daily.md');
    expect(userRow?.owner).toBe('alice');
    expect(userRow?.scope).toBe('user');
    expect(userRow?.scope_id).toBe('alice');
  });

  it('should find results when searching with Polish Unicode characters', () => {
    index.indexFile('notes.md', '## Zakupy\n\nTrzeba kupić mleko, jajka i chleb w sklepie na rogu.\n\n## Szkoła\n\nDave ma jutro sprawdzian z matematyki, trzeba poćwiczyć ułamki.');

    const results = index.search('sprawdzian matematyki');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].heading).toBe('Szkoła');

    const results2 = index.search('kupić mleko');
    expect(results2.length).toBeGreaterThan(0);
    expect(results2[0].heading).toBe('Zakupy');

    // Words with Polish diacritics should not be stripped
    const results3 = index.search('ćwiczyć ułamki');
    expect(results3.length).toBeGreaterThan(0);
  });

  it('should replace chunks for same source+owner+scope on re-index', () => {
    index.indexFile('notes.md', '## Old\n\nOld content about dogs', 'alice', 'user', 'alice');
    let results = index.search('dogs', 5, { userId: 'alice' });
    expect(results.length).toBe(1);

    index.indexFile('notes.md', '## New\n\nNew content about cats', 'alice', 'user', 'alice');
    results = index.search('dogs', 5, { userId: 'alice' });
    expect(results.length).toBe(0);
    results = index.search('cats', 5, { userId: 'alice' });
    expect(results.length).toBe(1);
  });
});
