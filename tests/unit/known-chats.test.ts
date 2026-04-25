import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import { upsertKnownChat, getKnownChats } from '../../src/db/known-chats.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('known-chats', () => {
  let db: Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'janus-known-chats-'));
    db = new Database(join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('upsertKnownChat', () => {
    it('inserts a new chat entry', () => {
      upsertKnownChat(db, {
        userId: 'alice',
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
        chatType: 'supergroup',
      });

      const chats = getKnownChats(db, 'alice');
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({
        userId: 'alice',
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
        chatType: 'supergroup',
      });
    });

    it('updates chat_name and last_seen_at on conflict', () => {
      upsertKnownChat(db, {
        userId: 'alice',
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Old Name',
        chatType: 'group',
      });
      upsertKnownChat(db, {
        userId: 'alice',
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'New Name',
        chatType: 'supergroup',
      });

      const chats = getKnownChats(db, 'alice');
      expect(chats).toHaveLength(1);
      expect(chats[0].chatName).toBe('New Name');
      expect(chats[0].chatType).toBe('supergroup');
    });

    it('stores chats for different users independently', () => {
      upsertKnownChat(db, {
        userId: 'alice',
        channel: 'telegram',
        chatId: '111',
        chatName: 'Alice DM',
        chatType: 'private',
      });
      upsertKnownChat(db, {
        userId: 'bob',
        channel: 'telegram',
        chatId: '222',
        chatName: 'Bob DM',
        chatType: 'private',
      });

      expect(getKnownChats(db, 'alice')).toHaveLength(1);
      expect(getKnownChats(db, 'bob')).toHaveLength(1);
      expect(getKnownChats(db, 'alice')[0].chatId).toBe('111');
    });

    it('handles multiple channels for same user', () => {
      upsertKnownChat(db, {
        userId: 'alice',
        channel: 'telegram',
        chatId: '111',
        chatName: 'Telegram DM',
        chatType: 'private',
      });
      upsertKnownChat(db, {
        userId: 'alice',
        channel: 'slack',
        chatId: '#general',
        chatName: 'general',
        chatType: 'channel',
      });

      const chats = getKnownChats(db, 'alice');
      expect(chats).toHaveLength(2);
      const channels = chats.map(c => c.channel).sort();
      expect(channels).toEqual(['slack', 'telegram']);
    });
  });

  describe('getKnownChats', () => {
    it('returns empty array for unknown user', () => {
      expect(getKnownChats(db, 'unknown')).toEqual([]);
    });

    it('returns chats sorted by last_seen_at descending', () => {
      db.db.prepare(`INSERT INTO user_known_chats (user_id, channel, chat_id, chat_name, chat_type, last_seen_at)
        VALUES ('alice', 'telegram', '1', 'Old', 'private', '2026-04-20T00:00:00Z')`).run();
      db.db.prepare(`INSERT INTO user_known_chats (user_id, channel, chat_id, chat_name, chat_type, last_seen_at)
        VALUES ('alice', 'telegram', '2', 'New', 'private', '2026-04-25T00:00:00Z')`).run();

      const chats = getKnownChats(db, 'alice');
      expect(chats[0].chatId).toBe('2');
      expect(chats[1].chatId).toBe('1');
    });
  });
});
