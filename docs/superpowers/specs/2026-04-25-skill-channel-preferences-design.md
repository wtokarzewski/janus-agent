# Skill Channel Preferences

**Date:** 2026-04-25
**Status:** Draft
**Scope:** Framework feature + diet-tracker skill update

## Problem

Skills (e.g. diet-tracker) send output to whatever channel triggered them or wherever the cron/heartbeat fires. No mechanism binds a skill's output to a specific channel. Result:

1. Diet reports land on 1:1 private chat instead of the dedicated "Dieta" group
2. General notifications (camera reminders, calendar) leak into the "Dieta" group
3. User must manually correct the agent every time

## Solution

Per-user, per-skill channel preference — stored as a file, loaded into the system prompt, enforced by skill instructions. Channel-agnostic from day one (Telegram, Slack, WhatsApp, email — same mechanism).

### Design Principles

- **Channel-agnostic:** Everything operates on `(channel, chatId)` pairs. No channel handler name hardcoded in framework code.
- **Per-user scoping:** Each user sees only their own chats and preferences. Work Slack doesn't see family diet. Family Telegram doesn't see work topics.
- **Prompt-level routing:** Framework provides data to prompt, LLM decides routing. Consistent with Janus philosophy — intelligence in LLM + good prompts, not hardcoded orchestration.
- **Opt-in per skill:** Not all skills need channel preferences. Framework provides the infrastructure; skill instructions decide whether to use it.

## Architecture

### 1. User Known Chats (SQLite)

New table populated by every channel handler on inbound messages:

```sql
CREATE TABLE user_known_chats (
  user_id  TEXT NOT NULL,
  channel  TEXT NOT NULL,   -- 'telegram', 'slack', 'whatsapp', 'email', ...
  chat_id  TEXT NOT NULL,
  chat_name TEXT,           -- human-readable: "Dieta", "#health", "Wojtek (DM)"
  chat_type TEXT,           -- 'private', 'group', 'supergroup', 'channel', 'dm', ...
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, channel, chat_id)
);
```

**Upsert logic:** Each channel handler (Telegram, Slack, WhatsApp, etc.) calls a shared `upsertKnownChat()` function on every inbound message. Updates `chat_name` and `last_seen_at` on conflict.

**Data sources per channel:**
- Telegram: `ctx.chat.id`, `ctx.chat.title` or `ctx.chat.first_name`, `ctx.chat.type`
- Slack (future): `event.channel`, channel name from API, channel type
- WhatsApp (future): phone number or group ID, contact name, chat type

### 2. Skill Channel Preferences (per-user file)

File: `.janus/users/{userId}/skill-channels.json`

```json
{
  "diet-tracker": {
    "channel": "telegram",
    "chatId": "-1001234567890",
    "chatName": "Dieta",
    "setAt": "2026-04-25T10:00:00Z"
  },
  "stock-watcher": {
    "channel": "telegram",
    "chatId": "123456",
    "chatName": "Private",
    "setAt": "2026-04-25T10:05:00Z"
  }
}
```

**Why a file, not config:**
- Runtime state managed by the LLM via `read_file`/`write_file`
- No restart or config reload needed
- Consistent with existing per-user file pattern (PROFILE.md, food-diary/)
- Each user's preferences isolated in their own directory

### 3. Context Builder Changes

Load both data sources and inject into the **dynamic** part of the prompt (per-user, per-request).

**Known chats section** — all chats this user has been seen in:

```xml
<your_chats>
- telegram:123456 (Private: Wojtek)
- telegram:-1001234567890 (Group: Dieta)
- slack:#random (Channel: random)
</your_chats>
```

**Skill channel preferences** — active preferences with routing reminders:

```xml
<skill_channels>
- diet-tracker → telegram:-1001234567890 (Dieta)
- stock-watcher → telegram:123456 (Private)

When a skill has a preferred channel different from the current chat:
- Send a brief redirect note on current chat
- Use the message tool to deliver the actual response to the preferred channel
</skill_channels>
```

Both sections only appear if the user has data. No empty tags in prompt.

### 4. Skill Instructions Convention

Skills that support channel preferences add a `## Channel Preference` section:

```markdown
## Channel Preference

This skill supports dedicated channel routing.

### First use (no preference saved)
1. Default suggestion = current chat (where user is writing from)
2. Show other available chats from <your_chats>
3. Ask user to confirm or pick different channel
4. Save to skill-channels.json via write_file

### Normal operation (preference exists)
- All output (interactive + cron/heartbeat) goes to preferred channel
- If current chat ≠ preferred channel:
  - Brief redirect on current chat: "→ [channel name]"
  - Full response via message tool to preferred channel

### Channel change
- User says "change diet channel to X" at any time
- Update skill-channels.json
- Update ALL heartbeat entries for this skill (chat: field in HEARTBEAT.md)
- Update active cron jobs (chat_id)
- Confirm: "Moved to [new channel]. Heartbeats updated."

### Fallback
- If message delivery to preferred channel fails (403/400):
  - Fall back to user's private chat (1:1)
  - Notify user: "Can't reach [channel], switched to private"
  - Update skill-channels.json with fallback channel
```

