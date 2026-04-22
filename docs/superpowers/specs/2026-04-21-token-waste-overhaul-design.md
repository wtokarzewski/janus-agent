# Token Waste Overhaul — Design Spec

**Date:** 2026-04-21
**Status:** Draft
**Depends on:** Hybrid token optimization (merged), context management overhaul (merged)

## Problem

Janus consumes nearly as many tokens idle (cron/heartbeat/flush/summarize) as the user does in 8 hours of active coding. The subscription is running out despite light usage.

Root causes identified through code analysis:

1. **Prompt cache never hits** — `localTimestamp()` in `<identity>` changes every second, memory search results change per message, learner/summary are dynamic. The entire ~50K token system prompt gets `cache_write` (1.25x cost) instead of `cache_read` (0.1x cost) on every single API call. That's a **12x overpay** on the largest chunk of every request.

2. **Triple memory flush** — Three independent triggers (idle 120s, count-based every 5 msgs, token-aware at 50%) all fire LLM calls. In a normal conversation they cascade: count trigger fires, then token trigger fires, then after pause the idle trigger fires. Each is a separate LLM call to the `summarize` slot.

3. **Summarization quality retry** — Heuristic `/cron|schedule|remind|alarm|\d{1,2}:\d{2}/` triggers a second full summarization LLM call if "Critical Context" section is empty. The regex is too broad (matches any time-like pattern) and the retry is wasteful.

4. **Cron/heartbeat full context rebuild** — Every cron job execution builds the full system prompt including memory search, learner recommendations, and skills — most of which are irrelevant for a cron task like "remind user X about Y".

5. **No token visibility** — Cache read/write tokens are extracted from Anthropic responses but only logged at debug level. Memory flush and summarization LLM calls have zero token tracking. No way to diagnose where tokens go without reading code.

## Solution: Five Surgical Fixes

### Fix 1 — Split System Prompt: Static (Cached) + Dynamic (Uncached)

**Current state:** `context-builder.ts:build()` returns a single string. `anthropic-provider.ts` wraps it in one system block with `cache_control: ephemeral`. Any change in content → full cache miss → cache write surcharge.

**Change:** `build()` returns `{ staticPart: string; dynamicPart: string }` instead of a single string.

**Static part** (stable across requests within same session, cacheable):
- Identity — agent name, workspace, tool list (but **without** `localTimestamp()`)
- Known users directory
- Chat files directory
- EGO.md
- AGENTS.md
- HEARTBEAT.md
- JANUS.md
- Skills section

**Dynamic part** (changes per request, NOT cached):
- Session info — date, time, channel, sender, agent, scope (time moves here from identity)
- Memory search results
- Learner recommendations
- Previous summary
- User section (profile content may vary)

**Anthropic provider** sends 3 system blocks:
```
[
  { text: "You are Claude Code...",           cache_control: ephemeral },  // OAuth (if needed)
  { text: staticPart,                         cache_control: ephemeral },  // CACHED — stable prefix
  { text: dynamicPart }                                                    // NOT cached — changes per request
]
```

The static part is ~30-40K tokens (EGO, AGENTS, HEARTBEAT, JANUS, skills, tools). With ephemeral cache (5-min TTL), consecutive requests within 5 minutes hit cache → 0.1x cost instead of 1.25x.

**Time handling:** Remove `localTimestamp()` from `buildIdentity()`. Date and time both go into `<session>` block (already has `Date:`), which is in the dynamic part. The LLM still sees the time, just in a different section.

**Interface change:**
```typescript
// Before
async build(opts): Promise<string>

// After
interface ContextResult {
  staticPart: string;
  dynamicPart: string;
}
async build(opts): Promise<ContextResult>
```

All callers updated: `agent-loop.ts` passes both parts to LLM. For non-Anthropic providers (OpenAI-compatible, Codex, ClaudeAgent), the system message content is `staticPart + '\n\n---\n\n' + dynamicPart` concatenated into a single string — these providers don't support multi-block system messages, so the split is invisible to them but still benefits Anthropic cache. The concatenation happens in `agent-loop.ts` when building the messages array, gated by a provider type check or by having each provider's `chat()` method accept the `ContextResult` and handle it appropriately.

**Estimated savings:** ~55K tokens per request (cache read vs cache write on ~50K system prompt).

### Fix 2 — Consolidate Memory Flush: 3 Triggers → 1

**Current state** (`agent-loop.ts:445-478`):
- Idle timer (120s) — line 448
- Count-based (every 5 messages) — line 459
- Token-aware (50% budget) — line 474

All three fire independently, each triggering a separate LLM call to the `summarize` slot.

