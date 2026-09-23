import { describe, it, expect, vi } from 'vitest';
import {
  formatReactionContent, resolveReactionRoute, applyReaction,
} from '../../src/channels/telegram-reactions.js';
import { TelegramMessageStore } from '../../src/channels/telegram-message-store.js';

describe('formatReactionContent', () => {
  it('quotes a bot message as "your message"', () => {
    expect(formatReactionContent('👍', { text: 'Remind you at 17?', fromBot: true }))
      .toBe('[Reaction 👍 to your message: "Remind you at 17?"]');
  });

  it('quotes the user\'s own message as "my message"', () => {
    expect(formatReactionContent('❤️', { text: 'Photo from the trip', fromBot: false }))
      .toBe('[Reaction ❤️ to my message: "Photo from the trip"]');
  });

  it('says the text is unavailable for an unknown target', () => {
    expect(formatReactionContent('👎', undefined))
      .toBe('[Reaction 👎 to an earlier message (text unavailable)]');
  });
});

describe('resolveReactionRoute', () => {
  it('routes to the base chat when the target has no topic', () => {
    const store = new TelegramMessageStore();
    store.record('555', 10, { text: 'hi', fromBot: true });
    expect(resolveReactionRoute(store, '555', 10, '👍')).toEqual({
      chatId: '555',
      content: '[Reaction 👍 to your message: "hi"]',
    });
  });

  it('routes to the topic session when the target lives in a forum topic', () => {
    const store = new TelegramMessageStore();
    store.record('-100777', 11, { text: 'topic msg', fromBot: true, topicId: 42 });
    expect(resolveReactionRoute(store, '-100777', 11, '👍')).toEqual({
      chatId: '-100777/42',
      content: '[Reaction 👍 to your message: "topic msg"]',
      topicId: 42,
    });
  });

  it('falls back to the base chat for an unknown message', () => {
    const store = new TelegramMessageStore();
    expect(resolveReactionRoute(store, '555', 99, '👍')).toEqual({
      chatId: '555',
      content: '[Reaction 👍 to an earlier message (text unavailable)]',
    });
  });
});

describe('applyReaction', () => {
  it('calls setMessageReaction with an emoji reaction', async () => {
    const api = { setMessageReaction: vi.fn().mockResolvedValue(true) };
    await applyReaction(api, '555', 10, '👍');
    expect(api.setMessageReaction).toHaveBeenCalledWith('555', 10, [{ type: 'emoji', emoji: '👍' }]);
  });

  it('propagates API errors to the caller', async () => {
    const api = { setMessageReaction: vi.fn().mockRejectedValue(new Error('REACTION_INVALID')) };
    await expect(applyReaction(api, '555', 10, '🦄')).rejects.toThrow('REACTION_INVALID');
  });
});
