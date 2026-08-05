import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { anthropicRefresh } from '../../src/auth/anthropic-oauth.js';
import { codexRefresh } from '../../src/auth/codex-oauth.js';
import type { TokenStore, OAuthTokens } from '../../src/auth/types.js';

function makeStore(initial: Record<string, OAuthTokens> = {}): TokenStore & { saved: OAuthTokens[] } {
  const data: Record<string, OAuthTokens> = { ...initial };
  const saved: OAuthTokens[] = [];
  return {
    saved,
    load: (provider: string) => data[provider],
    save: (provider: string, tokens: OAuthTokens) => {
      data[provider] = tokens;
      saved.push(tokens);
    },
    clear: (provider: string) => { delete data[provider]; },
  } as TokenStore & { saved: OAuthTokens[] };
}

const token = (refresh: string): OAuthTokens => ({
  access_token: `access-for-${refresh}`,
  refresh_token: refresh,
  expires_at: Date.now() + 60_000,
});

/** Token endpoint that resolves only when the test releases it. */
function deferredFetch(response: unknown) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const fn = vi.fn(async (_url: string, init?: { body?: string }) => {
    calls.push(String(init?.body ?? ''));
    await gate;
    return { ok: true, json: async () => response } as unknown as Response;
  });
  return { fn, calls, release };
}

describe.each([
  { name: 'anthropic', refresh: anthropicRefresh },
  { name: 'codex', refresh: codexRefresh },
])('$name refresh is single-flight', ({ name, refresh }) => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('collapses concurrent refreshes into one token exchange', async () => {
    // Refresh tokens are single-use: a second exchange with the same token
    // fails with invalid_grant and leaves the store holding a dead credential.
    const store = makeStore({ [name]: token('rt-1') });
    const gated = deferredFetch({ access_token: 'new-access', refresh_token: 'rt-2', expires_in: 3600 });
    globalThis.fetch = gated.fn as unknown as typeof globalThis.fetch;

    const both = Promise.all([refresh(store), refresh(store)]);
    gated.release();
    const [first, second] = await both;

    expect(gated.calls).toHaveLength(1);
    expect(first.access_token).toBe('new-access');
    expect(second.access_token).toBe('new-access');
  });

  it('refreshes again once the previous exchange finished', async () => {
    const store = makeStore({ [name]: token('rt-1') });
    const gated = deferredFetch({ access_token: 'new-access', refresh_token: 'rt-2', expires_in: 3600 });
    globalThis.fetch = gated.fn as unknown as typeof globalThis.fetch;

    gated.release();
    await refresh(store);
    await refresh(store);

    expect(gated.calls).toHaveLength(2);
    expect(gated.calls[1]).toContain('rt-2'); // used the rotated token, not the dead one
  });

  it('adopts the stored token when another process rotated it first', async () => {
    const store = makeStore({ [name]: token('rt-1') });
    globalThis.fetch = vi.fn(async () => {
      // Simulate the other process winning the race while we were queued.
      store.save(name, token('rt-fresh'));
      return {
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant","error_description":"Refresh token expired"}',
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const result = await refresh(store);

    expect(result.refresh_token).toBe('rt-fresh');
  });

  it('surfaces the failure when nothing rotated the token', async () => {
    const store = makeStore({ [name]: token('rt-1') });
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"Refresh token expired"}',
    } as unknown as Response)) as unknown as typeof globalThis.fetch;

    await expect(refresh(store)).rejects.toThrow(/invalid_grant/);
  });
});
