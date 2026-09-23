import type { ReactionTypeEmoji } from 'grammy/types';
import type { StoredMessage, TelegramMessageStore } from './telegram-message-store.js';

/**
 * Inbound content for a reaction, phrased from the reactor's point of view: the
 * bot's own message is "your message", the reactor's own is "my message", and
 * anyone else's (in a group) is "a message from <name>".
 */
export function formatReactionContent(emoji: string, target: StoredMessage | undefined, reactorId?: string): string {
  if (!target) return `[Reaction ${emoji} to an earlier message (text unavailable)]`;
  const whose = target.fromBot
    ? 'your message'
    : target.authorId === reactorId
      ? 'my message'
      : `a message from ${target.authorName ?? 'another user'}`;
  return `[Reaction ${emoji} to ${whose}: "${target.text}"]`;
}

/**
 * Reaction updates carry no thread ID; the stored message knows its forum topic,
 * so the reaction lands in that topic's session instead of the whole group's.
 */
export function resolveReactionRoute(
  store: TelegramMessageStore,
  baseChatId: string,
  messageId: number,
  emoji: string,
  reactorId?: string,
): { chatId: string; content: string; topicId?: number } {
  const target = store.get(baseChatId, messageId);
  const content = formatReactionContent(emoji, target, reactorId);
  if (target?.topicId) {
    return { chatId: `${baseChatId}/${target.topicId}`, content, topicId: target.topicId };
  }
  return { chatId: baseChatId, content };
}

export interface ReactionApi {
  setMessageReaction(chatId: number | string, messageId: number, reaction: ReactionTypeEmoji[]): Promise<unknown>;
}

/** Set the bot's reaction on a message. Throws what the API throws — callers log. */
export async function applyReaction(api: ReactionApi, chatId: string, messageId: number, emoji: string): Promise<void> {
  // The emoji comes from the agent as a plain string; Telegram validates it
  // (an unsupported one fails with 400, which the caller logs).
  await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as ReactionTypeEmoji['emoji'] }]);
}
