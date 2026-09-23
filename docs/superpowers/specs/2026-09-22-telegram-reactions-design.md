# Telegram reactions — design

**Date:** 2026-09-22
**Status:** approved, not implemented

## Problem

Two things users expect from a Telegram assistant do not work:

1. **Janus cannot react.** Asked to "react 👍 to each of my messages so I know you read them" (so the chat is not flooded with "OK, got it" texts), Janus has no way to do it. There is no tool, and the agent never sees Telegram's `message_id`, so it could not name a target even if there were one.
2. **Janus does not understand the user's reactions.** The `message_reaction` handler exists (`telegram-channel.ts`) but forwards only `[Reaction: 👍]`. It drops `reaction.message_id`, so the agent cannot tell *what* was confirmed. This is worst for cron-delivered reminders, which do not land in the chat session at all (known open bug), so the agent cannot even find the message in history.

Root cause shared by both: **Telegram message IDs never reach the agent.**

Telegram-side constraints (Bot API docs, not ours to fix):
- In groups a bot receives `message_reaction` only if it is a chat **administrator**. Private chats have no such requirement.
- Reaction updates carry `chat`, `message_id`, `user`, `old_reaction`, `new_reaction` — never the message text.
- Reactions set by bots are never delivered, so Janus reacting cannot loop into itself.
- Bots may set one reaction per message, from the standard emoji set; an unsupported emoji fails with 400.

## Decisions (with the user)

| Question | Decision |
|---|---|
| User reacts 👍 to a bot message | Treat as a reply to *that* message: act on it and **answer in text**. |
| When does Janus react itself | **Agent decides**, guided by AGENTS.md: when asked, or when a reaction is a sufficient answer. A reaction-only turn ends with **no text**. |
| Where does the reacted-to text come from | **In-memory per-chat buffer** in the Telegram channel (approach A). SQLite-backed store (B) is the upgrade path if restarts turn out to lose context too often. |

Out of scope: reacting to arbitrary older messages (only the current one or an explicit ID), anonymous reactions (`message_reaction_count`), reaction support in other channels, persistence across restarts.

## Design

### 1. Recent message buffer — `src/channels/telegram-message-store.ts`

`TelegramMessageStore` keeps, per base chat ID (no topic suffix — `message_id` is unique per chat), the last **200** messages:

```ts
interface StoredMessage {
  text: string;        // first 300 chars, whitespace-collapsed
  fromBot: boolean;
  topicId?: number;    // forum topic the message lives in
  authorId?: string;   // sender's Telegram user ID — user messages only
  authorName?: string; // sender's first name, else username
}
record(chatId: string, messageId: number, entry: StoredMessage): void
get(chatId: string, messageId: number): StoredMessage | undefined
```

Insertion-ordered `Map` per chat; oldest entry evicted past the cap; re-recording an ID (stream edits) overwrites its text in place. No timers, no I/O.

**Recording points** (all already exist in `telegram-channel.ts`):
- Outbound plain message — every chunk's `sent.message_id` with that chunk's text.
- Outbound stream — initial `sendMessage` records the ID; `handleStreamEnd` re-records it with the final text.
- Cron / heartbeat deliveries go through the same outbound paths, so reminders are covered with no extra code.
- Inbound text, photo caption, voice transcript — `ctx.message.message_id` with `fromBot: false` and the sender (`authorId`, `authorName`).

### 2. User reaction → agent

The `message_reaction` handler looks the target up and builds the content with a pure, exported function:

```ts
formatReactionContent(emoji: string, target: StoredMessage | undefined, reactorId?: string): string
// → [Reaction 👍 to your message: "Przypomnieć o dentyście o 17?"]
// → [Reaction 👍 to my message: "…"]            (reactor reacted to their own message)
// → [Reaction 👍 to a message from Ola: "…"]    (group: reacted to someone else's message)
// → [Reaction 👍 to an earlier message (text unavailable)]
```