**Change:** Remove idle timer and count-based triggers. Keep only **token-aware flush** with adjusted threshold:
- Threshold: 50% → **40%** of token budget (flush earlier to stay within cache-friendly range)
- Plus: shutdown flush (already exists, no change)
- Plus: pre-summarization flush (already exists in `doSummarization`, no change)

**What gets deleted:**
- `idleTimer` field and `clearTimeout`/`setTimeout` logic (lines 445-454)
- Count-based flush block with content hash dedup (lines 456-468)
- `lastFlushHash` field from flush state

**What stays:**
- Token-aware flush (line 471-478) with threshold change from `0.5` to `0.4`
- `flushMemory()` method unchanged
- Shutdown flush (`flushAllSessions`) unchanged
- Pre-summarization flush in `doSummarization` unchanged

**Estimated savings:** 2-3 fewer LLM calls per conversation session.

### Fix 3 — Remove Summarization Quality Retry

**Current state** (`agent-loop.ts:1285-1303`): After summarization, checks if conversation contains scheduling keywords AND summary lacks "Critical Context" section. If so, makes a **second full LLM call** with stronger instruction.

**Problem:** The regex `/\b(cron|calendar|schedule|remind|alarm|heartbeat|\d{1,2}:\d{2})\b/i` matches too broadly. Any mention of time (e.g., "I worked from 9:00 to 17:00") triggers the retry. And the retry just re-runs the same prompt with an extra paragraph — the model rarely produces different output.

**Change:** Delete the entire quality retry block (lines 1285-1303). If the model doesn't extract scheduling info the first time, retrying won't reliably fix it.

**Estimated savings:** 1 LLM call eliminated per summarization on scheduling-adjacent conversations.

### Fix 4 — Cron/Heartbeat Minimal Context

**Current state** (`cron-service.ts:465-476`): `publishInbound()` does NOT set `contextMode`, so it defaults to `'full'`. The agent loop then builds a complete system prompt with memory search, learner, skills — all for a cron task that typically just needs to send a reminder.

**Change:** Set `contextMode: 'minimal'` on cron/heartbeat inbound messages.

In `cron-service.ts:executeJob()`:
```typescript
await this.bus.publishInbound({
  // ... existing fields
  contextMode: 'minimal',  // NEW — skip memory/learner/skills
});
```

The `minimal` mode already exists in `context-builder.ts:51` and skips: EGO, AGENTS, HEARTBEAT, JANUS (lines 90-112), memory (119-122), learner (124-128). It keeps: identity + tool list, user section, known users, skills, session info.

**Wait — skills stay in minimal mode** (line 114-116 is outside the `!minimal` guard). That's fine for cron — skills define available capabilities.

**But EGO/AGENTS skip is too aggressive** for cron jobs that need to maintain agent personality (e.g., heartbeat tasks that send messages to users in character). 

