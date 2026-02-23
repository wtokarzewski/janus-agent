/**
 * Tests for ContextBuilder — full vs minimal prompt mode.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { SkillLoader } from '../../src/skills/skill-loader.js';
import { createTestConfig, createTempDir } from '../helpers/test-fixtures.js';
function createBuilder(tempDir: string, configOverrides?: Partial<Record<string, unknown>>) {
  const config = createTestConfig({ workspace: { dir: tempDir }, ...configOverrides });
  const memory = new MemoryStore(config);
  const skills = new SkillLoader(config);
  return { builder: new ContextBuilder({ skills, memory, config }), config };
}

describe('ContextBuilder mode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Create bootstrap files so they can be included/excluded
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Agent Rules\nBe helpful and concise.');
    writeFileSync(join(tempDir, 'JANUS.md'), '# Project\nThis is a test project.');
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), '# Heartbeat\n- every 5m: check status');
  });

  it('full mode includes agents, project, and heartbeat sections', async () => {
    const { builder } = createBuilder(tempDir);

    const prompt = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });

    expect(prompt).toContain('<agents>');
    expect(prompt).toContain('Agent Rules');
    expect(prompt).toContain('<project>');
    expect(prompt).toContain('test project');
    expect(prompt).toContain('<heartbeat>');
    expect(prompt).toContain('check status');
    expect(prompt).toContain('<identity>');
  });

  it('minimal mode skips agents, project, heartbeat, and memory sections', async () => {
    const { builder } = createBuilder(tempDir);

    const prompt = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'minimal',
    });

    expect(prompt).not.toContain('<agents>');
    expect(prompt).not.toContain('<project>');
    expect(prompt).not.toContain('<heartbeat>');
    expect(prompt).not.toContain('<memory>');
    // Identity and session should still be present
    expect(prompt).toContain('<identity>');
    expect(prompt).toContain('<session>');
  });

  it('minimal mode produces a shorter prompt than full mode', async () => {
    const { builder } = createBuilder(tempDir);

    const opts = {
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
    };

    const full = await builder.build({ ...opts, mode: 'full' });
    const minimal = await builder.build({ ...opts, mode: 'minimal' });

    expect(minimal.length).toBeLessThan(full.length);
  });
});

describe('ContextBuilder multi-user', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it('should include user section when user is provided', async () => {
    const { builder } = createBuilder(tempDir);

    const prompt = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [{ name: 'exec', description: 'Run command' }],
      user: { userId: 'wt', name: 'Wojciech' },
    });

    expect(prompt).toContain('<user>');
    expect(prompt).toContain('Wojciech');
    expect(prompt).toContain('userId: wt');
  });

  it('should not include user section when user is not provided', async () => {
    const { builder } = createBuilder(tempDir);

    const prompt = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
    });

    expect(prompt).not.toContain('<user>');
  });

  it('should include scope in session info', async () => {
    const { builder } = createBuilder(tempDir);

    const prompt = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'wt', name: 'Wojciech' },
      scope: { kind: 'user', id: 'wt' },
    });

    expect(prompt).toContain('User: wt');
    expect(prompt).toContain('Scope: user:wt');
  });

  it('should filter tools by user allow list', async () => {
    const { builder } = createBuilder(tempDir, {
      users: [{ id: 'zuzia', name: 'Zuzia', identities: [], tools: { allow: ['read_file'] } }],
    });

    const prompt = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [
        { name: 'exec', description: 'Run command' },
        { name: 'read_file', description: 'Read file' },
        { name: 'write_file', description: 'Write file' },
      ],
      user: { userId: 'zuzia', name: 'Zuzia' },
    });

    expect(prompt).toContain('read_file');
    expect(prompt).not.toContain('- exec:');
    expect(prompt).not.toContain('- write_file:');
  });

  it('should filter tools by user deny list', async () => {
    const { builder } = createBuilder(tempDir, {
      users: [{ id: 'wt', name: 'W', identities: [], tools: { deny: ['exec'] } }],
    });

    const prompt = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [
        { name: 'exec', description: 'Run command' },
        { name: 'read_file', description: 'Read file' },
      ],
      user: { userId: 'wt', name: 'W' },
    });

    expect(prompt).not.toContain('- exec:');
    expect(prompt).toContain('read_file');
  });

  it('should include family scope in session info for group chats', async () => {
    const { builder } = createBuilder(tempDir);

    const prompt = await builder.build({
      channel: 'telegram',
      chatId: '-100123',
      tools: [],
      scope: { kind: 'family', id: 'family_wt' },
    });

    expect(prompt).toContain('Scope: family:family_wt');
  });
});
