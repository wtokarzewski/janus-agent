# Plan: Multi-Agent Architecture for Janus

## Context

Janus currently runs a single implicit agent that handles all messages. The industry standard for AI agent platforms is **multiple persistent agents** with deterministic routing — one process, multiple personalities/contexts/memories, routed by config-based bindings.

**User's need:** Separate conversation contexts by topic (e.g., one agent for work, one for diet, one general) without running multiple bot instances. Must preserve all existing features (multi-user, per-user profiles, family, forum topics, cron/heartbeat).

**Approach:** Single AgentLoop processes all messages. Each message gets an `agentId` resolved from bindings. The agentId selects the right context (EGO, AGENTS.md, skills, tools, memory, model) and scopes the session key. No architectural rewrites — layering on top.

---

## Phase 1: Core Routing (MVP)

### 1.1 Config schema — `src/config/schema.ts`

Add new schemas before `JanusConfigSchema`:

```typescript
const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  ego: z.string().nullable().optional(),         // path to EGO.md (null=skip, undefined=global)
  agentsFile: z.string().nullable().optional(),   // path to AGENTS.md
  heartbeatFile: z.string().nullable().optional(),
  skillsDirs: z.array(z.string()).default([]),    // extra skill dirs
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  llm: z.object({
    slots: z.record(z.string(), SlotSchema).optional(),  // per-agent model override
  }).optional(),
  params: z.object({
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
  }).optional(),
  memory: z.object({
    shared: z.boolean().default(true),            // false = .janus/agents/{id}/memory/
  }).optional(),
});

// Generic match bag — channel-agnostic, extensible for Discord/Slack/WhatsApp
const BindingSchema = z.object({
  agentId: z.string(),
  match: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
```

Add to `JanusConfigSchema`:

```typescript
agents: z.array(AgentDefinitionSchema).default([]),
bindings: z.array(BindingSchema).default([]),
defaultAgentId: z.string().default('main'),
```

Agent ID validation: `^[a-z0-9][a-z0-9_-]{0,63}$` (normalized to lowercase).

Export types: `AgentDefinition`, `Binding`.

### 1.2 Binding match design

Bindings use a **generic `match` object** instead of fixed fields. Each key in `match` must exist in the message's routing metadata and have the same value. This makes the system channel-agnostic and extensible.

**Config examples:**

```json
{
  "bindings": [
    { "agentId": "work",    "match": { "channel": "telegram", "chatId": "-100987654" } },
    { "agentId": "diet",    "match": { "channel": "telegram", "chatId": "123456", "topicId": 42 } },
    { "agentId": "support", "match": { "channel": "discord", "guildId": "789012" } },
    { "agentId": "ops",     "match": { "channel": "slack", "teamId": "T0001" } },
    { "agentId": "main",    "match": { "channel": "telegram" } },
    { "agentId": "main",    "match": {} }
  ]
}
```

**Matching rules:**
- Iterate bindings top-to-bottom, **first match wins**
- A binding matches if **every key in `match`** exists in the message's routing bag with the same value
- Empty `match: {}` matches everything (catch-all)
- User controls priority via array ordering

**Message routing bag** — built from InboundMessage fields + channel-specific metadata:
- Common keys: `channel`, `chatId`, `userId`
- Telegram: `topicId`
- Discord (future): `guildId`, `channelType`
- Slack (future): `teamId`, `threadTs`
- WhatsApp (future): `accountId`

If no binding matches → `defaultAgentId` fallback.
If `agents[]` is empty → synthesize implicit `"main"` agent with all global defaults. **Zero behavioral change for existing setups.**

### 1.3 InboundMessage changes — `src/bus/types.ts`

```typescript
export interface InboundMessage {
  // ... existing fields (channel, chatId, userId, topicId, etc.) ...

  /** Resolved agent ID (set during processing, not by channels). */
  agentId?: string;

  /** Channel-specific routing metadata for binding resolution.
   *  Telegram: { topicId }. Discord: { guildId }. Slack: { teamId }. */
  routingMeta?: Record<string, string | number>;
}
```

