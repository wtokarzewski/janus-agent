/**
 * Known chats — per-user tracking of channels/chats the user has been seen in.
 * Used by skills to offer channel selection during first-use setup.
 */

import type { Database } from './database.js';

export interface KnownChat {
  userId: string;
  channel: string;
  chatId: string;
  chatName: string | null;
  chatType: string | null;
  lastSeenAt: string;
}

export interface UpsertKnownChatInput {
  userId: string;
  channel: string;
  chatId: string;
  chatName?: string | null;
  chatType?: string | null;
}

/**
 * Upsert a known chat entry. Updates chat_name, chat_type, and last_seen_at on conflict.
 */
export function upsertKnownChat(db: Database, input: UpsertKnownChatInput): void {
  db.db.prepare(`
    INSERT INTO user_known_chats (user_id, channel, chat_id, chat_name, chat_type, last_seen_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, channel, chat_id) DO UPDATE SET
      chat_name = excluded.chat_name,
      chat_type = excluded.chat_type,
      last_seen_at = datetime('now')
  `).run(input.userId, input.channel, input.chatId, input.chatName ?? null, input.chatType ?? null);
}

/**
 * Get all known chats for a user, sorted by most recently seen.
 */
export function getKnownChats(db: Database, userId: string): KnownChat[] {
  const rows = db.db.prepare(`
    SELECT user_id, channel, chat_id, chat_name, chat_type, last_seen_at
    FROM user_known_chats
    WHERE user_id = ?
    ORDER BY last_seen_at DESC
  `).all(userId) as Array<{
    user_id: string;
    channel: string;
    chat_id: string;
    chat_name: string | null;
    chat_type: string | null;
    last_seen_at: string;
  }>;

  return rows.map(r => ({
    userId: r.user_id,
    channel: r.channel,
    chatId: r.chat_id,
    chatName: r.chat_name,
    chatType: r.chat_type,
    lastSeenAt: r.last_seen_at,
  }));
}
