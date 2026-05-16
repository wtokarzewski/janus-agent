import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYAML } from 'yaml';

describe('stock-watcher SKILL.md frontmatter', () => {
  const skillPath = join(process.cwd(), 'skills', 'stock-watcher', 'SKILL.md');
  const content = readFileSync(skillPath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) throw new Error('No frontmatter found');
  const frontmatter = parseYAML(match[1]) as Record<string, unknown>;

  it('is at version 2.0.0', () => {
    expect(frontmatter.version).toBe('2.0.0');
  });

  it('declares pinned: stocks/watchlist.txt', () => {
    expect(frontmatter.pinned).toEqual(['stocks/watchlist.txt']);
  });

  it('does not reference the legacy global storage path', () => {
    expect(content).not.toMatch(/~\/?\.janus\/stock-watcher/);
  });

  it('references the per-user storage path', () => {
    expect(content).toContain('.janus/users/{userId}/files/stocks/watchlist.txt');
  });

  it('has the state uncertainty rule', () => {
    expect(content).toContain('State uncertainty');
  });

  it('script examples include --user {userId}', () => {
    expect(content).toMatch(/python3 scripts\/add_stock\.py --user/);
    expect(content).toMatch(/python3 scripts\/list_stocks\.py --user/);
  });
});
