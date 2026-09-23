import { describe, it, expect } from 'vitest';
import { TelegramMessageStore, STORE_SNIPPET_CHARS } from '../../src/channels/telegram-message-store.js';

describe('TelegramMessageStore', () => {
  it('returns what was recorded', () => {
    const store = new TelegramMessageStore();
    store.record('100', 7, { text: 'Remind you at 17?', fromBot: true });
    expect(store.get('100', 7)).toEqual({ text: 'Remind you at 17?', fromBot: true });
  });

  it('returns undefined for unknown chat or message', () => {
    const store = new TelegramMessageStore();
    store.record('100', 7, { text: 'a', fromBot: true });
    expect(store.get('100', 8)).toBeUndefined();
    expect(store.get('200', 7)).toBeUndefined();
  });

  it('keeps chats isolated', () => {
    const store = new TelegramMessageStore();
    store.record('100', 1, { text: 'first chat', fromBot: true });
    store.record('200', 1, { text: 'second chat', fromBot: false });
    expect(store.get('100', 1)?.text).toBe('first chat');
    expect(store.get('200', 1)?.text).toBe('second chat');
  });

  it('evicts the oldest entry past the cap', () => {
    const store = new TelegramMessageStore(3);
    for (let id = 1; id <= 4; id++) store.record('100', id, { text: `m${id}`, fromBot: true });
    expect(store.get('100', 1)).toBeUndefined();
    expect(store.get('100', 2)?.text).toBe('m2');
    expect(store.get('100', 4)?.text).toBe('m4');
  });

  it('overwrites on re-record without growing (stream final text)', () => {
    const store = new TelegramMessageStore(2);
    store.record('100', 1, { text: 'partial', fromBot: true });
    store.record('100', 2, { text: 'other', fromBot: true });
    store.record('100', 1, { text: 'final text', fromBot: true });
    store.record('100', 3, { text: 'newest', fromBot: true });
    // id 1 was refreshed, so id 2 is now the oldest and gets evicted
    expect(store.get('100', 1)?.text).toBe('final text');
    expect(store.get('100', 2)).toBeUndefined();
  });

  it('collapses whitespace and truncates long text', () => {
    const store = new TelegramMessageStore();
    store.record('100', 1, { text: 'a\n\n  b', fromBot: false });
    expect(store.get('100', 1)?.text).toBe('a b');

    store.record('100', 2, { text: 'x'.repeat(STORE_SNIPPET_CHARS + 50), fromBot: false });
    const text = store.get('100', 2)!.text;
    expect(text.length).toBe(STORE_SNIPPET_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
  });

  it('keeps topicId', () => {
    const store = new TelegramMessageStore();
    store.record('-100', 5, { text: 't', fromBot: true, topicId: 42 });
    expect(store.get('-100', 5)?.topicId).toBe(42);
  });
});
