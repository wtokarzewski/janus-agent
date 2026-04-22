# Hybrid Token Optimization — Design Spec

**Date:** 2026-04-06
**Status:** Draft
**Depends on:** Context management overhaul (merged PR #163)

## Problem

Janus consumes more tokens than necessary due to three gaps:

1. **Cache invalidation** — Single cache marker on last tool means any MCP tool change invalidates the entire cached prefix (system prompt + all tools). Cache misses cost 10x more than hits.
2. **Blind compaction** — Phase 1-2 compact oldest-first, destroying the cached prefix. Tool results are truncated without extracting useful information first. tool_use/tool_result pairs can be split.
3. **No externalization** — Large tool results (up to 400K chars) sit in context even when the model only needs a 1-line summary of the outcome.

## Solution: Three-Layer Hybrid

### Layer 1 — Cache Maximization

**Goal:** Maximize Anthropic prompt cache hit rate. Cache reads cost 10% of normal input tokens.

#### 1a. Dual Cache Markers

Current state (`anthropic-provider.ts:117-120`): single `cache_control: ephemeral` on last tool.

Change: Place TWO markers:
1. On the **last built-in tool** (stable boundary — built-in tools don't change between turns)
2. On the **last tool overall** (current behavior, covers MCP tools)

Detection: Built-in tools don't have `mcp_` prefix. Walk backwards from end of tool list to find last non-`mcp_` tool.

```typescript
// In tool mapping loop, after building the tools array:
let lastBuiltinIdx = -1;
for (let i = tools.length - 1; i >= 0; i--) {
  if (!tools[i].name.startsWith('mcp_')) { lastBuiltinIdx = i; break; }
}
const lastIdx = tools.length - 1;
// Mark both boundaries (deduplicate if same index)
if (lastBuiltinIdx >= 0) tools[lastBuiltinIdx].cache_control = { type: 'ephemeral' };
if (lastIdx !== lastBuiltinIdx) tools[lastIdx].cache_control = { type: 'ephemeral' };
```

Applies to both `chat()` and `chatStream()` methods.

#### 1b. Stable Tool Ordering

Current state (`tool-registry.ts:25-29`): `list()` sorts all tools alphabetically.

This is already correct — alphabetical sort is deterministic. MCP tools get `mcp_` prefix so they naturally sort after built-in tools. No change needed to `list()`.

Verify: built-in tool names (append_file, browser, cron, edit_file, exec, heartbeat, invite, list_dir, message, read_file, self_update, spawn_agent, web_fetch, web_search, write_file) all sort before `mcp_*`. Confirmed.

#### 1c. Reverse Compaction Direction (Phase 1 & 2)

Current state (`context-budget.ts:107, 128`): iterates `i = firstUserIndex → tailStart` (oldest-first). This mutates old messages that are in the Anthropic cache prefix, causing cache invalidation on every compaction.

Change: Reverse iteration to `i = tailStart-1 → firstUserIndex` (newest-first). Old messages stay pristine in cache.

```typescript
// Phase 1: reverse loop
for (let i = tailStart - 1; i >= firstUserIndex && tokens > t1 * tokenBudget; i--) {
  // ... same body
}

// Phase 2: reverse loop
for (let i = tailStart - 1; i >= firstUserIndex && tokens > t2 * tokenBudget; i--) {
  // ... same body
}
```

Phase 3 (drop turns) stays oldest-first — it removes entire messages, so prefix changes regardless.

#### 1d. Cache Hit Rate Tracking

Current state: `cacheReadTokens` and `cacheWriteTokens` extracted but only logged at debug level.

Change: Accumulate across iterations in agent-loop and log a summary per request:
- Total prompt tokens, cache read tokens, cache write tokens
- Cache hit rate: `cacheRead / (promptTokens + cacheRead + cacheWrite) * 100`
- Log at info level after each completed request

No config change needed — purely observability.

### Layer 2 — Smarter Compaction

**Goal:** Preserve information during compaction. Don't lose facts.

#### 2a. Tool Pair Preservation

Current state: Phase 3 drops assistant + following tool messages. But Phase 1-2 can soft-trim or hard-clear a tool_result while the corresponding tool_use in the assistant message still references it, creating orphan references.

Change: In Phase 1-2, when processing a tool message, check if it's the LAST tool result for its corresponding assistant's tool_use block. If the assistant message has N tool_calls, all N tool results must be treated as a group. Don't partially clear — either all tool results for a turn get the same treatment, or none.

Implementation: Track assistant-to-tool-group boundaries. When entering Phase 1 or 2, identify "turn groups" (assistant + its tool results). Process groups atomically.

```typescript
interface TurnGroup {
  assistantIdx: number;
  toolIndices: number[];
}
```

Build turn groups once before Phase 1, reuse in Phase 2.

#### 2b. MCP Artifact Externalization

Current state: Large tool results (up to 400K chars) truncated at persist time with head+tail. Model sees truncated content.

Change: For tool results exceeding a threshold (default 32K chars), write the full result to disk and replace with a compact reference + key extracted facts.

Storage: `.janus/artifacts/{sessionKey}/{toolName}_{timestamp}.txt`

Replacement format:
```
[Tool result stored: .janus/artifacts/.../{file}]
[Size: 245,891 chars]

First 500 chars of output:
{head}

Last 500 chars of output:
{tail}
```

This preserves the head/tail for context while making the full result available via read_file if the agent needs it.

Config: `agent.context.artifactThreshold` (default: 32,000 chars). Set to 0 to disable.

Applies in `session-manager.ts:truncateToolResult()` — rename to `processToolResult()` and add externalization logic before truncation.

#### 2c. Overflow Recovery Limit

Current state (`agent-loop.ts`): On context overflow error, triggers emergency compaction and retries. No explicit limit on retries.

Change: Track overflow retry count per iteration. Maximum 1 retry after emergency compaction. If it fails again, return error message to user instead of infinite loop.

```typescript
let overflowRetries = 0;
// ... in catch block:
if (isContextOverflow(err) && overflowRetries < 1) {
  overflowRetries++;
  enforceContextBudget(messages, config.agent, true); // emergency
  continue; // retry iteration
}
// else: throw or return error
```

#### 2d. Multi-Provider Overflow Detection

Current state: Overflow detected by specific Anthropic error patterns only.

Change: Add pattern library for common providers:
- Anthropic: `request_too_large`, `prompt is too long`
- OpenAI: `maximum context length`, `Request too large`
- Google: `exceeds the maximum`
- OpenRouter: wraps upstream errors

Single `isContextOverflow(error: Error): boolean` function in `src/llm/overflow.ts`.

### Layer 3 — Summarization Quality

**Goal:** Extract maximum information from minimum tokens.

#### 3a. English-Only Summaries

Current state: Summarization prompt doesn't specify language. Model summarizes in the conversation language (often Polish).

Change: Add explicit instruction to summarization prompts (both `initial.md` and `update.md`):
```
IMPORTANT: Always write the summary in English regardless of the conversation language.
English summaries are more token-efficient and improve model comprehension.
```

Polish text uses ~30% more tokens than equivalent English for the same information content. System-level summaries don't need to be in user language.

#### 3b. Tool Result Key-Value Extraction

Current state: Phase 2 hard-clears tool results to `[tool result cleared]` — all information lost.

Change: Before clearing in Phase 2, extract a 1-line annotation from the tool result:
- For exec results: exit code + first line of stdout
- For read_file: file path + line count
- For web_fetch/web_search: URL + title/status
- For other tools: first 120 chars

Replace `[tool result cleared]` with `[cleared — {annotation}]`.

This is a heuristic extraction, not an LLM call. Pure string operations, zero cost.

```typescript
function extractAnnotation(toolName: string, content: string): string {
  const maxLen = 120;
  if (toolName === 'exec') {
    const firstLine = content.split('\n')[0]?.slice(0, maxLen) ?? '';
    return `exec: ${firstLine}`;
  }
  // ... similar for read_file, web_fetch, etc.
  return content.slice(0, maxLen).replace(/\n/g, ' ');
}
```

## Files Changed

| File | Change |
|------|--------|
| `src/llm/anthropic-provider.ts` | Dual cache markers in `chat()` and `chatStream()` |
| `src/agent/context-budget.ts` | Reverse Phase 1-2 loops, turn group preservation, annotation extraction |
| `src/agent/agent-loop.ts` | Cache hit tracking accumulation, overflow retry limit, cache rate logging |
| `src/session/session-manager.ts` | Artifact externalization in `processToolResult()` |
| `src/llm/overflow.ts` | New file: multi-provider overflow detection patterns |
| `src/config/schema.ts` | Add `artifactThreshold` to ContextSchema |
| `src/prompts/summarization/initial.md` | English-only instruction |
| `src/prompts/summarization/update.md` | English-only instruction |
| `janus.example.json` | Document `artifactThreshold` |

## Config Changes

```json
{
  "agent": {
    "context": {
      "artifactThreshold": 32000
    }
  }
}
```

Single new field. All other behavior changes are internal improvements with no config surface.

## Testing Strategy

- **Unit: context-budget.ts** — Verify reverse compaction direction, turn group preservation, annotation extraction
- **Unit: anthropic-provider.ts** — Verify dual cache markers placed correctly with/without MCP tools
- **Unit: overflow.ts** — Pattern matching for each provider
- **Unit: session-manager.ts** — Artifact externalization with threshold, file creation, reference format
- **Integration: agent-loop** — Overflow retry limit (mock LLM returning overflow twice)
- **Existing tests** — All 466 existing tests must pass (regression safety)

## What Gets Deleted

- Nothing. All changes are additive or modify existing behavior in-place.

## What We Explicitly Don't Do

- **No SQLite context store** — too large a refactor for incremental gain over current JSONL
- **No LLM-based summarization of tool results** — heuristic extraction is free, LLM calls are not
- **No budget-aware assembly** — current post-hoc compaction with reversed direction achieves 80% of the benefit
- **No cursor-based history tracking** — current pointer-based `lastFlushed` is sufficient
- **No checkpoint/resume system** — adds complexity for edge case recovery
