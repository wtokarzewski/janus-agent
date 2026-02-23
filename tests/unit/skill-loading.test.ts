import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillLoader } from '../../src/skills/skill-loader.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { createTestConfig } from '../helpers/test-fixtures.js';

function createSkillFile(dir: string, name: string, opts: { always?: boolean; description?: string } = {}): string {
  const skillDir = join(dir, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  const content = `---
name: ${name}
description: ${opts.description ?? `Skill ${name}`}
version: 1.0.0
always: ${opts.always ?? false}
---
Instructions for ${name} skill.
Do the ${name} thing.
`;
  const path = join(skillDir, 'SKILL.md');
  writeFileSync(path, content);
  return path;
}

describe('Skill loading with location', () => {
  it('should include location in SkillDefinition', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'janus-skill-test-'));
    createSkillFile(tempDir, 'test-skill');

    const config = createTestConfig({ workspace: { dir: tempDir, skillsDir: 'skills' } });
    const loader = new SkillLoader(config);
    const skills = await loader.loadAll();

    expect(skills.length).toBeGreaterThanOrEqual(1);
    const testSkill = skills.find(s => s.name === 'test-skill');
    expect(testSkill).toBeTruthy();
    expect(testSkill!.location).toContain('SKILL.md');
  });

  it('should include location in SkillSummary', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'janus-skill-test-'));
    createSkillFile(tempDir, 'sum-skill');

    const config = createTestConfig({ workspace: { dir: tempDir, skillsDir: 'skills' } });
    const loader = new SkillLoader(config);
    const summaries = await loader.getSummaries();

    const summary = summaries.find(s => s.name === 'sum-skill');
    expect(summary).toBeTruthy();
    expect(summary!.location).toContain('SKILL.md');
  });
});

describe('Context builder skill stubs', () => {
  it('should emit location attribute in skill stubs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'janus-skill-test-'));
    createSkillFile(tempDir, 'on-demand', { always: false, description: 'On demand skill' });
    createSkillFile(tempDir, 'always-on', { always: true, description: 'Always loaded skill' });

    const config = createTestConfig({ workspace: { dir: tempDir, skillsDir: 'skills' } });
    const skills = new SkillLoader(config);
    const memory = new MemoryStore(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const prompt = await builder.build({
      channel: 'test',
      chatId: 'test',
      tools: [],
    });

    // Both skills should have location attributes
    expect(prompt).toContain('location="');
    // on-demand should be a self-closing tag (no full content)
    expect(prompt).toContain('name="on-demand"');
    expect(prompt).toMatch(/name="on-demand".*\/>/s);
    // always-on should have full instructions
    expect(prompt).toContain('Instructions for always-on skill.');
    // Should contain the instruction block
    expect(prompt).toContain('<instructions>');
    expect(prompt).toContain('read its file with read_file');
  });

  it('should truncate skill list when exceeding char limit', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'janus-skill-test-'));
    // Create many skills
    for (let i = 0; i < 20; i++) {
      createSkillFile(tempDir, `skill-${i}`, { description: 'A'.repeat(200) });
    }

    const config = createTestConfig({
      workspace: { dir: tempDir, skillsDir: 'skills' },
      agent: { maxSkillsPromptChars: 2000 },
    });
    const skills = new SkillLoader(config);
    const memory = new MemoryStore(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const prompt = await builder.build({
      channel: 'test',
      chatId: 'test',
      tools: [],
    });

    expect(prompt).toContain('truncated due to size limit');
  });
});
