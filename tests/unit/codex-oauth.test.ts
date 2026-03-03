import { describe, it, expect, vi, afterEach } from 'vitest';
import type { OAuthTokens, TokenStore } from '../../src/auth/types.js';

function createMockStore(data: Record<string, OAuthTokens> = {}): TokenStore {
  return {
    load: vi.fn((provider: string) => data[provider] ?? null),
    save: vi.fn((provider: string, tokens: OAuthTokens) => { data[provider] = tokens; }),
    clear: vi.fn((provider: string) => { delete data[provider]; }),
  };
}

describe('Codex OAuth', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('decodeJwt', () => {
    it('decodes JWT payload', async () => {
      const { decodeJwt } = await import('../../src/auth/codex-oauth.js');
      // Create a valid JWT with known payload
      const payload = { sub: 'user-123', name: 'Test User' };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const jwt = `header.${encodedPayload}.signature`;

      const decoded = decodeJwt(jwt);
      expect(decoded.sub).toBe('user-123');
      expect(decoded.name).toBe('Test User');
    });

    it('throws on invalid JWT', async () => {
      const { decodeJwt } = await import('../../src/auth/codex-oauth.js');
      expect(() => decodeJwt('not-a-jwt')).toThrow('Invalid JWT');
    });
  });

  describe('getAccountId', () => {
    it('extracts account_id from JWT', async () => {
      const { getAccountId } = await import('../../src/auth/codex-oauth.js');
      const payload = {
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acc-456',
        },
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const jwt = `h.${encodedPayload}.s`;

      expect(getAccountId(jwt)).toBe('acc-456');
    });

    it('returns undefined when claim is missing', async () => {
      const { getAccountId } = await import('../../src/auth/codex-oauth.js');
      const payload = { sub: 'user' };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const jwt = `h.${encodedPayload}.s`;

      expect(getAccountId(jwt)).toBeUndefined();
    });

    it('returns undefined for invalid JWT', async () => {
      const { getAccountId } = await import('../../src/auth/codex-oauth.js');
      expect(getAccountId('bad')).toBeUndefined();
    });
  });

  describe('getCodexToken', () => {
    it('returns existing token when not expired', async () => {
      const { getCodexToken } = await import('../../src/auth/codex-oauth.js');
      const store = createMockStore({
        codex: {
          access_token: 'valid-token',
          refresh_token: 'rt',
          expires_at: Date.now() + 3600_000,
          account_id: 'acc-123',
        },
      });

      const result = await getCodexToken(store);
      expect(result.token).toBe('valid-token');
      expect(result.accountId).toBe('acc-123');
    });

    it('throws when not logged in', async () => {
      const { getCodexToken } = await import('../../src/auth/codex-oauth.js');
      const store = createMockStore();
      await expect(getCodexToken(store)).rejects.toThrow('Not logged in');
    });

    it('refreshes token when about to expire', async () => {
      const { getCodexToken } = await import('../../src/auth/codex-oauth.js');

      // Build a mock JWT with account_id for the refreshed token
      const payload = {
        'https://api.openai.com/auth': { chatgpt_account_id: 'new-acc' },
      };
      const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const newJwt = `h.${encodedPayload}.s`;

      const store = createMockStore({
        codex: {
          access_token: 'old',
          refresh_token: 'rt-old',
          expires_at: Date.now() + 60_000, // within buffer
          account_id: 'old-acc',
        },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: newJwt,
          refresh_token: 'rt-new',
          expires_in: 3600,
        }),
      });

      const result = await getCodexToken(store);
      expect(result.token).toBe(newJwt);
      expect(result.accountId).toBe('new-acc');
    });
  });

  describe('codexRefresh', () => {
    it('throws when no refresh token', async () => {
      const { codexRefresh } = await import('../../src/auth/codex-oauth.js');
      const store = createMockStore();
      await expect(codexRefresh(store)).rejects.toThrow('No Codex refresh token');
    });

    it('handles failed refresh', async () => {
      const { codexRefresh } = await import('../../src/auth/codex-oauth.js');
      const store = createMockStore({
        codex: { access_token: 'at', refresh_token: 'rt', expires_at: 0 },
      });

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      await expect(codexRefresh(store)).rejects.toThrow('Token refresh failed (403)');
    });
  });
});
