/**
 * Tests for ContextBuilder — full vs minimal prompt mode.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
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

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

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

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'minimal',
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

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
    const fullLen = full.staticPart.length + full.dynamicPart.length;
    const minimalLen = minimal.staticPart.length + minimal.dynamicPart.length;

    expect(minimalLen).toBeLessThan(fullLen);
  });
});

describe('ContextBuilder multi-user', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it('should include user section when user is provided', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [{ name: 'exec', description: 'Run command' }],
      user: { userId: 'alice', name: 'Alice' },
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

    expect(prompt).toContain('<user>');
    expect(prompt).toContain('Alice');
    expect(prompt).toContain('userId: alice');
  });

  it('should not include user section when user is not provided', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

    expect(prompt).not.toContain('<user>');
  });

  it('should include scope in session info', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
      scope: { kind: 'user', id: 'alice' },
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

    expect(prompt).toContain('Sender: Alice (alice)');
    expect(prompt).toContain('Scope: user:alice');
  });

  it('should filter tools by user allow list', async () => {
    const { builder } = createBuilder(tempDir, {
      users: [{ id: 'dave', name: 'Dave', identities: [], tools: { allow: ['read_file'] } }],
    });

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [
        { name: 'exec', description: 'Run command' },
        { name: 'read_file', description: 'Read file' },
        { name: 'write_file', description: 'Write file' },
      ],
      user: { userId: 'dave', name: 'Dave' },
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

    expect(prompt).toContain('read_file');
    expect(prompt).not.toContain('- exec:');
    expect(prompt).not.toContain('- write_file:');
  });

  it('should filter tools by user deny list', async () => {
    const { builder } = createBuilder(tempDir, {
      users: [{ id: 'alice', name: 'W', identities: [], tools: { deny: ['exec'] } }],
    });

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [
        { name: 'exec', description: 'Run command' },
        { name: 'read_file', description: 'Read file' },
      ],
      user: { userId: 'alice', name: 'W' },
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

    expect(prompt).not.toContain('- exec:');
    expect(prompt).toContain('read_file');
  });

  it('should include family scope in session info for group chats', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '-100123',
      tools: [],
      scope: { kind: 'family', id: 'family_alice' },
    });
    const prompt = staticPart + '\n\n---\n\n' + dynamicPart;

    expect(prompt).toContain('Scope: family:family_alice');
  });
});

describe('ContextBuilder per-user overrides', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it('should merge global and per-user AGENTS.md', async () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Global\nBe helpful.');
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'AGENTS.md'), '# Alice\nAlways reply in Polish.');

    const { builder } = createBuilder(tempDir);
    const { staticPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(staticPart).toContain('<agents>');
    expect(staticPart).toContain('Be helpful');
    expect(staticPart).toContain('Always reply in Polish');
    expect(staticPart).toContain('user-specific rules for alice');
  });

  it('should load per-user AGENTS.md without global', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'AGENTS.md'), '# Alice\nBe concise.');

    const { builder } = createBuilder(tempDir);
    const { staticPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(staticPart).toContain('<agents>');
    expect(staticPart).toContain('Be concise');
  });

  it('should not load per-user AGENTS.md when no user provided', async () => {
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Global\nBe helpful.');
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'AGENTS.md'), '# Alice\nSecret rules.');

    const { builder } = createBuilder(tempDir);
    const { staticPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [],
    });

    expect(staticPart).toContain('Be helpful');
    expect(staticPart).not.toContain('Secret rules');
  });

  it('should merge global and per-user HEARTBEAT.md', async () => {
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), '## Backup\n- schedule: every 1d\n- task: Run backup');
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'HEARTBEAT.md'), '## Briefing\n- schedule: at 08:00\n- task: Morning news');

    const { builder } = createBuilder(tempDir);
    const { staticPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(staticPart).toContain('<heartbeat>');
    expect(staticPart).toContain('Run backup');
    expect(staticPart).toContain('Morning news');
    expect(staticPart).toContain('heartbeat tasks for alice');
  });

  it('should load per-user HEARTBEAT.md without global', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'HEARTBEAT.md'), '## Check\n- schedule: every 30m\n- task: Health check');

    const { builder } = createBuilder(tempDir);
    const { staticPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(staticPart).toContain('<heartbeat>');
    expect(staticPart).toContain('Health check');
  });
});

describe('ContextBuilder background mode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    writeFileSync(join(tempDir, '.janus', 'EGO.md'), '# Ego\nI am Janus.');
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Agent Rules\nBe helpful.');
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), '# Tasks\n- every 5m: ping');
    writeFileSync(join(tempDir, 'JANUS.md'), '# Project\nTest project.');
  });

  it('background mode keeps identity, EGO, AGENTS, skills', async () => {
    const { builder } = createBuilder(tempDir);
    const { staticPart, dynamicPart } = await builder.build({
      channel: 'system', chatId: 'cron:1',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'background',
    });
    const prompt = staticPart + '\n' + dynamicPart;
    expect(prompt).toContain('<identity>');
    expect(prompt).toContain('<ego>');
    expect(prompt).toContain('<agents>');
  });

  it('background mode skips HEARTBEAT, JANUS, memory, learner', async () => {
    const { builder } = createBuilder(tempDir);
    const { staticPart, dynamicPart } = await builder.build({
      channel: 'system', chatId: 'cron:1',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'background',
      userMessage: 'remind about meeting',
    });
    const prompt = staticPart + '\n' + dynamicPart;
    expect(prompt).not.toContain('<heartbeat>');
    expect(prompt).not.toContain('<project>');
    expect(prompt).not.toContain('<memory>');
    expect(prompt).not.toContain('<learner>');
  });

  it('background mode produces shorter prompt than full mode', async () => {
    const { builder } = createBuilder(tempDir);
    const opts = {
      channel: 'system', chatId: 'cron:1',
      tools: [{ name: 'exec', description: 'Run command' }],
    };
    const full = await builder.build({ ...opts, mode: 'full' });
    const bg = await builder.build({ ...opts, mode: 'background' });
    const fullLen = full.staticPart.length + full.dynamicPart.length;
    const bgLen = bg.staticPart.length + bg.dynamicPart.length;
    expect(bgLen).toBeLessThan(fullLen);
  });
});

describe('ContextBuilder static/dynamic split', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Agent Rules\nBe helpful.');
    writeFileSync(join(tempDir, 'JANUS.md'), '# Project\nTest project.');
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), '# Heartbeat\n- every 5m: check status');
    const egoDir = join(tempDir, '.janus');
    mkdirSync(egoDir, { recursive: true });
    writeFileSync(join(egoDir, 'EGO.md'), '# EGO\nI am Janus.');
  });

  it('staticPart contains identity, EGO, AGENTS, HEARTBEAT, JANUS', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });

    expect(staticPart).toContain('<identity>');
    expect(staticPart).toContain('<ego>');
    expect(staticPart).toContain('<agents>');
    expect(staticPart).toContain('<heartbeat>');
    expect(staticPart).toContain('<project>');
  });

  it('staticPart does NOT contain timestamp', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });

    // Identity should not have "Current time:" — timestamp moved to dynamic session block
    expect(staticPart).not.toMatch(/Current time:/);
    expect(staticPart).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('dynamicPart contains session info with date AND time', async () => {
    const { builder } = createBuilder(tempDir);

    const { dynamicPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });

    expect(dynamicPart).toContain('<session>');
    expect(dynamicPart).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    expect(dynamicPart).toMatch(/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('dynamicPart contains previous_summary when provided', async () => {
    const { builder } = createBuilder(tempDir);

    const { dynamicPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [],
      summary: 'We discussed the architecture changes.',
    });

    expect(dynamicPart).toContain('<previous_summary>');
    expect(dynamicPart).toContain('We discussed the architecture changes.');
  });

  it('dynamicPart does NOT contain EGO, AGENTS, HEARTBEAT, JANUS', async () => {
    const { builder } = createBuilder(tempDir);

    const { dynamicPart } = await builder.build({
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });

    expect(dynamicPart).not.toContain('<ego>');
    expect(dynamicPart).not.toContain('<agents>');
    expect(dynamicPart).not.toContain('<heartbeat>');
    expect(dynamicPart).not.toContain('<project>');
  });

  it('dynamicPart contains user section when user provided', async () => {
    const { builder } = createBuilder(tempDir);

    const { staticPart, dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '123',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    // User section is dynamic (profile can change)
    expect(dynamicPart).toContain('<user>');
    expect(dynamicPart).toContain('Alice');
    // Static part should NOT have user section
    expect(staticPart).not.toContain('<user>');
  });

  it('staticPart is stable across consecutive calls with same config', async () => {
    const { builder } = createBuilder(tempDir);

    const opts = {
      channel: 'cli',
      chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full' as const,
    };

    const first = await builder.build(opts);
    const second = await builder.build(opts);

    // Static parts should be identical (no timestamp or other dynamic content)
    expect(first.staticPart).toBe(second.staticPart);
  });
});

describe('ContextBuilder skill channel preferences', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it('injects <your_chats> when user has known chats in database', async () => {
    const { Database } = await import('../../src/db/database.js');
    const { upsertKnownChat } = await import('../../src/db/known-chats.js');
    const dbPath = join(tempDir, '.janus', 'test.db');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const db = new Database(dbPath);

    upsertKnownChat(db, {
      userId: 'alice',
      channel: 'telegram',
      chatId: '111',
      chatName: 'Alice DM',
      chatType: 'private',
    });
    upsertKnownChat(db, {
      userId: 'alice',
      channel: 'telegram',
      chatId: '-1001234567890',
      chatName: 'Dieta',
      chatType: 'supergroup',
    });

    const config = createTestConfig({
      workspace: { dir: tempDir },
      users: [{ id: 'alice', name: 'Alice', identities: [{ channel: 'telegram', channelUserId: '111' }] }],
    });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config, database: db });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).toContain('<your_chats>');
    expect(dynamicPart).toContain('telegram:111');
    expect(dynamicPart).toContain('Alice DM');
    expect(dynamicPart).toContain('telegram:-1001234567890');
    expect(dynamicPart).toContain('Dieta');

    db.close();
  });

  it('injects <skill_channels> when user has preferences', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), JSON.stringify({
      'diet-tracker': {
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
      },
    }));

    const config = createTestConfig({
      workspace: { dir: tempDir },
      users: [{ id: 'alice', name: 'Alice', identities: [{ channel: 'telegram', channelUserId: '111' }] }],
    });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).toContain('<skill_channels>');
    expect(dynamicPart).toContain('diet-tracker');
    expect(dynamicPart).toContain('telegram:-1001234567890');
    expect(dynamicPart).toContain('Dieta');
  });

  it('omits <your_chats> when no database provided', async () => {
    const config = createTestConfig({ workspace: { dir: tempDir } });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).not.toContain('<your_chats>');
  });

  it('omits <skill_channels> when user has no preferences file', async () => {
    const config = createTestConfig({ workspace: { dir: tempDir } });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).not.toContain('<skill_channels>');
  });
});