Each channel populates `routingMeta` with its specific fields. The `AgentResolver` builds the full routing bag by merging common fields (`channel`, `chatId`, `userId`) with `routingMeta`.

### 1.4 New file: `src/agent/agent-resolver.ts`

```typescript
export interface AgentContext {
  id: string;
  name: string;
  definition: AgentDefinition;
  egoPath: string | null | undefined;
  agentsFilePath: string | null | undefined;
  heartbeatFilePath: string | null | undefined;
  skillDirs: string[];
  toolAllow?: string[];
  toolDeny?: string[];
  slotOverrides?: Record<string, Record<string, string>>;  // per-agent model override
  params?: { temperature?: number; maxTokens?: number };
  memoryShared: boolean;
}

export class AgentResolver {
  constructor(config: JanusConfig) { ... }

  /** Build routing bag from message and resolve to agent context. */
  resolve(msg: InboundMessage): AgentContext

  get(agentId: string): AgentContext | undefined
  list(): AgentContext[]
}
```

**`resolve()` implementation:**
1. Build routing bag: `{ channel: msg.channel, chatId: msg.chatId, userId: msg.user?.userId, ...msg.routingMeta }`
2. Iterate `bindings[]` — for each, check if every key in `binding.match` matches the routing bag
3. Return matched agent context, or default fallback

### 1.5 Agent loop changes — `src/agent/agent-loop.ts`

**Note:** The agent loop now includes cross-tool loop detection (6-call pattern window, `seenToolCalls`), MAX_ITERATIONS=200 hard safety limit, and proactive context overflow detection (90%/95% token budget with `pruneOldToolResults`). Agent resolution must be inserted **before** the main iteration loop, without disrupting these safety mechanisms.

**Add to AgentDeps:**
```typescript
agentResolver?: AgentResolver;
```

**In `processMessage()` — before the main loop, near session key construction:**

```typescript
// NEW: Resolve agent
const agentCtx = this.deps.agentResolver?.resolve(msg);
const agentId = agentCtx?.id ?? 'main';

// CHANGED: Session key includes agentId
const sessionKey = `${agentId}:${msg.channel}:${msg.chatId}`;
```

**In `processMessage()` — tool filtering (line 284-293):**

Current `reqCtx` has `userToolAllow`/`userToolDeny`. Merge agent-level filters before passing:
```typescript
// Merge: agent deny ∪ user deny, agent allow ∩ user allow
const effectiveAllow = intersect(agentCtx?.toolAllow, userProfile?.tools?.allow);  // both must allow
const effectiveDeny = union(agentCtx?.toolDeny, userProfile?.tools?.deny);          // either can deny

const reqCtx: RequestContext = {
  ...existingFields,
  userToolAllow: effectiveAllow,
  userToolDeny: effectiveDeny,
};
```

No changes to `RequestContext` type — agent filters are pre-merged into existing `userToolAllow`/`userToolDeny` fields.

**In `processMessage()` — context build call:**
```typescript
const systemPrompt = await this.deps.context.build({
  ...existingOpts,
  agentCtx,  // NEW
});
```

**In `processMessage()` — per-agent params override:**
If `agentCtx.params` is set, apply `temperature`/`maxTokens` to the `chatRequest` before calling `llm.chat()`/`llm.chatStream()`.

**In `processMessage()` LLM call — per-agent model override:**
If `agentCtx.slotOverrides` is set, temporarily override the active slot in ProviderRegistry for this request. Implementation: pass slot name through to `llm.chat()`/`llm.chatStream()` call, or resolve model ID before calling.

**In `processSystemMessage()`:** Same agent resolution for system messages (cron/heartbeat).

**Session key migration:** In `SessionManager.getOrCreate()`, if key `${agentId}:${channel}:${chatId}` not found, try legacy key `${channel}:${chatId}`. If found, rename file. Self-healing, no migration script needed.

### 1.6 Telegram channel changes — `src/channels/telegram-channel.ts`

Populate `routingMeta` when building InboundMessage at all 3 construction points:

