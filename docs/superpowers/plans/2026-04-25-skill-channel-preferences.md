# Skill Channel Preferences — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user, per-skill channel preferences — skills remember which channel to communicate on, with auto-discovery of known chats and first-use setup flow.

**Architecture:** New `user_known_chats` SQLite table populated by channel handlers on inbound messages. Per-user `skill-channels.json` file managed by the LLM via read/write tools. Context builder injects both into the system prompt. Skill instructions handle routing logic.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Vitest

**Spec:** `docs/superpowers/specs/2026-04-25-skill-channel-preferences-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db/migrations.ts` | Modify | Add migration 14: `user_known_chats` table |
| `src/db/known-chats.ts` | Create | `upsertKnownChat()` + `getKnownChats(userId)` |
| `src/channels/telegram-channel.ts` | Modify | Call `upsertKnownChat()` on every inbound message |
| `src/users/user-resolver.ts` | Modify | Add `loadSkillChannels(userId, workspaceDir)` helper |
| `src/context/context-builder.ts` | Modify | Inject `<your_chats>` + `<skill_channels>` into dynamic prompt |
| `skills/diet-tracker/SKILL.md` | Modify | Add `## Channel Preference` section |
| `skills/diet-tracker/install.md` | Modify | Save preference to `skill-channels.json` during setup |
| `skills/diet-tracker/uninstall.md` | Modify | Clean up `skill-channels.json` entry |
| `tests/unit/known-chats.test.ts` | Create | Tests for `upsertKnownChat` + `getKnownChats` |
| `tests/unit/skill-channels.test.ts` | Create | Tests for `loadSkillChannels` |
| `tests/unit/context-builder.test.ts` | Modify | Tests for `<your_chats>` + `<skill_channels>` injection |

---

### Task 1: Migration — `user_known_chats` table

**Files:**
- Modify: `src/db/migrations.ts` (append to `migrations[]` array)

- [ ] **Step 1: Write migration SQL**

Add migration 14 to the end of the `migrations` array in `src/db/migrations.ts`:

```typescript
  // Migration 14: user_known_chats — per-user channel/chat discovery for skill routing
  `
CREATE TABLE IF NOT EXISTS user_known_chats (
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  chat_type TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, channel, chat_id)
);
`,
```

- [ ] **Step 2: Verify migration applies**

Run: `npm test -- tests/unit/config-schema.test.ts --reporter=verbose 2>&1 | head -20`

If the test infrastructure creates test databases, the migration should apply without errors. Also verify with a quick typecheck:

Run: `npm run typecheck`
Expected: PASS (no type errors — migration is just a string)

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations.ts
git commit -m "feat: add migration 14 — user_known_chats table for skill channel routing"
```

---

### Task 2: Known Chats data access module

**Files:**
- Create: `src/db/known-chats.ts`
- Create: `tests/unit/known-chats.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/known-chats.test.ts`:

```typescript
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
      // Insert with explicit timestamps via raw SQL for ordering test
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/known-chats.test.ts --reporter=verbose 2>&1 | tail -10`
Expected: FAIL — module `../../src/db/known-chats.js` does not exist

- [ ] **Step 3: Implement `known-chats.ts`**

Create `src/db/known-chats.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/known-chats.test.ts --reporter=verbose`
Expected: ALL PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/known-chats.ts tests/unit/known-chats.test.ts
git commit -m "feat: add known-chats module — per-user channel/chat tracking"
```

---

### Task 3: Telegram channel — upsert known chats on inbound

**Files:**
- Modify: `src/channels/telegram-channel.ts`

- [ ] **Step 1: Add import**

At the top of `src/channels/telegram-channel.ts`, after the existing imports, add:

```typescript
import type { Database } from '../db/database.js';
import { upsertKnownChat } from '../db/known-chats.js';
```

- [ ] **Step 2: Accept optional `database` in start parameters**

Modify the `start()` method signature. Find the existing `opts?` parameter:

```typescript
async start(bus: MessageBus, config: JanusConfig, signal: AbortSignal, externalBot?: Bot, opts?: { agent?: AgentLoop; subagentRegistry?: SubagentRegistry; inviteStore?: InviteStore }): Promise<void> {
```