## Flows

### First Use — Skill Setup

```
User writes from "Dieta" group → skill activates
→ Agent reads skill-channels.json → no entry for diet-tracker
→ "Where should I send diet updates?"
   • This chat — Dieta (default)
   • telegram:123456 — Private
→ User: "tutaj" / picks Dieta
→ write_file skill-channels.json: { "diet-tracker": { "channel": "telegram", "chatId": "-100...", "chatName": "Dieta" } }
→ Heartbeat tasks created with chat: -100...
→ All diet output → Dieta group
```

### Wrong Channel — Redirect

```
User writes "jadłem sałatkę" on 1:1 private chat
→ Agent reads skill_channels: diet-tracker → Dieta
→ On 1:1: "📋 Loguję na Dieta"
→ Via message tool on Dieta: full DAY STATUS report
```

### Channel Change

```
User: "zmień kanał diety na prywatny"
→ Update skill-channels.json: diet-tracker → telegram:123456 (Private)
→ Update HEARTBEAT.md: all diet heartbeat entries → chat: 123456
→ Update cron jobs: matching diet heartbeats → chatId = 123456
→ "✅ Dieta → Private. Heartbeaty zaktualizowane."
```

### Multi-User Same Channel

```
Wojtek writes "sałatka 300kcal" on Dieta group
→ user-resolver: Wojtek → userId "wojtek"
→ diet-tracker writes to users/wojtek/food-diary/

Monika writes "jajecznica 3 jajka" on Dieta group
→ user-resolver: Monika → userId "monika"
→ diet-tracker writes to users/monika/food-diary/

Channel shared, data per-user. Each user has own profile, targets, diary.
```

### Delivery Failure — Fallback

```
Heartbeat fires → sends to Dieta group
→ Telegram returns 403 (bot kicked from group)
→ Agent detects failure
→ Falls back to user's 1:1: "Nie mogę pisać na Dieta — przełączam na prywatny"
→ Updates skill-channels.json automatically
```

### Migration — Existing Users

```
Existing user has diet heartbeats but no skill-channels.json
→ Skill detects: heartbeats exist, no channel preference
→ One-time question: "Where should diet updates go? Currently your heartbeats target [chatId]"
→ User confirms or changes
→ skill-channels.json created, heartbeats updated if needed
```

## Changes Required

### Code Changes

| File | Change |
|------|--------|
| `src/db/migrations/NNN-user-known-chats.sql` | New `user_known_chats` table |
| `src/db/database.ts` | `upsertKnownChat()` and `getKnownChats(userId)` methods |
| `src/channels/telegram-channel.ts` | Call `upsertKnownChat()` on every inbound message |
| `src/context/context-builder.ts` | Load `skill-channels.json` + `user_known_chats`, inject into dynamic prompt |
| `src/users/user-resolver.ts` | Helper `loadSkillChannels(userId)` to read the JSON file |

### Skill Changes

| File | Change |
|------|--------|
| `skills/diet-tracker/SKILL.md` | Add `## Channel Preference` section with routing rules |
| `skills/diet-tracker/install.md` | Step 11 (Chat) — save to `skill-channels.json`, not just heartbeat chat field |
| `skills/diet-tracker/uninstall.md` | Clean up `skill-channels.json` entry |

### Future Channel Handlers (no changes now)

When Slack/WhatsApp/email handlers are implemented, each one calls `upsertKnownChat()` on inbound — same pattern as Telegram. No framework changes needed.

## What We're NOT Doing

- **Hardcoded routing in agent-loop** — prompt-level routing is sufficient, consistent with Janus philosophy
- **Multi-channel per skill** — one preferred channel per skill per user. YAGNI.
- **Config schema changes** — this is runtime state, not admin config
- **Global known_chats** — always per-user scoped
- **Channel-specific logic in framework** — `(channel, chatId)` pair everywhere, handlers are pluggable

## Testing

- Unit: `upsertKnownChat()`, `getKnownChats()`, `loadSkillChannels()`
- Unit: context-builder injects `<your_chats>` and `<skill_channels>` correctly
- Unit: context-builder omits sections when no data
- Integration: Telegram handler upserts known chats on inbound message
- Manual: diet-tracker first-use flow, channel change, wrong-channel redirect
