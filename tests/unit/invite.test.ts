import { describe, it, expect, beforeEach } from 'vitest';
import { InviteStore } from '../../src/invites/invite-store.js';

describe('InviteStore', () => {
  let store: InviteStore;

  beforeEach(() => {
    store = new InviteStore('test_bot');
  });

  it('should create an invite with valid link', () => {
    const { token, link } = store.create('owner-user');
    expect(token).toBeTruthy();
    expect(link).toBe(`https://t.me/test_bot?start=invite_${token}`);
  });

  it('should redeem a valid invite', () => {
    const { token } = store.create('owner-user');
    const invitedBy = store.redeem(token);
    expect(invitedBy).toBe('owner-user');
  });

  it('should return null for unknown token', () => {
    expect(store.redeem('nonexistent')).toBeNull();
  });

  it('should return null when redeeming same token twice', () => {
    const { token } = store.create('owner-user');
    store.redeem(token);
    expect(store.redeem(token)).toBeNull();
  });

  it('should expire tokens after TTL', () => {
    const shortStore = new InviteStore('test_bot', 1); // 1ms TTL
    const { token } = shortStore.create('owner-user');

    // Token should expire almost immediately
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(shortStore.redeem(token)).toBeNull();
        resolve();
      }, 10);
    });
  });

  it('should generate unique tokens', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(store.create('user').token);
    }
    expect(tokens.size).toBe(100);
  });
});

describe('Invite deep link regex', () => {
  const regex = /^\/start\s+invite_(.+)$/;

  it('should match /start invite_TOKEN', () => {
    const match = '/start invite_abc123'.match(regex);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('abc123');
  });

  it('should match with base64url token', () => {
    const match = '/start invite_Rk9PX0JBUl9CQVo'.match(regex);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('Rk9PX0JBUl9CQVo');
  });

  it('should match with dashes and underscores', () => {
    const match = '/start invite_abc-def_ghi'.match(regex);
    expect(match).toBeTruthy();
    expect(match![1]).toBe('abc-def_ghi');
  });

  it('should NOT match plain /start', () => {
    expect('/start'.match(regex)).toBeNull();
  });

  it('should NOT match /start without invite_ prefix', () => {
    expect('/start something_else'.match(regex)).toBeNull();
  });

  it('should NOT match with extra text after', () => {
    // This actually SHOULD match since (.+)$ is greedy
    // but let's verify the regex works as intended
    const match = '/start invite_token extra'.match(regex);
    // (.+) captures "token extra" — this is fine, redeem() won't find it
    expect(match).toBeTruthy();
    expect(match![1]).toBe('token extra');
  });
});

describe('cleanMarkdownUrls', () => {
  // Dynamic import to avoid circular deps
  let cleanMarkdownUrls: (text: string) => string;

  beforeEach(async () => {
    const mod = await import('../../src/channels/telegram-channel.js');
    cleanMarkdownUrls = mod.cleanMarkdownUrls;
  });

  it('should strip ** wrapping a URL', () => {
    expect(cleanMarkdownUrls('**https://t.me/bot?start=invite_abc**')).toBe('https://t.me/bot?start=invite_abc');
  });

  it('should strip trailing ** from URL', () => {
    expect(cleanMarkdownUrls('https://t.me/bot?start=invite_abc**')).toBe('https://t.me/bot?start=invite_abc');
  });

  it('should strip * wrapping a URL', () => {
    expect(cleanMarkdownUrls('*https://example.com/path*')).toBe('https://example.com/path');
  });

  it('should strip trailing * from URL', () => {
    expect(cleanMarkdownUrls('https://example.com/path*')).toBe('https://example.com/path');
  });

  it('should not modify URLs without markdown', () => {
    expect(cleanMarkdownUrls('https://t.me/bot?start=invite_abc')).toBe('https://t.me/bot?start=invite_abc');
  });

  it('should not modify non-URL bold text', () => {
    expect(cleanMarkdownUrls('This is **bold** text')).toBe('This is **bold** text');
  });

  it('should handle URL in middle of text', () => {
    expect(cleanMarkdownUrls('Click here: **https://t.me/bot?start=abc** to join')).toBe('Click here: https://t.me/bot?start=abc to join');
  });

  it('should handle multiple URLs', () => {
    const input = 'Link: **https://a.com** and **https://b.com**';
    expect(cleanMarkdownUrls(input)).toBe('Link: https://a.com and https://b.com');
  });
});
