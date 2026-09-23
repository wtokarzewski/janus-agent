# Telegram Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Janus understands which message a user's Telegram reaction refers to, and can react with an emoji itself (including reaction-only replies).

**Architecture:** An in-memory per-chat buffer in the Telegram channel remembers recent messages (`message_id → text snippet`), so a reaction update can be turned into `[Reaction 👍 to your message: "…"]`. The Telegram `message_id` of the triggering message travels on `InboundMessage` → `RequestContext`; a channel-agnostic `react` tool publishes a `'reaction'` outbound message that the Telegram channel turns into `setMessageReaction`. Behaviour is instructed through a new `## Reactions` section in AGENTS.md, synced to existing workspaces by `update`.

**Tech Stack:** TypeScript (ESM), grammy (`bot.api.setMessageReaction`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-22-telegram-reactions-design.md`

## Global Constraints

- TypeScript ESM; imports use `.js` suffixes (`'../bus/types.js'`).
- Code and comments in English. No references to other projects in code.
- No hardcoded domain text patterns (CODING.md rule) — detection is structural.
- Buffer: 200 messages per chat, 300-char snippets, in memory only.
- No new config fields (so no `janus.example.json` change).
- Never use real tokens/IDs from config as test data — fabricate values.
- Commits: English, no `Co-Authored-By`, no "Generated with Claude Code" footer.
- Work on branch `feat/telegram-reactions` (already created; spec committed as 6b6edeb).
- Run a single test file with: `npx vitest run tests/unit/<file>.test.ts`. Full suite: `npm test`. Types: `npm run typecheck`.

## File Structure

| File | Responsibility |
|---|---|
| `src/channels/telegram-message-store.ts` (new) | `TelegramMessageStore` — bounded per-chat `message_id → StoredMessage` buffer. Pure data structure. |
| `src/channels/telegram-reactions.ts` (new) | Pure helpers: `formatReactionContent`, `resolveReactionRoute`, `applyReaction`. |
| `src/tools/builtin/react.ts` (new) | `ReactTool` — channel-agnostic `react` tool. |
| `src/bus/types.ts` | `InboundMessage.channelMessageId`, `OutboundMessage` `'reaction'` type + `reactTo`. |
| `src/tools/types.ts` | `RequestContext.channel`, `RequestContext.channelMessageId`. |
| `src/agent/agent-loop.ts` | Fill the two new `RequestContext` fields. |
| `src/bootstrap.ts` | Register `ReactTool`. |
| `src/channels/telegram-channel.ts` | Record messages into the store; new reaction content/routing; handle `'reaction'` outbound. |
| `src/commands/update.ts` | Generic `ensureAgentsSection`; `REACTIONS_SECTION`; call it in `finalizeUpdate`. |
| `examples/AGENTS.md`, `AGENTS.md` | `## Reactions` section. |
| Tests | `tests/unit/telegram-message-store.test.ts`, `tests/unit/telegram-reactions.test.ts`, `tests/unit/react-tool.test.ts`, `tests/unit/update-agents-migration.test.ts` (extend). |

---

### Task 1: Message buffer

**Files:**
- Create: `src/channels/telegram-message-store.ts`
- Test: `tests/unit/telegram-message-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StoredMessage { text: string; fromBot: boolean; topicId?: number }
  export const STORE_MAX_PER_CHAT = 200;
  export const STORE_SNIPPET_CHARS = 300;
  export class TelegramMessageStore {
    constructor(maxPerChat?: number);
    record(chatId: string, messageId: number, entry: StoredMessage): void;
    get(chatId: string, messageId: number): StoredMessage | undefined;
  }
  ```
  `chatId` is always the **base** Telegram chat ID (no `/topic` suffix). `record` collapses whitespace and truncates `text` to `STORE_SNIPPET_CHARS` (appending `…` when cut).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/telegram-message-store.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/telegram-message-store.test.ts`
Expected: FAIL — cannot resolve `../../src/channels/telegram-message-store.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/channels/telegram-message-store.ts
/**
 * Recent Telegram messages per chat, so a reaction update — which carries only
 * chat and message IDs, never text — can be told apart: "👍 to *which* message".
 * In memory only; entries from before a restart are simply unknown.
 */

export interface StoredMessage {
  text: string;
  fromBot: boolean;
  topicId?: number;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/telegram-message-store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-message-store.ts tests/unit/telegram-message-store.test.ts
git commit -m "feat(telegram): in-memory buffer of recent messages per chat"
```

---

### Task 2: Reaction helpers

**Files:**
- Create: `src/channels/telegram-reactions.ts`
- Test: `tests/unit/telegram-reactions.test.ts`

**Interfaces:**
- Consumes: `StoredMessage`, `TelegramMessageStore` from Task 1.
- Produces:
  ```ts
  export function formatReactionContent(emoji: string, target: StoredMessage | undefined): string;
  export function resolveReactionRoute(
    store: TelegramMessageStore, baseChatId: string, messageId: number, emoji: string,
  ): { chatId: string; content: string; topicId?: number };
  export interface ReactionApi {
    setMessageReaction(chatId: number | string, messageId: number, reaction: Array<{ type: 'emoji'; emoji: string }>): Promise<unknown>;
  }
  export async function applyReaction(api: ReactionApi, chatId: string, messageId: number, emoji: string): Promise<void>;
  ```
  `formatReactionContent` wording (the agent is "I"; `fromBot: true` = "your message" from the agent's point of view):
  - bot message → `[Reaction 👍 to your message: "<text>"]`
  - user's own message → `[Reaction 👍 to my message: "<text>"]`
  - unknown → `[Reaction 👍 to an earlier message (text unavailable)]`
  `resolveReactionRoute` returns `chatId` = `${baseChatId}/${topicId}` when the stored target has a `topicId`, else `baseChatId`.
  `applyReaction` passes the emoji through as the grammy `ReactionTypeEmoji` shape; it throws whatever the API throws (callers log).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/telegram-reactions.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/telegram-reactions.test.ts`
Expected: FAIL — cannot resolve `../../src/channels/telegram-reactions.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/channels/telegram-reactions.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/telegram-reactions.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-reactions.ts tests/unit/telegram-reactions.test.ts
git commit -m "feat(telegram): reaction content, topic routing and setMessageReaction helper"
```

---

### Task 3: `react` tool and message-ID plumbing

**Files:**
- Modify: `src/bus/types.ts` (`InboundMessage`, `OutboundMessage`)
- Modify: `src/tools/types.ts` (`RequestContext`)
- Modify: `src/agent/agent-loop.ts:392-401` (the `reqCtx` literal)
- Create: `src/tools/builtin/react.ts`
- Modify: `src/bootstrap.ts:21,174` (import + register)
- Test: `tests/unit/react-tool.test.ts`

**Interfaces:**
- Produces:
  - `InboundMessage.channelMessageId?: number`
  - `OutboundMessage.type` union gains `'reaction'`; `OutboundMessage.reactTo?: number`
  - `RequestContext.channel?: string`, `RequestContext.channelMessageId?: number`
  - `export class ReactTool implements Tool` with `name = 'react'`, constructor `(bus: MessageBus)`, `execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string>` (reads `args.emoji`, `args.message_id`)
  - Outbound published: `{ channel: reqCtx.channel, chatId: reqCtx.chatId, type: 'reaction', reactTo, content: emoji, timestamp }`
- Rule: the tool requires `reqCtx.channelMessageId` (proof the current channel has message IDs) even when `message_id` is explicit — this keeps CLI and cron turns from publishing reactions nobody can render.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/react-tool.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ReactTool } from '../../src/tools/builtin/react.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import type { RequestContext } from '../../src/tools/types.js';

function setup() {
  const bus = new MessageBus();
  const publish = vi.spyOn(bus, 'publishOutbound').mockResolvedValue(undefined);
  return { tool: new ReactTool(bus), publish };
}

const telegramCtx: RequestContext = { channel: 'telegram', chatId: '555', channelMessageId: 10 };

describe('ReactTool', () => {
  it('reacts to the current message by default', async () => {
    const { tool, publish } = setup();
    const result = await tool.execute({ emoji: '👍' }, telegramCtx);
    expect(result).toBe('Reacted 👍');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][0]).toMatchObject({
      channel: 'telegram', chatId: '555', type: 'reaction', reactTo: 10, content: '👍',
    });
  });

  it('uses an explicit message_id when given', async () => {
    const { tool, publish } = setup();
    await tool.execute({ emoji: '❤️', message_id: 7 }, telegramCtx);
    expect(publish.mock.calls[0][0]).toMatchObject({ reactTo: 7, content: '❤️' });
  });

  it('keeps the forum topic chatId as-is', async () => {
    const { tool, publish } = setup();
    await tool.execute({ emoji: '👍' }, { ...telegramCtx, chatId: '-100777/42' });
    expect(publish.mock.calls[0][0]).toMatchObject({ chatId: '-100777/42' });
  });

  it('refuses without an emoji', async () => {
    const { tool, publish } = setup();
    expect(await tool.execute({}, telegramCtx)).toMatch(/^Error: /);
    expect(publish).not.toHaveBeenCalled();
  });

  it('refuses when the conversation has no channel message (CLI, cron)', async () => {
    const { tool, publish } = setup();
    expect(await tool.execute({ emoji: '👍' }, { channel: 'cli', chatId: 'cli' })).toMatch(/^Error: /);
    expect(await tool.execute({ emoji: '👍', message_id: 5 }, { channel: 'cli', chatId: 'cli' })).toMatch(/^Error: /);
    expect(await tool.execute({ emoji: '👍' }, undefined)).toMatch(/^Error: /);
    expect(publish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/react-tool.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/builtin/react.js`.

- [ ] **Step 3: Extend the types**

In `src/bus/types.ts`, inside `InboundMessage` after the `routingMeta` field:

```ts
  /** The channel's own ID of the triggering message (Telegram message_id).
   *  For a reaction: the message that was reacted to. */
  channelMessageId?: number;
```

In `OutboundMessage`, replace the `type` line and add `reactTo` after `voiceReply`:

```ts
  type?: 'message' | 'chunk' | 'stream_end' | 'stream_flush' | 'typing' | 'typing_stop' | 'reaction';
```

```ts
  /** For type 'reaction': the channel message ID to react to; `content` holds the emoji. */
  reactTo?: number;
```

In `src/tools/types.ts`, inside `RequestContext` after `chatId?: string;`:

```ts
  /** Channel of the conversation being handled (e.g. "telegram", "cli"). */
  channel?: string;
  /** The channel's ID of the message being handled; absent for CLI and system turns. */
  channelMessageId?: number;
```

- [ ] **Step 4: Write the tool**

```ts
// src/tools/builtin/react.ts
import type { Tool, RequestContext } from '../types.js';
import type { MessageBus } from '../../bus/message-bus.js';

/**
 * React to a message with an emoji in the current conversation. Channel-agnostic:
 * publishes a 'reaction' outbound message; the channel decides how to render it.
 */
export class ReactTool implements Tool {
  name = 'react';
  description =
    'React with an emoji to a message in the current conversation (Telegram). ' +
    'Defaults to the message you are answering. Use standard reactions such as 👍 👎 ❤️ 🔥 👏 😁 🤔 🙏 👌 🎉. ' +
    'A reaction can be the whole answer — then reply with no text.';
  parameters = {
    type: 'object',
    properties: {
      emoji: { type: 'string', description: 'A single emoji, e.g. "👍"' },
      message_id: { type: 'number', description: 'Optional: react to this message ID instead of the current one' },
    },
    required: ['emoji'],
  };

  constructor(private bus: MessageBus) {}

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const emoji = typeof args.emoji === 'string' ? args.emoji.trim() : '';
    if (!emoji) return 'Error: No emoji provided';

    if (!reqCtx?.channel || !reqCtx.chatId || reqCtx.channelMessageId === undefined) {
      return 'Error: Reactions are only available when answering a chat message (e.g. Telegram)';
    }

    const reactTo = typeof args.message_id === 'number' ? args.message_id : reqCtx.channelMessageId;

    await this.bus.publishOutbound({
      channel: reqCtx.channel,
      chatId: reqCtx.chatId,
      content: emoji,
      timestamp: new Date(),
      type: 'reaction',
      reactTo,
    });
    return `Reacted ${emoji}`;
  }
}
```

`Tool` (`src/tools/types.ts`) is `{ name; description; parameters; ownerOnly?; execute(args, reqCtx?) }` — `ReactTool` needs no `setContext`, so it implements `Tool`, not `ContextualTool`.

- [ ] **Step 5: Fill `RequestContext` in the agent loop**

In `src/agent/agent-loop.ts`, the `reqCtx` literal (around line 392) becomes:

```ts
    const reqCtx: RequestContext = {
      chatId: msg.chatId,
      channel: msg.channel,
      channelMessageId: msg.channelMessageId,
      userId: msg.user?.userId,
      isOwner,
      familyUserIds,
      userToolAllow: mergedToolAllow,
      userToolDeny: mergedToolDeny.length > 0 ? mergedToolDeny : undefined,
      toolPolicy: userProfile?.tools?.policy,
      sentTargets: externalReqCtx?.sentTargets ?? [],
    };
```

- [ ] **Step 6: Register the tool**

In `src/bootstrap.ts` add next to the `SendFileTool` import:

```ts
import { ReactTool } from './tools/builtin/react.js';
```

and after `tools.register(new SendFileTool(bus));`:

```ts
  tools.register(new ReactTool(bus));
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/unit/react-tool.test.ts && npm run typecheck`
Expected: PASS (5 tests), typecheck clean.

Run: `npm test`
Expected: all pass. If a test asserts the exact built-in tool count or tool list (grep `tests/` for `'send_file'` next to a count), update it to include `react`.

- [ ] **Step 8: Commit**

```bash
git add src/bus/types.ts src/tools/types.ts src/agent/agent-loop.ts src/tools/builtin/react.ts src/bootstrap.ts tests/unit/react-tool.test.ts
git commit -m "feat(tools): react tool and channel message IDs in the request context"
```

---

### Task 4: Wire the Telegram channel

**Files:**
- Modify: `src/channels/telegram-channel.ts`

**Interfaces:**
- Consumes: `TelegramMessageStore` (Task 1); `resolveReactionRoute`, `applyReaction` (Task 2); `InboundMessage.channelMessageId`, `OutboundMessage` `'reaction'`/`reactTo` (Task 3); existing `parseTelegramChatId(chatId): { chatId: string; topicId?: number }`.

No new unit test file: the pieces with logic are covered by Tasks 1–3, and this file has no bot harness (its tests cover pure helpers only). Verification is typecheck + full suite + the manual check in Task 6.

**Deviation from the spec:** the spec lists a channel test pinning "empty `'message'` outbound sends nothing". That code path (`telegram-channel.ts`, `if (!cleaned) { … skipping empty message }`) sits inside the `registerHandler` closure with no harness; building one for a single existing guard is out of proportion. The manual check (Task 6, step 4.2) covers the reaction-only turn end to end instead.

- [ ] **Step 1: Add the store and a recording helper**

Imports at the top:

```ts
import { TelegramMessageStore } from './telegram-message-store.js';
import { resolveReactionRoute, applyReaction } from './telegram-reactions.js';
```

Class fields, after `sentHashes`:

```ts
  /** Recent messages per chat — lets a reaction name the message it refers to. */
  private messageStore = new TelegramMessageStore();
```

Private method (place it right before `handleChunk`):

```ts
  /** Remember a message under its base chat; `chatId` may carry a `/topic` suffix. */
  private remember(chatId: string, messageId: number, text: string, fromBot: boolean): void {
    if (!messageId || !text) return;
    const { chatId: baseChatId, topicId } = parseTelegramChatId(chatId);
    this.messageStore.record(baseChatId, messageId, { text, fromBot, ...(topicId ? { topicId } : {}) });
  }
```

- [ ] **Step 2: Handle `'reaction'` outbound**

In the `bus.registerHandler('telegram', …)` callback, directly after the `typing_stop` block:

```ts
      if (msg.type === 'reaction') {
        if (msg.reactTo === undefined || !msg.content) return;
        try {
          await applyReaction(bot.api, tgChatId, msg.reactTo, msg.content);
        } catch (err) {
          log.warn(`Telegram: reaction ${msg.content} on ${msg.chatId}/${msg.reactTo} failed: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }
```

- [ ] **Step 3: Record outbound plain messages**

In the chunk loop of the plain-message path, capture the result of both `sendMessage` calls:

```ts
      for (const chunk of chunks) {
        try {
          const sent = await bot.api.sendMessage(tgChatId, chunk, topicOpts);
          this.remember(msg.chatId, sent.message_id, chunk, true);
        } catch (err) {
          log.error(`Telegram: failed to send message to ${msg.chatId}: ${err instanceof Error ? err.message : err}`);
          // Retry once after 429 cooldown
          const retryAfter = parseRetryAfter(err);
          if (retryAfter) {
            await delay(retryAfter * 1000);
            try {
              const sent = await bot.api.sendMessage(tgChatId, chunk, topicOpts);
              this.remember(msg.chatId, sent.message_id, chunk, true);
            } catch (retryErr) {
              log.error(`Telegram: retry also failed for ${msg.chatId}: ${retryErr instanceof Error ? retryErr.message : retryErr}`);
            }
          }
        }
      }
```

- [ ] **Step 4: Record streamed messages**

In `handleStreamEnd`, capture the send result and record the final text. Replace the two `if (state.messageId === 0) { await bot.api.sendMessage(...) }` branches (first attempt and retry) so they assign the ID:

```ts
      if (state.messageId === 0) {
        const sent = await bot.api.sendMessage(tgChatId, finalText, state.topicOpts ?? {});
        state.messageId = sent.message_id;
      } else {
        await bot.api.editMessageText(tgChatId, state.messageId, finalText);
      }
```

(same shape inside the retry `try`). Then, just before `this.streamStates.delete(chatId);`:

```ts
    this.remember(chatId, state.messageId, finalText, true);
```

`remember` ignores `messageId === 0`, so a stream whose every send failed records nothing.

- [ ] **Step 5: Record inbound messages and pass their IDs**

Text handler — add to the `inbound` literal (after `routingMeta`):

```ts
        channelMessageId: ctx.message.message_id,
```

and right after the literal:

```ts
      this.remember(chatId, ctx.message.message_id, ctx.message.text, false);
```

Voice handler — same `channelMessageId: ctx.message.message_id,` in its literal, and after it:

```ts
      this.remember(chatId, ctx.message.message_id, `[Voice] ${transcript}`, false);
```

Photo handler — same field, and after it:

```ts
      this.remember(chatId, ctx.message.message_id, caption || '[Photo]', false);
```

- [ ] **Step 6: Rewrite the reaction content and routing**

In the `message_reaction` handler replace:

```ts
      const baseChatId = String(reaction.chat.id);
      const chatId = baseChatId;
```

with:

```ts
      const baseChatId = String(reaction.chat.id);
      const route = resolveReactionRoute(this.messageStore, baseChatId, reaction.message_id, emoji);
      const chatId = route.chatId;
```

and in its `inbound` literal replace `content: \`[Reaction: ${emoji}]\`,` with:

```ts
        content: route.content,
        channelMessageId: reaction.message_id,
        ...(route.topicId ? { topicId: route.topicId, routingMeta: { topicId: route.topicId } } : {}),
```

Leave the allowlist check on `baseChatId` untouched (a topic must not bypass it). Update the leading comment to:

```ts
    // Emoji reactions — delivered only to group admins (Telegram rule; private chats always).
    // The update has no text, so the buffer supplies which message was reacted to.
```

- [ ] **Step 7: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/channels/telegram-channel.ts
git commit -m "feat(telegram): tell the agent which message a reaction refers to, render react"
```

---

### Task 5: AGENTS.md `## Reactions` section

**Files:**
- Modify: `src/commands/update.ts` (generalise `ensureStateUncertaintySection`, add `REACTIONS_SECTION`, call in `finalizeUpdate`)
- Modify: `examples/AGENTS.md`, `AGENTS.md` (insert section before `## Communication`)
- Test: `tests/unit/update-agents-migration.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export async function ensureAgentsSection(cwd: string, heading: string, body: string): Promise<void>;
  export async function ensureStateUncertaintySection(cwd: string): Promise<void>; // unchanged signature, now a wrapper
  export async function ensureReactionsSection(cwd: string): Promise<void>;
  ```
  `heading` is the full line, e.g. `'## Reactions'`; `body` is the whole section text starting with that heading.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/update-agents-migration.test.ts` (update the import line to `import { ensureStateUncertaintySection, ensureReactionsSection } from '../../src/commands/update.js';`):

```ts
describe('ensureReactionsSection', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'update-agents-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('appends the section once', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# AGENTS.md\n\n## State uncertainty\n\nx\n');
    await ensureReactionsSection(cwd);
    await ensureReactionsSection(cwd);
    const content = readFileSync(join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content.match(/## Reactions/g)).toHaveLength(1);
    expect(content).toContain('`react`');
    expect(content).toContain('## State uncertainty'); // existing content kept
  });

  it('skips silently when AGENTS.md does not exist', async () => {
    await ensureReactionsSection(cwd);
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/update-agents-migration.test.ts`
Expected: FAIL — `ensureReactionsSection` is not exported.

- [ ] **Step 3: Generalise and add the section**

In `src/commands/update.ts`, replace the body of `ensureStateUncertaintySection` and add the new pieces:

```ts
const REACTIONS_SECTION = `## Reactions

- \`[Reaction 👍 to your message: "…"]\` is the user answering that message of yours. Do what it confirms or declines, then reply in text.
- You can react yourself with the \`react\` tool. Use it when the user asks for it, or when an emoji is a complete answer (thanks, a photo, a quick acknowledgement). When the reaction is the whole answer, end the turn with no text.
- A standing request like "react 👍 to my messages instead of replying" is a preference — save it to the user's PROFILE.md so it survives restarts.
`;

/** Append a section to the workspace AGENTS.md unless its heading is already there. */
export async function ensureAgentsSection(cwd: string, heading: string, body: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const agentsPath = resolve(cwd, 'AGENTS.md');
  let content: string;
  try {
    content = await readFile(agentsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // workspace doesn't have AGENTS.md yet — onboard step handles creation
    }
    throw err;
  }
  const title = heading.replace(/^#+\s*/, '');
  if (content.includes(heading)) {
    console.log(`  AGENTS.md already has ${title} section.`);
    return;
  }
  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(agentsPath, content + separator + body, 'utf-8');
  console.log(chalk.green(`  + AGENTS.md updated with ${title} section`));
}

export async function ensureStateUncertaintySection(cwd: string): Promise<void> {
  await ensureAgentsSection(cwd, '## State uncertainty', STATE_UNCERTAINTY_SECTION);
}

export async function ensureReactionsSection(cwd: string): Promise<void> {
  await ensureAgentsSection(cwd, '## Reactions', REACTIONS_SECTION);
}
```

In `finalizeUpdate`, after `await ensureStateUncertaintySection(cwd);`:

```ts
  await ensureReactionsSection(cwd);
```

- [ ] **Step 4: Add the section to both AGENTS.md files**

In `examples/AGENTS.md` and in the repo-root `AGENTS.md`, insert immediately before the `## Communication` line (with one blank line after it):

```markdown
## Reactions

- `[Reaction 👍 to your message: "…"]` is the user answering that message of yours. Do what it confirms or declines, then reply in text.
- You can react yourself with the `react` tool. Use it when the user asks for it, or when an emoji is a complete answer (thanks, a photo, a quick acknowledgement). When the reaction is the whole answer, end the turn with no text.
- A standing request like "react 👍 to my messages instead of replying" is a preference — save it to the user's PROFILE.md so it survives restarts.

```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/unit/update-agents-migration.test.ts`
Expected: PASS — the 5 existing State-uncertainty tests (their log/text expectations are unchanged) plus the 2 new ones.

- [ ] **Step 6: Commit**

```bash
git add src/commands/update.ts examples/AGENTS.md AGENTS.md tests/unit/update-agents-migration.test.ts
git commit -m "feat(update): Reactions section in AGENTS.md, synced to existing workspaces"
```

---

### Task 6: Docs, verification, PR

**Files:**
- Modify: `FEATURES.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; test count = 885 + the new tests (7 + 8 + 5 + 2 = 22 → 907), files 86 + 3 = 89. Use the numbers vitest actually prints.

- [ ] **Step 2: Update docs**

- `CHANGELOG.md` under `## [Unreleased]` → `### Added`:
  `- **Telegram reactions** — a reaction now reaches the agent with the message it refers to (\`[Reaction 👍 to your message: "…"]\`), routed to the right forum topic; new \`react\` tool lets Janus answer with an emoji alone. Groups deliver reactions only when the bot is an admin.`
- `FEATURES.md`: in the Telegram channel entry add reactions (inbound with quoted target, outbound via `react`, group-admin requirement); in the tools list add `react` and bump the built-in tool count by one.
- `CLAUDE.md`: prepend a `**Status:**` paragraph describing the change (prefix the old one with `Prior:`), add `react` to the `tools/` module line and the tool count, add `telegram-message-store, telegram-reactions, react-tool` to the Testing list, update the test/file counts.
- `docs/ROADMAP.md` "Current State": test and file counts, tool count (16 → 17) and add `react` to the tools list.

- [ ] **Step 3: Commit and open the PR**

```bash
git add CHANGELOG.md FEATURES.md CLAUDE.md docs/ROADMAP.md docs/superpowers/plans/2026-09-23-telegram-reactions.md
git commit -m "docs: Telegram reactions"
git push -u origin feat/telegram-reactions
gh pr create --title "feat(telegram): reactions in both directions" --body "<summary of the spec + test plan; no footer>"
```

Do **not** merge — merging needs the user's explicit go-ahead (repo rule: squash only, CI green; admin bypass only when the user says so).

- [ ] **Step 4: Manual check on the server (after merge + update)** — for the user

1. Private chat: reply 👍 to a Janus message → log shows `Telegram: reaction 👍 …`; Janus answers referring to that message.
2. Ask "od teraz reaguj 👍 na moje wiadomości zamiast odpisywać" → next message gets a 👍, no text.
3. Group: make the bot an admin, repeat 1.
4. `AGENTS.md` in the server workspace contains `## Reactions` after `update`.