**Revised approach:** Instead of using existing `minimal` mode, add a new context mode `'background'` that:
- **Keeps:** identity, user, known users, EGO, AGENTS, skills, session info
- **Skips:** HEARTBEAT (cron already has the task), JANUS (project instructions irrelevant), memory search (cron doesn't need conversational memory), learner (no recommendations needed)

This saves the memory search (~8 chunks × ~500 tokens = ~4K) + learner (~500 tokens) + HEARTBEAT file content + JANUS file content per cron job without losing agent personality.

Implementation: Add `'background'` to the mode union type. In `context-builder.ts`, gate HEARTBEAT, JANUS, memory, and learner behind `mode !== 'background'` (in addition to existing `!minimal` gate).

**Estimated savings:** ~10-20K tokens per cron/heartbeat job execution.

### Fix 5 — Token Debug Flag

**Current state:** Cache read/write tokens extracted in `anthropic-provider.ts:200-203` but only logged at `debug` level. Memory flush and summarization LLM calls have no token tracking at all.

**Change:** Add `--token-debug` flag to gateway and CLI commands. When enabled, every LLM call logs a structured one-liner to stdout:

```
[TOKEN] chat      | anthropic claude-sonnet-4-6  | in:48200 out:1250 | cache_read:41000 cache_write:7200 | hit:85%
[TOKEN] flush     | anthropic claude-haiku-4-5   | in:3100  out:420  | cache_read:0     cache_write:3100 | hit:0%
[TOKEN] cron      | anthropic claude-haiku-4-5   | in:22000 out:800  | cache_read:18000 cache_write:4000 | hit:81%
[TOKEN] summarize | anthropic claude-haiku-4-5   | in:8500  out:1200 | cache_read:0     cache_write:8500 | hit:0%
```

**Implementation:**

1. **Global flag:** `tokenDebugEnabled` boolean, exported from `src/utils/logger.ts`. Set by CLI flag parsing.

2. **`logTokenUsage()` function** in `src/utils/logger.ts`:
```typescript
export function logTokenUsage(purpose: string, provider: string, model: string, usage: TokenUsage): void {
  if (!tokenDebugEnabled) return;
  const total = usage.promptTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const hitRate = total > 0 ? Math.round(((usage.cacheReadTokens ?? 0) / total) * 100) : 0;
  console.log(`[TOKEN] ${purpose.padEnd(9)} | ${provider} ${model} | in:${usage.promptTokens} out:${usage.completionTokens} | cache_read:${usage.cacheReadTokens ?? 0} cache_write:${usage.cacheWriteTokens ?? 0} | hit:${hitRate}%`);
}
```

3. **Logging points** — add `logTokenUsage()` call after every LLM response:
   - `agent-loop.ts` iterate() after LLM response → purpose from `msg.lane` ('chat'/'cron'/'heartbeat')
   - `agent-loop.ts` flushMemory() after flush LLM response → purpose 'flush'
   - `agent-loop.ts` doSummarization() after summarization LLM response → purpose 'summarize'

4. **CLI integration:**
   - `src/index.ts` gateway command: add `.option('--token-debug', 'Log per-request token breakdown')` 
   - `src/index.ts` default CLI command: add same option
   - Both set `log.enableTokenDebug()` before `createApp()`

5. **Provider name + model in response:** Currently `ChatResponse` doesn't include provider/model info. Add optional `provider?: string` and `model?: string` to `ChatResponse`. Set in `ProviderRegistry.chat()` / `chatStream()` from the `entry` that succeeded.

**No database, no persistence, no daily notes.** Pure console output, zero overhead when flag is off.

## Files Changed

| File | Change |
|------|--------|
| `src/context/context-builder.ts` | Return `ContextResult` (static + dynamic), add `'background'` mode, move time from identity to session |
| `src/llm/anthropic-provider.ts` | Send 3 system blocks (oauth + static cached + dynamic uncached) |
| `src/llm/openai-compatible-provider.ts` | Concatenate static+dynamic for non-Anthropic providers |
| `src/llm/codex-oauth-provider.ts` | Same concatenation |
| `src/llm/claude-agent-provider.ts` | Same concatenation (if applicable) |
| `src/llm/types.ts` | `ChatResponse` add `provider?`, `model?` fields |
| `src/llm/provider-registry.ts` | Set `provider`/`model` on response from winning entry |
| `src/agent/agent-loop.ts` | Update build() caller for ContextResult, remove idle+count flush, remove quality retry, add logTokenUsage() calls |
| `src/services/cron-service.ts` | Set `contextMode: 'background'` on publishInbound |
| `src/utils/logger.ts` | Add `tokenDebugEnabled`, `enableTokenDebug()`, `logTokenUsage()` |
| `src/index.ts` | Add `--token-debug` option to gateway and default commands |
| `src/bus/types.ts` | Add `'background'` to contextMode union |

## Config Changes

None. All changes are code-level. `--token-debug` is a CLI flag, not a config option (it's a debugging tool, not a feature).

## What Gets Deleted

- `localTimestamp()` call in `buildIdentity()` — time moves to `<session>` block
- Idle flush timer logic (setTimeout/clearTimeout, idleTimer field)
- Count-based flush logic (interval check, content hash dedup, lastFlushHash field)
- Summarization quality retry block (hasScheduling heuristic + retry LLM call)

## What We Explicitly Don't Do

- **No SQLite token_log table** — debug flag on console is sufficient, no storage bloat
- **No mtime-based system prompt caching** — static/dynamic split achieves 80% of the benefit without the complexity
- **No intelligent model routing** (complexity scoring) — good idea but separate feature, not a waste fix
- **No changes to compaction/context-budget** — already optimized in prior spec (reverse compaction, dual cache markers)
- **No changes to memory flush LLM prompt or behavior** — only reducing frequency, not changing quality

## Testing Strategy

- **Unit: context-builder** — Verify `build()` returns `{ staticPart, dynamicPart }`, static part has no timestamp, dynamic part has session/memory/learner, `'background'` mode skips memory+learner+HEARTBEAT+JANUS
- **Unit: anthropic-provider** — Verify 3 system blocks sent (with and without OAuth), only first two have `cache_control`
- **Unit: agent-loop** — Verify only token-aware flush remains (mock clock, verify no idle timer fires), verify no quality retry after summarization
- **Unit: cron-service** — Verify `contextMode: 'background'` set on published messages
- **Unit: logger** — Verify `logTokenUsage()` outputs correct format when enabled, silent when disabled
- **Unit: provider-registry** — Verify `provider`/`model` fields set on ChatResponse
- **Existing tests** — All 563 existing tests must pass
