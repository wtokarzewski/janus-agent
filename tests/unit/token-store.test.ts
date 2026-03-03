import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileTokenStore } from '../../src/auth/token-store.js';
import type { OAuthTokens } from '../../src/auth/types.js';

describe('FileTokenStore', () => {
  let dir: string;
  let store: FileTokenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'janus-token-test-'));
    store = new FileTokenStore(join(dir, 'auth.json'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tokens: OAuthTokens = {
    access_token: 'at-123',
    refresh_token: 'rt-456',
    expires_at: Date.now() + 3600_000,
  };

  it('load returns null when file does not exist', () => {
    expect(store.load('anthropic')).toBeNull();
  });

  it('save + load round-trip', () => {
    store.save('anthropic', tokens);
    const loaded = store.load('anthropic');
    expect(loaded).toEqual(tokens);
  });

  it('stores multiple providers independently', () => {
    const codexTokens: OAuthTokens = { ...tokens, access_token: 'codex-at', account_id: 'acc-789' };
    store.save('anthropic', tokens);
    store.save('codex', codexTokens);

    expect(store.load('anthropic')?.access_token).toBe('at-123');
    expect(store.load('codex')?.access_token).toBe('codex-at');
    expect(store.load('codex')?.account_id).toBe('acc-789');
  });

  it('clear removes provider entry', () => {
    store.save('anthropic', tokens);
    store.clear('anthropic');
    expect(store.load('anthropic')).toBeNull();
  });

  it('clear is safe when file does not exist', () => {
    expect(() => store.clear('anthropic')).not.toThrow();
  });

  it('file has 0o600 permissions', () => {
    store.save('anthropic', tokens);
    const stat = statSync(join(dir, 'auth.json'));
    // 0o600 = owner read+write only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('save overwrites existing tokens for same provider', () => {
    store.save('anthropic', tokens);
    const updated = { ...tokens, access_token: 'at-updated' };
    store.save('anthropic', updated);
    expect(store.load('anthropic')?.access_token).toBe('at-updated');
  });
});
