# Context Management Redesign — Design Spec

**Status:** Final
**Date:** 2026-05-16
**Owner:** Wojciech Tokarzewski
**Replaces:** the 7-mechanism / 12-threshold context management system that has accumulated 20+ patch PRs since 2026-04-01.

## Goal

Replace the current context-management subsystem (`enforceContextBudget` Phase 1/2/3 + emergency compression + 5 flush triggers + summarization race + 100x disk/in-loop tool result mismatch + per-message context duplication) with a single coherent design driven by **pre-call routing**, **transcript rotation**, and **composable transform passes**.

End the 45-day patch chain. After this ships, the only PRs touching this subsystem should be feature additions, not bug fixes for cascade failures.

## The current mess (why this needs to ship)

Since 2026-04-01, 20 PRs have tried to fix bugs in this subsystem:

```
#163 (04-01)  Replace 50-message limit with token-based context management
#169 (04-13)  cross-session memory, flush pointer
#171 (04-17)  surrogate sanitization, stale processing TTL, loop detection
#181 (04-21)  token waste overhaul — cache fix, flush consolidation
#184 (04-21)  improve Anthropic prompt cache hit rate
#185 (04-22)  Anthropic prompt cache prefix optimization
#187 (04-24)  restore summarization quality with fallback chain
#188 (04-24)  scale summarization maxTokens to input size
#192 (04-26)  include tool results in summarization
#198-201 (04-26)  4 PRs fixing summarization quality in one day
#203-207 (04-27)  5 PRs fixing summarization protocol + loop detection
#208-211 (05-16)  pinned skill state + universal activation + cascade fix
```

The pattern is patch-pyramid. Each PR fixed one edge case and exposed the next. None questioned the architecture.

### The 7 mechanisms with overlapping responsibilities

| # | Mechanism | File:Line | Trigger | Side effect |
|---|---|---|---|---|
| 1 | Tool result truncation (persist) | `session-manager.ts:200-211` | every append | cap 400,000 chars on disk |
| 2 | Tool result truncation (in-loop) | `agent-loop.ts:1538` | every tool result | cap 4,000 chars in memory |
| 3 | Context-budget Phase 1 | `context-budget.ts:115-131` | >75% tokenBudget | soft-trim tool results to 4k head+tail |
| 4 | Context-budget Phase 2 | `context-budget.ts:137-151` | >80% tokenBudget | hard-clear tool results to placeholder |
| 5 | Context-budget Phase 3 | `context-budget.ts:157-185` | >85% tokenBudget | drop oldest assistant+tool turns (breaks cache) |
| 6 | Emergency compression | `agent-loop.ts:810-814` | >95% tokenBudget | Phase 1/2/3 with protected-tail disabled |
| 7 | Memory flush | `agent-loop.ts:1117-1224` | >40% tokenBudget + 4 other triggers | fire-and-forget LLM call writing MEMORY.md |
| 8 | Summarization | `agent-loop.ts:1271-1428` | >40 msgs OR >75% tokenBudget | LLM call summarizing old messages, JSONL rewrite |

### The 7 architectural failures

1. **100x disk-vs-memory tool result mismatch.** In-loop caps results at 4k chars but persists 400k chars on disk. After restart, sessions load 100x larger than they were "live" — first message after restart hits Phase 1/2/3 immediately.

2. **Historical user messages carry their full `<context>` block.** `dynamicPart` (containing `<pinned_skill_state>` + session info + profile + known chats) is prepended to every user message before save (`agent-loop.ts:410`). After 40 turns, the session holds 40 copies of the pinned state in user message history.

3. **Phase 3 drops oldest assistant turns mid-array.** `messages.splice(idx, count)` mutates the conversation prefix. Anthropic prompt cache is prefix-matched — any mid-array splice invalidates the cache. Result: `cache_write:146k hit:5%` instead of `hit:88%`.

4. **137:1 compression ratio demanded in one LLM call.** Summarization fires at 562,500 tokens of input but `maxTokens` caps output at 4,096. Asking the model to compress 137:1 in one shot — frequent timeouts at 90s, then no compaction, then session keeps growing.

