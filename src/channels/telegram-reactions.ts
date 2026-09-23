import type { StoredMessage, TelegramMessageStore } from './telegram-message-store.js';

/**
 * Inbound content for a reaction. Phrased from the agent's point of view:
 * the bot's own message is "your message", the user's is "my message".
 */
export function formatReactionContent(emoji: string, target: StoredMessage | undefined): string {
  if (!target) return `[Reaction ${emoji} to an earlier message (text unavailable)]`;
  const whose = target.fromBot ? 'your' : 'my';
  return `[Reaction ${emoji} to ${whose} message: "${target.text}"]`;
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
): { chatId: string; content: string; topicId?: number } {
  const target = store.get(baseChatId, messageId);
  const content = formatReactionContent(emoji, target);
  if (target?.topicId) {
    return { chatId: `${baseChatId}/${target.topicId}`, content, topicId: target.topicId };
  }
  return { chatId: baseChatId, content };
}

export interface ReactionApi {
  setMessageReaction(
    chatId: number | string,
    messageId: number,
    reaction: Array<{ type: 'emoji'; emoji: string }>,
  ): Promise<unknown>;
}

/** Set the bot's reaction on a message. Throws what the API throws — callers log. */
export async function applyReaction(api: ReactionApi, chatId: string, messageId: number, emoji: string): Promise<void> {
  await api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
}
