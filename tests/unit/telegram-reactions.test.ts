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

  it('quotes the reactor\'s own message as "my message"', () => {
    expect(formatReactionContent('❤️', { text: 'Photo from the trip', fromBot: false, authorId: '1001', authorName: 'Ala' }, '1001'))
      .toBe('[Reaction ❤️ to my message: "Photo from the trip"]');
  });

  it('names the author when someone reacts to another user\'s message (group)', () => {
    expect(formatReactionContent('😂', { text: 'Pizza tonight?', fromBot: false, authorId: '1002', authorName: 'Olek' }, '1001'))
      .toBe('[Reaction 😂 to a message from Olek: "Pizza tonight?"]');
  });

  it('falls back to "another user" when the other author has no name', () => {
    expect(formatReactionContent('😂', { text: 'Pizza tonight?', fromBot: false, authorId: '1002' }, '1001'))
      .toBe('[Reaction 😂 to a message from another user: "Pizza tonight?"]');
  });

  it('does not claim ownership when the reactor is unknown (anonymous reaction)', () => {
    expect(formatReactionContent('👍', { text: 'Pizza tonight?', fromBot: false, authorId: '1002', authorName: 'Olek' }))
      .toBe('[Reaction 👍 to a message from Olek: "Pizza tonight?"]');
  });

  it('keeps "your message" for the bot\'s message whoever reacts', () => {
    expect(formatReactionContent('👍', { text: 'Done', fromBot: true }, '1001'))
      .toBe('[Reaction 👍 to your message: "Done"]');
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

  it('passes the reactor through so a group reaction names the author', () => {
    const store = new TelegramMessageStore();
    store.record('-100777', 12, { text: 'my plan', fromBot: false, authorId: '1002', authorName: 'Olek' });
    expect(resolveReactionRoute(store, '-100777', 12, '👍', '1001').content)
      .toBe('[Reaction 👍 to a message from Olek: "my plan"]');
    expect(resolveReactionRoute(store, '-100777', 12, '👍', '1002').content)
      .toBe('[Reaction 👍 to my message: "my plan"]');
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

  it('accepts grammy\'s Api as ReactionApi', () => {
    // Compile-time check: grammy's Api must be assignable to ReactionApi
    type GrammyApi = import('grammy').Api;
    const check: (a: GrammyApi) => import('../../src/channels/telegram-reactions.js').ReactionApi = (a) => a;
    expect(typeof check).toBe('function');
  });
});