Add `database` to the opts type:

```typescript
async start(bus: MessageBus, config: JanusConfig, signal: AbortSignal, externalBot?: Bot, opts?: { agent?: AgentLoop; subagentRegistry?: SubagentRegistry; inviteStore?: InviteStore; database?: Database }): Promise<void> {
```

- [ ] **Step 3: Add upsert helper inside `start()`**

After the line `const runtimeAllowlist = new Set<string>();` (line 74), add:

```typescript
    /** Track known chats for skill channel routing. */
    const trackChat = (userId: string | undefined, chatId: string, chatName: string | undefined, chatType: string | undefined) => {
      if (!userId || !opts?.database) return;
      upsertKnownChat(opts.database, {
        userId,
        channel: 'telegram',
        chatId,
        chatName: chatName ?? null,
        chatType: chatType ?? null,
      });
    };
```

- [ ] **Step 4: Call `trackChat` in `message:text` handler**

In the `bot.on('message:text', ...)` handler, after the user is resolved (after the `const resolved = ...` line and before `const replyContext = ...`), add:

```typescript
      // Track known chat for skill channel routing
      const chatName = ctx.chat.type === 'private'
        ? ctx.chat.first_name
        : (ctx.chat as { title?: string }).title;
      trackChat(resolved?.userId, baseChatId, chatName, ctx.chat.type);
```

- [ ] **Step 5: Call `trackChat` in voice handler**

In the `bot.on(['message:voice', 'message:audio'], ...)` handler, after `const resolved = ...` and before `const caption = ...`, add:

```typescript
      // Track known chat for skill channel routing
      const chatName = ctx.chat.type === 'private'
        ? ctx.chat.first_name
        : (ctx.chat as { title?: string }).title;
      trackChat(resolved?.userId, baseChatId, chatName, ctx.chat.type);
```

- [ ] **Step 6: Call `trackChat` in photo handler**

In the `bot.on('message:photo', ...)` handler, after `const resolved = ...` and before `const caption = ...`, add:

```typescript
      // Track known chat for skill channel routing
      const chatName = ctx.chat.type === 'private'
        ? ctx.chat.first_name
        : (ctx.chat as { title?: string }).title;
      trackChat(resolved?.userId, baseChatId, chatName, ctx.chat.type);
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 8: Run existing Telegram tests**

Run: `npm test -- tests/unit/telegram-channel.test.ts --reporter=verbose 2>&1 | tail -10`
Expected: PASS (existing tests still pass — `database` is optional)

- [ ] **Step 9: Wire database into Telegram channel start call**

Find where `TelegramChannel.start()` is called in `src/bootstrap.ts` or the gateway command. Add `database` to the opts object passed there. Search for the call site:

Run: `grep -rn 'telegram.*start\|TelegramChannel' src/bootstrap.ts src/commands/ --include='*.ts'`

At the call site, add `database: db` to the opts object (where `db` is the existing Database instance).

- [ ] **Step 10: Typecheck and test**

Run: `npm run typecheck && npm test -- --reporter=verbose 2>&1 | tail -5`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/channels/telegram-channel.ts src/bootstrap.ts
git commit -m "feat: track known chats on Telegram inbound for skill channel routing"
```

---

### Task 4: Load skill channel preferences

**Files:**
- Modify: `src/users/user-resolver.ts`
- Create: `tests/unit/skill-channels.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/skill-channels.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkillChannels } from '../../src/users/user-resolver.js';

describe('loadSkillChannels', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'janus-skill-channels-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty object when file does not exist', async () => {
    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({});
  });

  it('loads skill channel preferences from JSON file', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), JSON.stringify({
      'diet-tracker': {
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
        setAt: '2026-04-25T10:00:00Z',
      },
    }));

    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({
      'diet-tracker': {
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
        setAt: '2026-04-25T10:00:00Z',
      },
    });
  });

  it('returns empty object for malformed JSON', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), 'not json');

    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({});
  });

  it('returns empty object for non-object JSON', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), '"just a string"');

    const result = await loadSkillChannels('alice', tempDir);
    expect(result).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/skill-channels.test.ts --reporter=verbose 2>&1 | tail -10`