5. **Pre-compaction flush inside summarization is blocking, up to 360s.** `doSummarization()` calls `flushMemory()` synchronously with 3 retries × 90s + 90s for summary itself. During those 360s, the `summarizing` guard is held and user keeps sending messages.

6. **Token-aware flush ↔ pre-compaction flush race.** Both check `state.flushing`. If the fire-and-forget flush is already running when summarization starts, the mandatory pre-flush silently skips and summarization discards messages that were never written to MEMORY.md. **Permanent data loss.**

7. **`enforceContextBudget` skips user messages entirely.** Phase 1/2 only touches `tool` role; Phase 3 only drops `assistant`+`tool`. The last user message — which contains the full `<context>` block with pinned state — is never trimmed. Pinned section can grow without bound.

The combination produces a cascade that on 2026-05-14 we observed live: context filled to 92%, Phase 3 invalidated cache, summary timed out, loop detection bailed, user got slow/wrong responses. This is happening daily.

## Design principles

Adopted from reference implementations of similar agent systems:

### Principle 1: One budget number

Every context-related decision compares against ONE value: `effectiveBudget = modelContextWindow - reservedForOutput`. No `tokenBudget` field, no `contextWindow` field, no 12 separate thresholds.

### Principle 2: Pre-call routing, not post-fail retry

Before each LLM call: estimate prompt size, decide ONE route, apply transforms in that order. Four routes only:

- **`fits`** — proceed unchanged
- **`truncate_only`** — soft-trim old tool results enough to fit, no compaction needed
- **`compact_only`** — truncate alone won't fit, compact first (no recovery possible by trimming)
- **`compact_then_truncate`** — both passes needed in order

There is no Phase 1 → Phase 2 → Phase 3 → Emergency cascade. There is no retry-after-fail. The router picks the route once based on overflow size + truncatable headroom, executes it, calls LLM.

### Principle 3: Composable transform passes

Each pass is `(messages: LLMMessage[], settings) → LLMMessage[]`. Stateless. No coupling between passes. The router chains them. Today we need 2 passes:

- `softTrimOldToolResults` — head+tail trim for tool results outside the protected tail
- `hardClearOldToolResults` — replace with placeholder for tool results outside protected tail when above hardClearRatio

Add more passes later (image pruning, response chunking, etc.) by writing one function. No mutation of the global mechanism.

### Principle 4: Bounded persistent session via transcript rotation

After every successful compaction, the JSONL file is **rotated**: old file archived as `{key}.{timestamp}.jsonl`, new file starts with a `_type: "compaction"` entry containing the summary, followed by the tail messages we're keeping. The session-on-disk has a known upper size: ~`keepRecentTokens` + summary. Restart loads ~30k tokens, not 200k.

## The new architecture

### File structure

```
src/context/
  context-manager.ts        # new — router + transforms
  context-manager.test.ts   # new — unit tests for each pass + router routes
  pinned-state.ts           # existing — kept (Decision: pinned section goes to system prompt dynamic suffix)
  context-builder.ts        # existing — modified to use cache boundary marker

src/session/
  session-manager.ts        # existing — modified: append() strips <context>, summarize() rotates transcript

src/agent/
  agent-loop.ts             # existing — modified: replace enforceContextBudget call with router; remove emergency; simplify flush trigger logic
  context-budget.ts         # DELETED

src/prompts/
  cache-boundary.ts         # new — CACHE_BOUNDARY marker constant + split/strip helpers
```

### Section A — One budget value

