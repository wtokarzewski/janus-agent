import { describe, it, expect } from 'vitest';
import { parseTelegramChatId, cleanMarkdownUrls } from '../../src/channels/telegram-channel.js';

describe('parseTelegramChatId', () => {
  it('returns plain chatId when no topic', () => {
    expect(parseTelegramChatId('12345')).toEqual({ chatId: '12345' });
  });

  it('returns plain chatId for negative group IDs', () => {
    expect(parseTelegramChatId('-100123456')).toEqual({ chatId: '-100123456' });
  });

  it('parses composite chatId/topicId', () => {
    expect(parseTelegramChatId('-100123456/42')).toEqual({ chatId: '-100123456', topicId: 42 });
  });

  it('parses General topic (topicId=1)', () => {
    expect(parseTelegramChatId('-100123456/1')).toEqual({ chatId: '-100123456', topicId: 1 });
  });

  it('ignores invalid topicId', () => {
    expect(parseTelegramChatId('-100123456/abc')).toEqual({ chatId: '-100123456', topicId: undefined });
  });
});

describe('cleanMarkdownUrls', () => {
  it('strips bold wrapping URLs', () => {
    expect(cleanMarkdownUrls('**https://example.com**')).toBe('https://example.com');
  });

  it('leaves non-URL text unchanged', () => {
    expect(cleanMarkdownUrls('Hello **world**')).toBe('Hello **world**');
  });
});