- **Text messages (line 318):** has `topicId` → `routingMeta: topicId ? { topicId } : undefined`
- **Voice messages (line 508):** has `topicId` → same pattern
- **Reactions (line 391):** no `topicId` currently — check if grammy exposes `message_thread_id` on reaction events; if not, omit `routingMeta` (reactions in forum topics won't route by topic)

```typescript
const inbound: InboundMessage = {
  // ... existing fields ...
  routingMeta: topicId ? { topicId } : undefined,
};
```

Future channels (Discord, Slack) will populate their own keys (`guildId`, `teamId`, etc.).

### 1.7 Context builder changes — `src/context/context-builder.ts`

**Add to `build()` opts:**
```typescript
agentCtx?: AgentContext;
```

**Changes in `build()`:**
- `buildIdentity()`: Use `agentCtx.name` instead of hardcoded "Janus". Include `agentCtx.definition.description` if set.
- `loadEgo()`: Accept optional path override from `agentCtx.egoPath`. `null` = skip EGO entirely. `undefined` = use global.
- `loadAgents()`: Accept optional path override from `agentCtx.agentsFilePath`. Same null/undefined logic.
- `loadHeartbeat()`: Accept optional path override from `agentCtx.heartbeatFilePath`.
- Tool filtering: Apply `agentCtx.toolAllow/toolDeny` before user filtering.
- Session info: Add `Agent: {agentCtx.id}` line.

### 1.8 Bootstrap wiring — `src/bootstrap.ts`

```typescript
import { AgentResolver } from './agent/agent-resolver.js';

// After config loaded, before agent loop:
const agentResolver = new AgentResolver(config);

// Add to agentDeps:
const agentDeps = { bus, llm, tools, sessions, context, skills, config, learner, memory, agentResolver };
```

Add `agentResolver: AgentResolver` to `AppDeps`.

### 1.9 Example config — `janus.example.json`

Add `agents`, `bindings`, `defaultAgentId` sections with examples.

---

## Phase 2: Per-Agent Memory, Cron, DMScope & Identity Links

### 2.1 Per-agent memory directory

When `agent.memory.shared: false`:
- Memory reads/writes go to `.janus/agents/{agentId}/memory/` instead of global
- MemoryIndex: use existing `owner` column with `agent:{agentId}` as owner
- `MemoryStore` gets optional `agentId` parameter in read/write/search methods
- Context builder passes `agentId` to `buildMemorySection()` when memory is not shared

### 2.2 DB migration 10

Migration 9 is already taken (`finished_at` for cron run history). This is migration 10.

```sql
ALTER TABLE cron_jobs ADD COLUMN agent_id TEXT;
```

### 2.3 Cron/heartbeat integration

- `CronJobInput` + `CronJob`: add optional `agentId` field
- `CronService.executeJob()`: include `agentId` in published InboundMessage
- `HeartbeatService`: agent-specific HEARTBEAT.md files parsed and synced with their `agentId`
- Agent loop `processSystemMessage()`: use message's `agentId` for context resolution

### 2.4 Heartbeat enhancements

Add to `AgentDefinitionSchema.heartbeat` (or global defaults):

```typescript
heartbeat: z.object({
  isolatedSession: z.boolean().default(false),  // true = fresh context per run (no cross-run contamination)
  activeHours: z.object({
    start: z.string(),   // "09:00"
    end: z.string(),     // "18:00"
    tz: z.string().optional(),  // IANA timezone, defaults to system
  }).optional(),
}).optional(),
```

- `isolatedSession: true` — CronService creates disposable session key per run (`cron:{jobId}:{timestamp}`)
- `activeHours` — CronService skips execution outside window (checked in `onTimer()`)

### 2.5 Subagent controls

Add to `AgentDefinitionSchema`:

```typescript
subagents: z.object({
  allowAgents: z.array(z.string()).default(['*']),  // which agents this agent can spawn into
}).optional(),
```

Enforced in `spawn_agent` tool — check caller's `agentCtx.subagents.allowAgents` before spawning.

### 2.6 `ensureAgentDir()` in `src/users/user-resolver.ts`

Auto-create `.janus/agents/{agentId}/` and `.janus/agents/{agentId}/memory/` on first use.

### 2.7 DMScope — configurable DM session isolation

Add to config schema:

```typescript
const SessionSchema = z.object({
  dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).default('per-channel-peer'),
  identityLinks: z.record(z.string(), z.array(z.string())).default({}),
});
```

**DMScope levels:**

| Scope | Session key format | Use case |
|-------|-------------------|----------|
| `main` | `{agentId}:main` | All DMs share one session (global continuity) |
| `per-peer` | `{agentId}:direct:{canonicalUserId}` | One session per user, cross-platform |
| `per-channel-peer` (default) | `{agentId}:{channel}:{chatId}` | One session per user per channel (current behavior) |

Applied only to DMs (1:1 chats). Group chats always use `{agentId}:{channel}:{chatId}`.

### 2.8 Identity links — cross-platform user mapping

```json
{
  "session": {
    "identityLinks": {
      "wojtek": ["telegram:123456", "discord:789012", "slack:U001"],
      "anna": ["telegram:654321", "discord:210987"]
    }
  }
}
```

When `dmScope: "per-peer"`, identity links resolve multiple channel identities to a single canonical user ID. User "wojtek" on Telegram and Discord gets the **same session history**.

**Implementation:**
- Build a `Map<channelIdentity, canonicalId>` at startup from `identityLinks`
- In `AgentResolver.resolve()`, look up `{channel}:{userId}` → canonical ID
- Use canonical ID in session key when `dmScope: "per-peer"`
- Leverage existing `users[].identities[]` config — identity links can be auto-derived from user profiles as a convenience

---

## Files to modify

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add AgentDefinitionSchema, BindingSchema, SessionSchema, new fields |
| `src/bus/types.ts` | Add `agentId?` and `routingMeta?` to InboundMessage |
| `src/agent/agent-loop.ts` | Agent resolution, session key prefix, tool merge, pass agentCtx, model override (preserve loop detection + context overflow logic) |
| `src/context/context-builder.ts` | Accept agentCtx, override identity/ego/agents/heartbeat/session |
| `src/bootstrap.ts` | Wire AgentResolver, add to AppDeps |
| `src/session/session-manager.ts` | Legacy key fallback in getOrCreate() |
| `src/channels/telegram-channel.ts` | Populate routingMeta with topicId |
| `janus.example.json` | Add agents/bindings example |

## New files

| File | Purpose |
|------|---------|
| `src/agent/agent-resolver.ts` | AgentResolver class + AgentContext interface |
| `tests/unit/agent-resolver.test.ts` | Routing tests |

## Tests

### Phase 1 tests (`tests/unit/agent-resolver.test.ts`)

1. No agents configured → implicit main, all defaults preserved
2. Single agent → always resolves
3. Multiple agents + bindings → correct routing by channel+chatId
4. Binding priority → first match wins (array order)
5. Generic match keys → topicId, guildId, teamId all work
6. Empty match `{}` → catches everything (catch-all)
7. Partial match → binding with `{ channel: "telegram" }` matches any Telegram message
8. Default fallback → unmatched → defaultAgentId
9. Session key format → agentId prefix
10. Context builder → agent name in identity, custom EGO path
11. Tool filtering → agent + user filters compose correctly (intersect allow, union deny)
12. Per-agent model override → slotOverrides applied
13. Per-agent params → temperature/maxTokens override
14. Legacy session migration → old key found and renamed
15. Agent ID validation → rejects invalid IDs, normalizes to lowercase

### Phase 2 tests

16. DMScope `main` → all DMs share one session
17. DMScope `per-peer` → one session per user, cross-platform
18. DMScope `per-channel-peer` → one session per user per channel (default, backward compat)
19. Identity links → Telegram + Discord user resolves to same canonical ID
20. Identity links + `per-peer` → cross-platform session sharing works
21. Heartbeat isolatedSession → fresh context per run
22. Heartbeat activeHours → skipped outside window
23. Subagent allowAgents → spawn blocked for disallowed agent

## Verification

1. `npm run typecheck` — no type errors
2. `npm test` — all existing 400+ tests pass (39 test files)
3. New `agent-resolver.test.ts` tests pass
4. Manual: configure 2 agents + bindings in `janus.json`, send messages from different Telegram chats, verify separate sessions and contexts