```ts
// src/context/context-manager.ts

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4_000;
export const RESERVED_OUTPUT_TOKENS_DEFAULT = 8_000;
export const SAFETY_MARGIN = 1.2; // estimates are pessimistic

export interface ContextBudget {
  /** Model's actual context window (e.g. 200_000 for Anthropic Sonnet) */
  contextWindow: number;
  /** Tokens reserved for the model's response (default 8k) */
  reservedForOutput: number;
  /** Effective budget for prompt tokens = contextWindow - reservedForOutput */
  effective: number;
  /** Source of contextWindow value (for diagnostics) */
  source: 'model' | 'config' | 'default';
}

export function resolveBudget(params: {
  modelContextWindow?: number;
  configOverride?: number;
}): ContextBudget {
  const contextWindow = params.configOverride ?? params.modelContextWindow ?? 200_000;
  const reservedForOutput = RESERVED_OUTPUT_TOKENS_DEFAULT;
  const effective = Math.max(CONTEXT_WINDOW_HARD_MIN_TOKENS, contextWindow - reservedForOutput);
  return {
    contextWindow,
    reservedForOutput,
    effective,
    source: params.configOverride ? 'config' : params.modelContextWindow ? 'model' : 'default',
  };
}
```

All thresholds in the router and transforms are ratios of `effective`, e.g. `0.3 * effective` for soft-trim trigger. No magic 750k, no separate tokenBudget.

### Section B — Pre-call router

```ts
// src/context/context-manager.ts (continued)

export type CallRoute =
  | { type: 'fits' }
  | { type: 'truncate_only' }
  | { type: 'compact_only' }
  | { type: 'compact_then_truncate' };

export interface RouterResult {
  route: CallRoute;
  estimatedTokens: number;
  budget: number;
  reducibleTokens: number;
}

export function routeCall(params: {
  messages: LLMMessage[];
  systemPrompt: string;
  budget: ContextBudget;
}): RouterResult {
  const estimated = Math.ceil(estimatePromptTokens(params.messages, params.systemPrompt) * SAFETY_MARGIN);
  const budget = params.budget.effective;
  const overflow = Math.max(0, estimated - budget);

  if (overflow === 0) {
    return { route: { type: 'fits' }, estimatedTokens: estimated, budget, reducibleTokens: 0 };
  }

  const reducible = estimateReducibleToolTokens(params.messages, params.budget);
  const truncateBuffer = 512; // tokens of slack to avoid borderline misses
  const wouldFitByTruncate = reducible >= (overflow + truncateBuffer);

  if (wouldFitByTruncate) {
    return { route: { type: 'truncate_only' }, estimatedTokens: estimated, budget, reducibleTokens: reducible };
  }
  if (reducible > 0) {
    return { route: { type: 'compact_then_truncate' }, estimatedTokens: estimated, budget, reducibleTokens: reducible };
  }
  return { route: { type: 'compact_only' }, estimatedTokens: estimated, budget, reducibleTokens: 0 };
}
```

### Section C — Composable transforms

```ts
// src/context/context-manager.ts (continued)

export interface TransformSettings {
  keepLastAssistants: number;       // default 3 — protect recent turns
  softTrimRatio: number;            // default 0.3 — apply soft trim when ratio > this
  hardClearRatio: number;           // default 0.5 — apply hard clear when ratio > this
  minPrunableToolChars: number;     // default 50_000 — hard clear only if we have this much to clear
  softTrim: { maxChars: number; headChars: number; tailChars: number }; // default 4000 / 1500 / 1500
  hardClear: { placeholder: string }; // default '[old tool result cleared]'
}

export function softTrimOldToolResults(
  messages: LLMMessage[],
  settings: TransformSettings,
): LLMMessage[] {
  // 1. Find cutoff: last N assistant messages are "protected tail"
  // 2. For each tool message before cutoff: if content > maxChars, replace with head + separator + tail
  // 3. Return new array (no mutation of input)
}

export function hardClearOldToolResults(
  messages: LLMMessage[],
  settings: TransformSettings,
): LLMMessage[] {
  // Same cutoff logic; for tool messages before cutoff, replace content with settings.hardClear.placeholder
}

export function applyRoute(
  messages: LLMMessage[],
  route: CallRoute,
  settings: TransformSettings,
  triggerCompaction: () => Promise<void>,
): Promise<LLMMessage[]> {
  switch (route.type) {
    case 'fits': return messages;
    case 'truncate_only': return softTrimOldToolResults(messages, settings);
    case 'compact_only': {
      await triggerCompaction();
      return messages; // compaction rewrites session; caller reloads
    }
    case 'compact_then_truncate': {
      await triggerCompaction();
      return softTrimOldToolResults(messages, settings);
    }
  }
}
```

