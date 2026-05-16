import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStateUncertaintySection } from '../../src/commands/update.js';

describe('ensureStateUncertaintySection', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'update-agents-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('appends section when AGENTS.md does not contain it', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# AGENTS.md\n\nSome existing content.\n');
    await ensureStateUncertaintySection(cwd);
    const content = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('## State uncertainty');
    expect(content).toContain('Never explain confusion in terms of memory limits');
  });

  it('does not duplicate when section already present', async () => {
    const original = '# AGENTS.md\n\n## State uncertainty\n\nAlready here.\n';
    writeFileSync(join(cwd, 'AGENTS.md'), original);
    await ensureStateUncertaintySection(cwd);
    const content = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content).toBe(original); // unchanged
  });

  it('skips silently when AGENTS.md does not exist', async () => {
    // No AGENTS.md created
    await ensureStateUncertaintySection(cwd);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });

  it('handles file ending without trailing newline', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# AGENTS.md\n\nNo trailing newline'); // no \n at end
    await ensureStateUncertaintySection(cwd);
    const content = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('## State uncertainty');
    // Section should be separated by blank line, not jammed against previous content
    expect(content).toMatch(/No trailing newline\s*\n\s*\n## State uncertainty/);
  });

  it('runs cross-platform (forward slashes in path)', async () => {
    // sanity check that no shell commands are used; the cwd is a real temp dir
    writeFileSync(join(cwd, 'AGENTS.md'), '# x\n');
    await expect(ensureStateUncertaintySection(cwd)).resolves.not.toThrow();
  });
});