Expected: FAIL — `loadSkillChannels` is not exported from user-resolver

- [ ] **Step 3: Implement `loadSkillChannels`**

Add to the end of `src/users/user-resolver.ts`, before the closing of the file:

```typescript
/** Per-skill channel preference entry. */
export interface SkillChannelPref {
  channel: string;
  chatId: string;
  chatName?: string;
  setAt?: string;
}

/** Load per-user skill channel preferences from skill-channels.json. */
export async function loadSkillChannels(
  userId: string,
  workspaceDir: string,
): Promise<Record<string, SkillChannelPref>> {
  const filePath = resolve(workspaceDir, '.janus', 'users', userId, 'skill-channels.json');
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, SkillChannelPref>;
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/unit/skill-channels.test.ts --reporter=verbose`
Expected: ALL PASS (4 tests)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/users/user-resolver.ts tests/unit/skill-channels.test.ts
git commit -m "feat: add loadSkillChannels — per-user skill channel preferences"
```

---

### Task 5: Context builder — inject `<your_chats>` and `<skill_channels>`

**Files:**
- Modify: `src/context/context-builder.ts`
- Modify: `tests/unit/context-builder.test.ts`

- [ ] **Step 1: Write failing tests**

Add these tests to `tests/unit/context-builder.test.ts`:

```typescript
describe('ContextBuilder skill channel preferences', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  it('injects <your_chats> when user has known chats in database', async () => {
    // Create a database with known chats
    const { Database } = await import('../../src/db/database.js');
    const { upsertKnownChat } = await import('../../src/db/known-chats.js');
    const db = new Database(join(tempDir, '.janus', 'test.db'));

    upsertKnownChat(db, {
      userId: 'alice',
      channel: 'telegram',
      chatId: '111',
      chatName: 'Alice DM',
      chatType: 'private',
    });
    upsertKnownChat(db, {
      userId: 'alice',
      channel: 'telegram',
      chatId: '-1001234567890',
      chatName: 'Dieta',
      chatType: 'supergroup',
    });

    const config = createTestConfig({
      workspace: { dir: tempDir },
      users: [{ id: 'alice', name: 'Alice', identities: [{ channel: 'telegram', channelUserId: '111' }] }],
    });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config, database: db });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).toContain('<your_chats>');
    expect(dynamicPart).toContain('telegram:111');
    expect(dynamicPart).toContain('Alice DM');
    expect(dynamicPart).toContain('telegram:-1001234567890');
    expect(dynamicPart).toContain('Dieta');

    db.close();
  });

  it('injects <skill_channels> when user has preferences', async () => {
    const userDir = join(tempDir, '.janus', 'users', 'alice');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'skill-channels.json'), JSON.stringify({
      'diet-tracker': {
        channel: 'telegram',
        chatId: '-1001234567890',
        chatName: 'Dieta',
      },
    }));

    const config = createTestConfig({
      workspace: { dir: tempDir },
      users: [{ id: 'alice', name: 'Alice', identities: [{ channel: 'telegram', channelUserId: '111' }] }],
    });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).toContain('<skill_channels>');
    expect(dynamicPart).toContain('diet-tracker');
    expect(dynamicPart).toContain('telegram:-1001234567890');
    expect(dynamicPart).toContain('Dieta');
  });

  it('omits <your_chats> when no database provided', async () => {
    const config = createTestConfig({ workspace: { dir: tempDir } });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).not.toContain('<your_chats>');
  });

  it('omits <skill_channels> when user has no preferences file', async () => {
    const config = createTestConfig({ workspace: { dir: tempDir } });
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const builder = new ContextBuilder({ skills, memory, config });

    const { dynamicPart } = await builder.build({
      channel: 'telegram',
      chatId: '111',
      tools: [],
      user: { userId: 'alice', name: 'Alice' },
    });

    expect(dynamicPart).not.toContain('<skill_channels>');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/context-builder.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `database` property not accepted by ContextBuilder constructor

- [ ] **Step 3: Add `database` to ContextDeps**

In `src/context/context-builder.ts`, modify the `ContextDeps` interface (around line 19):

```typescript
interface ContextDeps {
  skills: SkillLoader;
  memory: MemoryStore;
  config: JanusConfig;
  learner?: SkillLearner;
  database?: Database;
}
```

Add the necessary imports at the top:

```typescript
import type { Database } from '../db/database.js';
import { getKnownChats } from '../db/known-chats.js';
import { loadSkillChannels } from '../users/user-resolver.js';
```

- [ ] **Step 4: Add known chats section builder**

Add a new private method to `ContextBuilder`:

```typescript
  private async buildKnownChatsSection(userId: string): Promise<string | null> {
    if (!this.deps.database) return null;
    const chats = getKnownChats(this.deps.database, userId);
    if (chats.length === 0) return null;

    const lines = chats.map(c => {
      const label = c.chatName ? ` (${c.chatType ?? 'chat'}: ${c.chatName})` : '';
      return `- ${c.channel}:${c.chatId}${label}`;
    });
    return `<your_chats>\n${lines.join('\n')}\n</your_chats>`;
  }
```

- [ ] **Step 5: Add skill channels section builder**

Add another private method:

```typescript
  private async buildSkillChannelsSection(userId: string): Promise<string | null> {
    const prefs = await loadSkillChannels(userId, this.deps.config.workspace.dir);
    const entries = Object.entries(prefs);
    if (entries.length === 0) return null;

    const lines = entries.map(([skill, pref]) => {
      const label = pref.chatName ? ` (${pref.chatName})` : '';
      return `- ${skill} → ${pref.channel}:${pref.chatId}${label}`;
    });
    lines.push('');
    lines.push('When a skill has a preferred channel different from the current chat:');
    lines.push('- Send a brief redirect note on current chat');
    lines.push('- Use the message tool to deliver the full response to the preferred channel');
    return `<skill_channels>\n${lines.join('\n')}\n</skill_channels>`;
  }
```

- [ ] **Step 6: Wire into `build()` method**

In the `build()` method, in the dynamic part section (after the user section block around line 139, before the memory section), add:

```typescript
    // Skill channel routing — known chats + preferences (per-user)
    if (opts.user?.userId) {
      const knownChats = await this.buildKnownChatsSection(opts.user.userId);
      if (knownChats) dynamicParts.push(knownChats);

      const skillChannels = await this.buildSkillChannelsSection(opts.user.userId);
      if (skillChannels) dynamicParts.push(skillChannels);
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/unit/context-builder.test.ts --reporter=verbose`
Expected: ALL PASS (existing tests + 4 new tests)

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Wire database into ContextBuilder in bootstrap**

Find where `ContextBuilder` is instantiated (likely in `src/bootstrap.ts` or `src/agent/agent-loop.ts`). Add the `database` dependency:

Search: `grep -rn 'new ContextBuilder' src/ --include='*.ts'`

At the constructor call, add `database: db` to the deps object.

- [ ] **Step 10: Run full test suite**

Run: `npm test --reporter=verbose 2>&1 | tail -10`
Expected: ALL PASS

- [ ] **Step 11: Commit**

```bash
git add src/context/context-builder.ts tests/unit/context-builder.test.ts src/bootstrap.ts
git commit -m "feat: inject known chats and skill channel preferences into system prompt"
```

---

### Task 6: Update diet-tracker skill — channel preference section

**Files:**
- Modify: `skills/diet-tracker/SKILL.md`

- [ ] **Step 1: Add Channel Preference section to SKILL.md**

Add after the `## Rules` section (before `## Day Types`) in `skills/diet-tracker/SKILL.md`:

```markdown
## Channel Preference

This skill supports dedicated channel routing via `skill-channels.json`.

### Checking preference
Before any output, check `<skill_channels>` in the system prompt:
- If `diet-tracker` has a preferred channel → use it for ALL output
- If no preference → trigger first-use setup (see below)

### First use (no preference)
1. Check if this is a fresh install or existing user without preference
2. Default suggestion = current chat (the one user is writing from)
3. Show other available chats from `<your_chats>` if present
4. Ask: "Where should diet updates go? Default: **this chat** ([name])"
5. Save to `skill-channels.json` via `write_file`:
   ```json
   {
     "diet-tracker": {
       "channel": "[channel]",
       "chatId": "[chatId]",
       "chatName": "[name]",
       "setAt": "[ISO timestamp]"
     }
   }
   ```
   Path: `.janus/users/{userId}/skill-channels.json`
   If file exists, read first and merge (don't overwrite other skills' preferences).

### Routing rules
- **Preferred channel = current chat:** respond normally
- **Preferred channel ≠ current chat:** brief redirect on current chat ("📋 → [channel name]"), then send full response via `message` tool to preferred channel
- **No preference set + first interaction:** ask user (first-use flow above)

### Changing channel
User says "change diet channel to X" or "move diet to [chat name]":
1. Update `skill-channels.json`
2. Update ALL diet heartbeat entries in user's `HEARTBEAT.md` — change `chat:` field
3. Confirm: "✅ Diet → [new channel]. Heartbeats updated."

### Heartbeat alignment
When creating or updating heartbeats (install, channel change), always set `- chat: {preferredChatId}` using the value from `skill-channels.json`. Never leave heartbeat chat field empty for this skill.
```

- [ ] **Step 2: Verify skill file is valid YAML frontmatter + markdown**

Run: `head -6 skills/diet-tracker/SKILL.md`
Expected: Valid YAML frontmatter (---/name/description/version/always/---)

- [ ] **Step 3: Commit**

```bash
git add skills/diet-tracker/SKILL.md
git commit -m "feat: add channel preference routing to diet-tracker skill"
```

---

### Task 7: Update diet-tracker install — save channel preference

**Files:**
- Modify: `skills/diet-tracker/install.md`

- [ ] **Step 1: Update step 11 (Chat) in install.md**

Replace the existing step 11 content in the `### Natural sequence` section. Find:

```
11. **Chat** — which Telegram chat to use (private or group), get chatId
```

Replace with:

```
11. **Chat** — which channel to use for diet updates:
    - Show available chats from `<your_chats>` (if present)
    - Default = current chat (the one user is writing from)
    - Ask: "Where should diet updates go? Default: **this chat**"
    - Save choice to `.janus/users/{userId}/skill-channels.json` via `write_file`:
      ```json
      { "diet-tracker": { "channel": "...", "chatId": "...", "chatName": "...", "setAt": "..." } }
      ```
      If file exists, read first and merge — don't overwrite other skills' entries.
    - Use the chosen chatId for all heartbeat `chat:` fields in the next step
```

- [ ] **Step 2: Commit**

```bash
git add skills/diet-tracker/install.md
git commit -m "feat: save skill channel preference during diet-tracker install"
```

---

### Task 8: Update diet-tracker uninstall — clean up preference

**Files:**
- Modify: `skills/diet-tracker/uninstall.md`

- [ ] **Step 1: Read current uninstall.md**

Run: `cat skills/diet-tracker/uninstall.md`

- [ ] **Step 2: Add cleanup step**

Add to the uninstall procedure in `skills/diet-tracker/uninstall.md`:

```markdown
## Channel preference cleanup

Remove the `diet-tracker` entry from `.janus/users/{userId}/skill-channels.json`:
1. Read the file
2. Delete the `diet-tracker` key
3. Write back (preserve other skills' entries)
4. If no entries remain, delete the file
```

- [ ] **Step 3: Commit**

```bash
git add skills/diet-tracker/uninstall.md
git commit -m "feat: clean up channel preference on diet-tracker uninstall"
```

---

### Task 9: Run full test suite and typecheck

**Files:** None (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors

- [ ] **Step 2: Run full test suite**

Run: `npm test --reporter=verbose 2>&1 | tail -20`
Expected: ALL PASS — no regressions, new tests included

- [ ] **Step 3: Count test delta**

Run: `npm test 2>&1 | grep -E 'Tests|test files'`
Expected: ~10 new tests (6 known-chats + 4 skill-channels + context-builder additions)

- [ ] **Step 4: Final commit (if any unstaged changes)**

```bash
git status
# If clean, skip. If anything unstaged:
git add -A && git commit -m "chore: final cleanup for skill channel preferences"
```