"your" is from the agent's point of view (`fromBot: true`). "my" requires the stored `authorId` to equal the reactor's user ID; any other author — or an unknown reactor — is named (`a message from <authorName>`, else `another user`). *Amended 2026-09-23: the first version said "my message" for every non-bot message, which in a group attributed B's message to A when A reacted to it.* When the target is known and has a `topicId`, the inbound `chatId` becomes `{base}/{topicId}`, so a reaction in a forum topic reaches the topic's session instead of the group's. The inbound message also carries `channelMessageId` = the reacted-to message ID, so a `react` in reply targets that message.

Everything else in the handler (allowlist, user resolution, scope, steering buffer) is unchanged. Removals and custom emoji stay ignored.

An emoji sent as a **message** (plain "👍" text) already goes through the normal text path and is not touched.

### 3. Janus reacts — `react` tool

- `InboundMessage.channelMessageId?: number` — the channel's own ID of the triggering message. Set by the Telegram text, photo, voice and reaction handlers.
- `RequestContext.channel?: string` and `RequestContext.channelMessageId?: number` — filled by the agent loop from the inbound message, next to `chatId`.
- `OutboundMessage.type` gains `'reaction'`, with `reactTo?: number` (target message ID); `content` holds the emoji.

`src/tools/builtin/react.ts`:

```
react({ emoji: string, message_id?: number })
```

Targets `message_id` if given, else `reqCtx.channelMessageId`, in the current conversation (`reqCtx.channel` + `reqCtx.chatId`). Publishes one `'reaction'` outbound message and returns `Reacted 👍`. Returns an error string when there is no current channel message (CLI, cron-originated turns) or no emoji. The tool knows nothing about Telegram, mirroring `send_file`. Registered with the other built-ins in `bootstrap.ts`, so per-user and per-agent tool allow/deny lists apply to it unchanged.

Telegram outbound handler, `type === 'reaction'`: `bot.api.setMessageReaction(chatId, reactTo, [{ type: 'emoji', emoji }])`. Failures (unsupported emoji, missing rights) are logged at warn and not retried. The outbound path is fire-and-forget, so the agent is not told about a failed reaction — acceptable for a cosmetic action, and the log shows it.

### 4. Behaviour — AGENTS.md, not code

New `## Reactions` section, added to `examples/AGENTS.md` for new workspaces and appended to existing workspaces by `update` (the mechanism `ensureStateUncertaintySection` already uses — generalised to `ensureAgentsSection(cwd, heading, body)` so both sections share it). Auto-update runs it too (`finalizeUpdate` → worker).

Content, in substance:
- `[Reaction X to your message: "…"]` is the user answering that message — do what it confirms or declines, then reply in text.
- You can react with the `react` tool. Use it when the user asks for it, or when an emoji is a complete answer (thanks, a photo). When the reaction is the whole answer, end the turn with no text.
- A standing preference ("always 👍 my messages instead of replying") belongs in PROFILE.md so it survives compaction and restarts.

An empty final response is already dropped by the channel (`telegram-channel.ts`: "skipping empty message"; the stream path sends nothing when no chunk arrived), so a reaction-only turn needs no new plumbing — only a test that pins it.

## Testing

- `telegram-message-store`: cap and eviction order, 300-char truncation, overwrite on re-record, chats isolated.
- `formatReactionContent`: bot message, user message, unknown target.
- `react` tool: publishes `{type:'reaction', reactTo, content}`; explicit `message_id` wins; errors without channel message or emoji.
- Telegram channel: `'reaction'` outbound calls `setMessageReaction` with the right arguments; reaction handler routes to the topic session when the store knows the topic.
- `ensureAgentsSection`: appends once, idempotent, no-op without AGENTS.md (existing State-uncertainty tests keep passing).
- Telegram channel: an empty `'message'` outbound sends nothing (pins the reaction-only turn).

## Docs

`janus.example.json` — no new config. FEATURES.md, CLAUDE.md status, CHANGELOG, ROADMAP counts. Note in FEATURES/README that group reactions need the bot to be a group admin.
