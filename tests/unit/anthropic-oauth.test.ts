import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OAuthTokens, TokenStore } from '../../src/auth/types.js';

function createMockStore(data: Record<string, OAuthTokens> = {}): TokenStore {
  return {
    load: vi.fn((provider: string) => data[provider] ?? null),
    save: vi.fn((provider: string, tokens: OAuthTokens) => { data[provider] = tokens; }),
    clear: vi.fn((provider: string) => { delete data[provider]; }),
  };
}

describe('Anthropic OAuth', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('getAnthropicToken', () => {
    it('returns existing token when not expired', async () => {
      const { getAnthropicToken } = await import('../../src/auth/anthropic-oauth.js');
      const store = createMockStore({
        anthropic: {
          access_token: 'valid-token',
          refresh_token: 'rt',
          expires_at: Date.now() + 3600_000, // 1 hour from now
        },
      });

      const token = await getAnthropicToken(store);
      expect(token).toBe('valid-token');
    });

    it('throws when not logged in', async () => {
      const { getAnthropicToken } = await import('../../src/auth/anthropic-oauth.js');
      const store = createMockStore();

      await expect(getAnthropicToken(store)).rejects.toThrow('Not logged in');
    });

    it('refreshes token when about to expire', async () => {
      const { getAnthropicToken } = await import('../../src/auth/anthropic-oauth.js');
      const store = createMockStore({
        anthropic: {
          access_token: 'old-token',
          refresh_token: 'rt-123',
          expires_at: Date.now() + 60_000, // 1 min — within 5 min buffer
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          refresh_token: 'rt-456',
          expires_in: 3600,
        }),
      });

      const token = await getAnthropicToken(store);
      expect(token).toBe('new-token');
      expect(store.save).toHaveBeenCalled();
    });
  });

  describe('anthropicRefresh', () => {
    it('throws when no refresh token', async () => {
      const { anthropicRefresh } = await import('../../src/auth/anthropic-oauth.js');
      const store = createMockStore();
      await expect(anthropicRefresh(store)).rejects.toThrow('No Anthropic refresh token');
    });

    it('handles failed refresh', async () => {
      const { anthropicRefresh } = await import('../../src/auth/anthropic-oauth.js');
      const store = createMockStore({
        anthropic: { access_token: 'at', refresh_token: 'rt', expires_at: 0 },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(anthropicRefresh(store)).rejects.toThrow('Token refresh failed (401)');
    });

    it('saves refreshed tokens', async () => {
      const { anthropicRefresh } = await import('../../src/auth/anthropic-oauth.js');
      const store = createMockStore({
        anthropic: { access_token: 'old', refresh_token: 'rt-old', expires_at: 0 },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-at',
          refresh_token: 'refreshed-rt',
          expires_in: 7200,
        }),
      });

      const tokens = await anthropicRefresh(store);
      expect(tokens.access_token).toBe('refreshed-at');
      expect(tokens.refresh_token).toBe('refreshed-rt');
      expect(store.save).toHaveBeenCalledWith('anthropic', expect.objectContaining({
        access_token: 'refreshed-at',
      }));
    });
  });
});
