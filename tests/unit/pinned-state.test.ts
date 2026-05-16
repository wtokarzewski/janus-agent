import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPinnedStateSection } from '../../src/context/pinned-state.js';
import type { SkillDefinition } from '../../src/skills/types.js';

const skill = (name: string, pinned: string[]): SkillDefinition => ({
  name,
  description: '',
  version: '1.0.0',
  always: false,
  pinned,
  instructions: '',
  location: '/fake',
});

describe('buildPinnedStateSection', () => {
  let workspaceDir: string;
  let userFilesDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'pinned-'));
    userFilesDir = join(workspaceDir, '.janus', 'users', 'u1', 'files');
    mkdirSync(userFilesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('returns null when no skills have pinned files', async () => {
    const result = await buildPinnedStateSection({
      skills: [skill('a', []), skill('b', [])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result).toBeNull();
  });

  it('renders file content when file exists', async () => {
    writeFileSync(join(userFilesDir, 'profile.md'), 'TARGET: 75kg\n');
    const result = await buildPinnedStateSection({
      skills: [skill('diet-tracker', ['profile.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result).not.toBeNull();
    expect(result!.xml).toContain('<pinned_skill_state>');
    expect(result!.xml).toContain('skill="diet-tracker"');
    expect(result!.xml).toContain('path="profile.md"');
    expect(result!.xml).toContain('TARGET: 75kg');
    // pinnedPaths stores realpathSync-resolved paths — use realpathSync for comparison
    // so this test passes on macOS where /var → /private/var via symlink.
    expect(result!.pinnedPaths.has(realpathSync(join(userFilesDir, 'profile.md')))).toBe(true);
  });

  it('substitutes {today} in path', async () => {
    mkdirSync(join(userFilesDir, 'food-diary'));
    writeFileSync(join(userFilesDir, 'food-diary', '2026-05-14.md'), 'breakfast: eggs\n');
    const result = await buildPinnedStateSection({
      skills: [skill('diet-tracker', ['food-diary/{today}.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('path="food-diary/2026-05-14.md"');
    expect(result!.xml).toContain('breakfast: eggs');
  });

  it('renders placeholder for missing file', async () => {
    const result = await buildPinnedStateSection({
      skills: [skill('diet-tracker', ['food-diary/{today}.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('status="missing"');
    expect(result!.xml).toContain('file does not exist yet');
    expect(result!.pinnedPaths.size).toBe(1);
  });

  it('substitutes {userId}', async () => {
    mkdirSync(join(userFilesDir, 'data'), { recursive: true });
    writeFileSync(join(userFilesDir, 'data', 'u1.json'), '{}\n');
    const result = await buildPinnedStateSection({
      skills: [skill('demo', ['data/{userId}.json'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('path="data/u1.json"');
  });

  it('concatenates files across multiple skills', async () => {
    writeFileSync(join(userFilesDir, 'a.md'), 'AAA');
    writeFileSync(join(userFilesDir, 'b.md'), 'BBB');
    const result = await buildPinnedStateSection({
      skills: [skill('one', ['a.md']), skill('two', ['b.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result!.xml).toContain('AAA');
    expect(result!.xml).toContain('BBB');
    expect(result!.xml).toContain('skill="one"');
    expect(result!.xml).toContain('skill="two"');
  });

  it('blocks path escape via ..', async () => {
    // '../../outside.md' relative to .janus/users/u1/files/ resolves to .janus/users/outside.md
    writeFileSync(join(workspaceDir, '.janus', 'users', 'outside.md'), 'leaked');
    const result = await buildPinnedStateSection({
      skills: [skill('bad', ['../../outside.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    expect(result).toBeNull();
  });

  it('blocks path escape via symlink', async () => {
    // Skip on Windows where symlinkSync may require elevated privileges
    const outsidePath = join(workspaceDir, 'secret.md');
    const symlinkPath = join(workspaceDir, '.janus', 'users', 'u1', 'files', 'sneaky.md');
    writeFileSync(outsidePath, 'leaked');
    try {
      symlinkSync(outsidePath, symlinkPath);
    } catch {
      // symlinkSync can fail on Windows without admin — skip
      return;
    }
    const result = await buildPinnedStateSection({
      skills: [skill('bad', ['sneaky.md'])],
      workspaceDir,
      userId: 'u1',
      today: '2026-05-14',
      yesterday: '2026-05-13',
    });
    // Either null (all files blocked) or xml must not contain 'leaked'
    if (result !== null) {
      expect(result.xml).not.toContain('leaked');
    } else {
      expect(result).toBeNull();
    }
  });
});
