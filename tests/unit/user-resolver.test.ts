import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveUser, loadProfileMd, findUserProfile } from '../../src/users/user-resolver.js';
import { JanusConfigSchema, type JanusConfig } from '../../src/config/schema.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeConfig(overrides?: Partial<Record<string, unknown>>): JanusConfig {
  return JanusConfigSchema.parse({
    ...overrides,
  });
}

describe('resolveUser', () => {
  it('should return null when no users configured (single-user mode)', () => {
    const config = makeConfig({ users: [] });
    const result = resolveUser('telegram', '123', 'alice_t', config);
    expect(result).toBeNull();
  });

  it('should match by channelUserId (stable)', () => {
    const config = makeConfig({
      users: [{
        id: 'user1',
        name: 'Alice',
        identities: [{ channel: 'telegram', channelUserId: '123456789', channelUsername: 'alice_t' }],
      }],
    });
    const result = resolveUser('telegram', '123456789', 'alice_t', config);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user1');
    expect(result!.name).toBe('Alice');
    expect(result!.identity.channelUserId).toBe('123456789');
  });

  it('should fallback to channelUsername when channelUserId not matched', () => {
    const config = makeConfig({
      users: [{
        id: 'user1',
        name: 'Alice',
        identities: [{ channel: 'telegram', channelUsername: 'alice_t' }],
      }],
    });
    const result = resolveUser('telegram', '999', 'alice_t', config);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('user1');
  });

  it('should return null when no match found', () => {
    const config = makeConfig({
      users: [{
        id: 'user1',
        name: 'Alice',
        identities: [{ channel: 'telegram', channelUserId: '123' }],
      }],
    });
    const result = resolveUser('telegram', '999', 'unknown', config);
    expect(result).toBeNull();
  });

  it('should not match across channels', () => {
    const config = makeConfig({
      users: [{
        id: 'user1',
        name: 'Alice',
        identities: [{ channel: 'discord', channelUserId: '123' }],
      }],
    });
    const result = resolveUser('telegram', '123', undefined, config);
    expect(result).toBeNull();
  });

  it('should match first user when multiple users configured', () => {
    const config = makeConfig({
      users: [
        {
          id: 'user1',
          name: 'Alice',
          identities: [{ channel: 'telegram', channelUserId: '111' }],
        },
        {
          id: 'bob',
          name: 'Bob',
          identities: [{ channel: 'telegram', channelUserId: '222' }],
        },
      ],
    });
    const r1 = resolveUser('telegram', '111', undefined, config);
    expect(r1!.userId).toBe('user1');
    const r2 = resolveUser('telegram', '222', undefined, config);
    expect(r2!.userId).toBe('bob');
  });

  it('should handle undefined channelUserId and channelUsername', () => {
    const config = makeConfig({
      users: [{
        id: 'user1',
        name: 'Alice',
        identities: [{ channel: 'telegram', channelUserId: '123' }],
      }],
    });
    const result = resolveUser('telegram', undefined, undefined, config);
    expect(result).toBeNull();
  });
});

describe('loadProfileMd', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `janus-test-profile-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load PROFILE.md from custom path', async () => {
    const profilePath = join(tempDir, 'PROFILE.md');
    writeFileSync(profilePath, 'You are Alice. Be concise.');
    const result = await loadProfileMd('user1', profilePath);
    expect(result).toBe('You are Alice. Be concise.');
  });

  it('should return null when file does not exist', async () => {
    const result = await loadProfileMd('nonexistent', join(tempDir, 'nope.md'));
    expect(result).toBeNull();
  });

  it('should return null when no home and no custom path', async () => {
    const origHome = process.env.HOME;
    process.env.HOME = '';
    const result = await loadProfileMd('user1');
    process.env.HOME = origHome;
    expect(result).toBeNull();
  });
});

describe('findUserProfile', () => {
  it('should find user by id', () => {
    const config = makeConfig({
      users: [
        { id: 'user1', name: 'Alice', identities: [] },
        { id: 'bob', name: 'Bob', identities: [] },
      ],
    });
    const profile = findUserProfile('bob', config);
    expect(profile).toBeDefined();
    expect(profile!.name).toBe('Bob');
  });

  it('should return undefined when not found', () => {
    const config = makeConfig({ users: [{ id: 'user1', name: 'A', identities: [] }] });
    expect(findUserProfile('unknown', config)).toBeUndefined();
  });
});
