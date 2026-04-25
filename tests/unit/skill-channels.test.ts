import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillChannels } from '../../src/users/user-resolver.js';

describe('loadSkillChannels', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'janus-skill-channels-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', async () => {
    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({});
  });

  it('loads skill channel preferences from JSON file', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), JSON.stringify({
      'diet-tracker': {
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
        setAt: '2026-04-25T10:00:00Z',
      },
    }));

    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({
      'diet-tracker': {
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
        setAt: '2026-04-25T10:00:00Z',
      },
    });
  });

  it('returns empty object for malformed JSON', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), 'not json');

    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({});
  });

  it('returns empty object for non-object JSON', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), '"just a string"');

    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({});
  });
});