### Section D — Cache boundary marker

```ts
// src/prompts/cache-boundary.ts

export const CACHE_BOUNDARY = '\n<!-- JANUS_CACHE_BOUNDARY -->\n';

export function splitAtBoundary(systemPrompt: string): { stablePrefix: string; dynamicSuffix: string } | null {
  const idx = systemPrompt.indexOf(CACHE_BOUNDARY);
  if (idx === -1) return null;
  return {
    stablePrefix: systemPrompt.slice(0, idx).trimEnd(),
    dynamicSuffix: systemPrompt.slice(idx + CACHE_BOUNDARY.length).trimStart(),
  };
}

export function stripBoundary(text: string): string {
  return text.replaceAll(CACHE_BOUNDARY, '\n');
}
```

`context-builder.ts` produces a single `systemPrompt` string with the marker between cacheable static content and dynamic content. The Anthropic provider splits at the boundary and applies `cache_control` to the static prefix only. Other providers strip the boundary and treat it as a single string.

### Section E — Transcript rotation

```ts
// src/session/session-manager.ts (modified)

async summarize(key: string, summaryText: string, keepRecentTokens: number): Promise<void> {
  return this.withLock(key, async () => {
    const session = await this.getOrCreate(key);
    // Walk backwards: find cutIndex such that tail ≤ keepRecentTokens
    const cutIndex = this.findTailCutIndex(session.messages, keepRecentTokens);
    if (cutIndex < 4) return; // too few to compact

    // Rotate: archive current JSONL, write new one
    const path = this.sessionPath(key);
    const archivePath = `${path}.${Date.now()}.jsonl`;
    await rename(path, archivePath);

    const newSession: Session = {
      key,
      messages: session.messages.slice(cutIndex),
      metadata: {
        ...session.metadata,
        summary: summaryText,
        lastFlushed: session.messages.length - cutIndex, // align with new array length
        created: session.metadata.created,
        updated: new Date().toISOString(),
        messageCount: session.messages.length - cutIndex,
      },
    };

    // Write new JSONL: metadata + compaction entry + tail messages
    const lines: string[] = [];
    lines.push(JSON.stringify({ _type: 'metadata', ...newSession.metadata }));
    lines.push(JSON.stringify({ _type: 'compaction', summary: summaryText, archivedAt: new Date().toISOString(), archivePath }));
    for (const m of newSession.messages) lines.push(JSON.stringify(m));

    await writeFile(path, lines.join('\n') + '\n');
    this.cache.set(key, newSession);
    log.info(`[session ${key}] rotated: ${session.messages.length} → ${newSession.messages.length} messages; archive: ${archivePath}`);
  });
}
```

After rotation, restart loads `keepRecentTokens` + summary, never the full history. Archives kept on disk for forensics but never re-read by Janus.

### Section F — Unified tool result cap

```ts
// src/session/session-manager.ts

const TOOL_RESULT_CAP_RATIO = 0.5; // 50% of effective budget chars
const CHARS_PER_TOKEN_ESTIMATE = 2.5; // conservative for English+code

function toolResultCap(effectiveBudgetTokens: number): number {
  return Math.floor(effectiveBudgetTokens * CHARS_PER_TOKEN_ESTIMATE * TOOL_RESULT_CAP_RATIO);
}

// Used in BOTH:
// - session-manager.ts append() — disk write
// - agent-loop.ts tool result handling — before adding to messages array
```

For default contextWindow=200_000, reserved=8_000: cap = `(200_000 - 8_000) * 2.5 * 0.5 = 240_000 chars`. Same value used everywhere. Restart loads the same byte content the live session had.

### Section G — Decouple flush from compaction

