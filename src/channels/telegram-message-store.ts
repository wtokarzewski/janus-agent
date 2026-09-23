/**
 * Recent Telegram messages per chat, so a reaction update — which carries only
 * chat and message IDs, never text — can be told apart: "👍 to *which* message".
 * In memory only; entries from before a restart are simply unknown.
 */

export interface StoredMessage {
  text: string;
  fromBot: boolean;
  topicId?: number;
  /** Telegram user ID of the sender — set for user messages, unset for the bot's own. */
  authorId?: string;
  /** Sender's display name (first name, else username) — for "a message from …". */
  authorName?: string;
}

export const STORE_MAX_PER_CHAT = 200;
export const STORE_SNIPPET_CHARS = 300;

function toSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > STORE_SNIPPET_CHARS
    ? `${collapsed.slice(0, STORE_SNIPPET_CHARS)}…`
    : collapsed;
}

export class TelegramMessageStore {
  private chats = new Map<string, Map<number, StoredMessage>>();

  constructor(private maxPerChat = STORE_MAX_PER_CHAT) {}

  /** `chatId` is the base chat ID — Telegram message IDs are unique per chat, not per topic. */
  record(chatId: string, messageId: number, entry: StoredMessage): void {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = new Map();
      this.chats.set(chatId, chat);
    }
    // Delete first so a re-recorded message moves to the newest position.
    chat.delete(messageId);
    chat.set(messageId, { ...entry, text: toSnippet(entry.text) });
    if (chat.size > this.maxPerChat) {
      const oldest = chat.keys().next().value as number;
      chat.delete(oldest);
    }
  }

  get(chatId: string, messageId: number): StoredMessage | undefined {
    return this.chats.get(chatId)?.get(messageId);
  }
}
