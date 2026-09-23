import { describe, it, expect, vi } from 'vitest';
import { parseTelegramChatId, cleanMarkdownUrls, TelegramChannel } from '../../src/channels/telegram-channel.js';
import type { TelegramMessageStore } from '../../src/channels/telegram-message-store.js';

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

describe('TelegramChannel streaming internals', () => {
  // Private members are exercised directly — the channel has no bot-less harness.
  type Internals = {
    typingTimers: Map<string, ReturnType<typeof setInterval>>;
    streamStates: Map<string, { messageId: number; text: string; dirty: boolean; flushing: boolean; flushTimer?: ReturnType<typeof setInterval> }>;
    messageStore: TelegramMessageStore;
    handleChunk(bot: unknown, chatId: string, content: string): Promise<void>;
    flushStream(bot: unknown, chatId: string): Promise<void>;
    handleStreamEnd(bot: unknown, chatId: string): Promise<void>;
  };

  function fakeBot(firstId = 7) {
    let nextId = firstId;
    const calls: string[] = [];
    return {
      calls,
      api: {
        sendMessage: vi.fn(async (_chat: string, text: string) => { calls.push(`send:${text}`); return { message_id: nextId++ }; }),
        editMessageText: vi.fn(async (_chat: string, _id: number, text: string) => { calls.push(`edit:${text}`); }),
      },
    };
  }

  function channel(): Internals {
    return new TelegramChannel() as unknown as Internals;
  }

  function cleanup(ch: Internals): void {
    for (const s of ch.streamStates.values()) if (s.flushTimer) clearInterval(s.flushTimer);
    for (const t of ch.typingTimers.values()) clearInterval(t);
  }

  it('stops typing on stream end even when nothing was streamed', async () => {
    const ch = channel();
    ch.typingTimers.set('123', setInterval(() => {}, 60_000));

    await ch.handleStreamEnd(fakeBot(), '123');

    expect(ch.typingTimers.has('123')).toBe(false);
  });

  it('records the first streamed message on initial send', async () => {
    const ch = channel();
    const bot = fakeBot(7);

    await ch.handleChunk(bot, '123', 'Hello');

    expect(ch.messageStore.get('123', 7)).toEqual({ text: 'Hello', fromBot: true });
    cleanup(ch);
  });

  it('records the message when a flush performs the delayed initial send', async () => {
    const ch = channel();
    const bot = fakeBot(9);
    ch.streamStates.set('123', { messageId: 0, text: 'Buffered', dirty: true, flushing: false });

    await ch.flushStream(bot, '123');

    expect(ch.messageStore.get('123', 9)).toEqual({ text: 'Buffered', fromBot: true });
  });

  it('waits for an in-flight flush before the final edit', async () => {
    const ch = channel();
    const bot = fakeBot();
    ch.streamStates.set('123', { messageId: 5, text: 'Final', dirty: false, flushing: true });
    setTimeout(() => {
      bot.calls.push('flush-done');
      ch.streamStates.get('123')!.flushing = false;
    }, 30);

    await ch.handleStreamEnd(bot, '123');

    expect(bot.calls).toEqual(['flush-done', 'edit:Final']);
  });
});