```ts
// src/agent/agent-loop.ts (modified)

// Memory flush is independent: fires on its own schedule
// - Trigger 1: unflushed messages count > 20 (was: 5 triggers including pre-compaction)
// - Trigger 2: shutdown (graceful flush)
// - That's it. No idle-timer trigger, no token-based trigger, no pre-compaction trigger.

// Compaction does NOT call flushMemory:
async doCompaction(...) {
  // Just summarize and rotate. flush has its own lifecycle.
}
```

If flush and compaction overlap, that's fine — they operate on different state (flush writes MEMORY.md, compaction rotates JSONL). No more silent-skip race.

### Section H — Pinned state into dynamic suffix

`context-builder.ts` previously prepended `dynamicPart` (containing pinned) to user messages. Change:

- `dynamicPart` is appended to system prompt AFTER the `CACHE_BOUNDARY` marker
- User messages stored in JSONL contain ONLY the user's actual content
- On every LLM call, the current `dynamicPart` is appended fresh to the system prompt (still after boundary, so cache doesn't break for static prefix)
- After 40 turns: history has 40 plain user messages + 1 current pinned state in system prompt. No accumulation.

```ts
// agent-loop.ts processMessage
const systemPrompt = `${staticPart}${CACHE_BOUNDARY}${dynamicPart}`;
// user message is plain content
const userMsg = { role: 'user', content: opts.userMessage };
session.append(userMsg); // plain — no context block baked in
```

### Section I — Summarization with 15-minute timeout + abort path

```ts
// src/agent/agent-loop.ts

const COMPACTION_TIMEOUT_MS = 15 * 60 * 1000; // was 90s — 10x more

async doCompaction(sessionKey: string, pinnedPaths: Set<string>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPACTION_TIMEOUT_MS);
  try {
    // ... existing logic, but use controller.signal in LLM call
    // ... after LLM returns, call sessions.summarize() which rotates
  } catch (err) {
    if (controller.signal.aborted) {
      log.warn(`[${sessionKey}] Compaction aborted after ${COMPACTION_TIMEOUT_MS}ms`);
      // Fallback: brute-force truncate by dropping oldest 50% of messages WITHOUT a summary
      await this.deps.sessions.forceDropOldest(sessionKey, 0.5);
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}
```

When compaction can't be summarized in 15 minutes, we drop oldest 50% of messages on disk and accept the data loss (logged loudly). Better than infinite cascade.

## Configuration changes

### Removed from `src/config/schema.ts`

```yaml
agent:
  tokenBudget: 750_000              # REMOVED
  summarizationThreshold: 40        # REMOVED (router decides)
  context:
    compactionThresholds: [0.75, 0.80, 0.85]  # REMOVED (single router)
    emergencyThreshold: 0.95        # REMOVED (no more emergency)
    protectedTailTurns: 3           # REMOVED (replaced by keepLastAssistants in transform settings)
    toolResultMaxShare: 0.3         # REMOVED (unified cap)
    toolResultHardMax: 400_000      # REMOVED (unified cap)
    softTrimChars: 4_000            # REMOVED (in transform settings)
    reserveTokens: 20_000           # REMOVED (replaced by RESERVED_OUTPUT_TOKENS_DEFAULT constant)
```

### Added to `src/config/schema.ts`

```yaml
agent:
  context:
    # Override model-reported context window. Optional. Default: use model value.
    contextWindow: 200_000
    # Tokens reserved for response. Default 8_000.
    reservedForOutput: 8_000
    # When to start trimming (as ratio of effective budget). Default 0.3.
    softTrimRatio: 0.3
    # When to hard-clear (as ratio of effective budget). Default 0.5.
    hardClearRatio: 0.5
    # Protect last N assistant turns from any trim. Default 3.
    keepLastAssistants: 3
    # After compaction, keep tail of this many tokens. Default 20_000.
    keepRecentTokens: 20_000
    # Compaction LLM timeout. Default 900_000ms (15 min).
    compactionTimeoutMs: 900_000
```

7 fields removed, 7 added. Net: same count, but every new field has a SINGLE clear purpose.

## What stays

- Pinned skill state (`src/context/pinned-state.ts`) — still loads fresh every call, but injected into system prompt dynamic suffix, not user message
- Memory flush (`flushMemory()`) — keeps writing MEMORY.md/HISTORY.md/daily notes — but on its own schedule, not coupled to compaction
- Anthropic prompt cache — still used, marker-based split now explicit
- Summarization prompts (`src/prompts/summarization/initial.md`, `update.md`) — unchanged
- Loop detection (PR #206) — unchanged
- Pinned read short-circuit (PR #211) — unchanged

## Migration

### JSONL format compatibility

Old JSONL sessions (pre-rotation) load fine. The new code does not produce them, but reading them is supported. On first compaction post-deploy, the session rotates and the old format is left in the `.{timestamp}.jsonl` archive.

### Tool result re-truncation on next save

Old sessions have tool results up to 400k chars each. The new cap is ~240k chars. On the first append after restart, NEW tool results are capped at 240k. OLD tool results in history are NOT rewritten — they stay at whatever size they were when persisted, until the next compaction rotates the session.

After one full rotation cycle, all in-session tool results respect the new cap. Archives keep the originals.

### Dynamic-part stripping

User messages in OLD JSONL files contain `<context>` blocks baked in. The new code:
- When SAVING new user messages: only saves the plain content (no `<context>` prefix)
- When LOADING old messages: leaves the `<context>` blocks in (we don't rewrite history)
- After compaction rotation: only the tail messages from the old format remain, and those are the most recent ones — likely still have `<context>` baked in
- After the SECOND compaction post-deploy: all messages in the new file are produced by new code → no `<context>` blocks

So there's a 2-compaction migration window where some history is bloated. Acceptable.

## Testing strategy

### Unit tests (`tests/unit/context-manager.test.ts`)

- `resolveBudget` — config override, model value, default fallback
- `routeCall` — 4 routes covered with concrete inputs
- `softTrimOldToolResults` — respects keepLastAssistants, doesn't touch user messages, applies head+tail correctly
- `hardClearOldToolResults` — respects minPrunableToolChars threshold
- `splitAtBoundary` / `stripBoundary` — boundary marker handling

### Unit tests (`tests/unit/session-rotation.test.ts`)

- `summarize()` rotates: archive file exists, new file has compaction entry + tail
- Restart-load reads new format correctly
- Old format still loads
- Pre-pinned and post-pinned messages coexist

### Integration test (`tests/integration/long-conversation.test.ts`)

- Simulate 1000 user messages with 50% containing tool calls
- After 1000 turns, session JSONL size < 100k chars
- No more than 5 compactions happened
- No Phase-style cascade logging
- Mock LLM with deterministic responses

### Manual smoke test

After deploy to a feature branch, in the diet chat:
- Log 20 meals across a day
- Send "co dzisiaj jadłem?"
- Send "mój plan jest do dupy" (the pre-fix loop trigger)
- Verify: no `Phase 1/2/3`, no `Emergency`, no `Summarization failed`, single-iteration responses

## What's NOT in scope (future work)

- Image pruning pass (referenced pattern has it; we don't have images-in-context flow yet)
- Cache-TTL based pruning pass (separate from per-call routing; an optimization)
- Per-tool prunability config (some tool results valuable to keep verbatim; defer to v2)
- Model fallback for compaction (use Haiku if Sonnet is too slow; defer)

## Open questions resolved

- **Q1: Pinned section move?** Yes — into system prompt dynamic suffix. Strip from user messages on save.
- **Q2: Tool result cap unified?** Yes — single cap derived from contextWindow.
- **Q3: One PR or three?** One PR. User tests on feature branch before merge.

## Success criteria

After this ships and runs for 7 days in production:

1. Zero `Phase 1/2/3` log lines
2. Zero `Summarization failed: timed out` log lines
3. Zero `Emergency compression` log lines
4. Zero `No-progress exit: 3 iterations of all-duplicate tool calls` log lines for non-buggy skills
5. Session JSONL file size for active chats stays below 200 KB (was: 5+ MB)
6. Anthropic cache hit rate stays above 80% (was: degrading to 5% after Phase 3 fires)
7. No new PRs in this subsystem for 30 days post-merge
