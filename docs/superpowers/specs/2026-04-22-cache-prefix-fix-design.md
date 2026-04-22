# Cache Prefix Fix — Design Spec

**Date:** 2026-04-22
**Status:** Approved
**Depends on:** Token waste overhaul (PR #181, #184) — this spec fixes the remaining cache miss issue

## Problem

PR #181 split the system prompt into static/dynamic parts. PR #184 added `applyCacheToLastUserMessage()`. Despite both fixes, production logs (2026-04-21, `--token-debug`) show **13% cache hit rate** — only ~7,500 tokens cached out of ~57K total.

Root cause: Anthropic prompt caching is **prefix-based**. The request is serialized as `system → tools → messages`. Each `cache_control: ephemeral` marker creates a breakpoint. Cache hits require an **identical prefix** from the start of the request up to the breakpoint.

Current system blocks: `[OAuth (ephemeral), staticPart (ephemeral), dynamicPart (no marker)]`

The dynamicPart (timestamp, memory, learner, summary) **changes every request** and sits between staticPart and tools in the prefix chain. This means:
- BP1 at OAuth: cache hit (~20 tokens)
- BP2 at staticPart: cache hit (~7,500 tokens) ← the 7519 in logs
- BP3 at last tool: **MISS** — prefix includes changed dynamicPart
- BP4 at last user message: **MISS** — same reason

Everything after dynamicPart (tools ~5K + history ~43K) is rewritten every request at 12.5x the cost of a cache read.

## Solution: Four Fixes

### Fix 1 — Move dynamicPart from system blocks to user message

Remove dynamicPart from Anthropic system blocks. Prepend it to the user message as `<context>` XML.

**agent-loop.ts (~342)**:
```typescript
// BEFORE:
const systemPrompt = staticPart + '\n\n---\n\n' + dynamicPart;

// AFTER:
const systemPrompt = staticPart;
```

**agent-loop.ts (~360)** — after cron context injection (line 358), before building userMessage (line 362):
```typescript
// Dynamic context in user message — keeps system blocks stable for Anthropic cache
if (dynamicPart) {
  userContent = `<context>\n${dynamicPart}\n</context>\n\n${userContent}`;
}
```

Final user message structure: `<context>dynamic</context> → cron injection (if any) → reply context (if any) → actual message`.

**anthropic-provider.ts** — both non-stream (129-140) and stream (269-280) paths:
```typescript
// Combine OAuth + staticPart into single system block (saves 1 cache marker)
if (request.systemParts) {
  const prefix = this.useOAuth
    ? "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
    : '';
  systemBlocks.push({
    type: 'text',
    text: prefix + request.systemParts.staticPart,
    cache_control: { type: 'ephemeral' },
  });
} else if (this.useOAuth) {
  // Keep OAuth block for non-split callers (flush, summarization)
  systemBlocks.push({
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' },
  });
}
// Fallback for non-split callers stays unchanged
```

Non-Anthropic providers (OpenAI, Codex, ClaudeAgent) are unaffected — they use the concatenated `systemPrompt` from messages[0] and ignore `systemParts`. The dynamicPart now arrives via user message content, which these providers process normally.

### Fix 2 — Penultimate message cache marker

Anthropic allows **max 4 cache breakpoints** per request. After Fix 1 consolidates OAuth+static into 1 block, the allocation becomes:

| # | Marker | Cumulative cache |
|---|--------|-----------------|
| 1 | System (OAuth + staticPart) | ~7.5K tokens |
| 2 | Last tool | ~12K tokens (system + tools) |
| 3 | Penultimate message | ~50K tokens (system + tools + history) |
| 4 | Last user message | ~57K tokens (everything) |

**Why penultimate works between messages:** In request N, the "last user message" cache covers the full prefix. In request N+1, that same message is now the penultimate — and the prefix up to it is identical (system and tools unchanged after Fix 1). Cache hit on ~50K tokens.

Penultimate message marking and rolling-window strategies (last 2-3 messages) are well-established patterns for Anthropic prompt caching.

**New function** in `anthropic-provider.ts`:
```typescript
function applyCacheToPenultimateMessage(messages: Anthropic.MessageParam[]): void {
  if (messages.length < 3) return;
  const msg = messages[messages.length - 2];
  if (Array.isArray(msg.content)) {
    const lastBlock = msg.content[msg.content.length - 1];
    if (lastBlock) (lastBlock as any).cache_control = { type: 'ephemeral' };
  } else if (typeof msg.content === 'string') {
    (msg as any).content = [{
      type: 'text', text: msg.content,
      cache_control: { type: 'ephemeral' },
    }];
  }
}
```

**Simplify `applyCacheMarkers`** — mark only last tool (drop builtin/MCP split to save 1 marker):
```typescript
export function applyCacheMarkers(tools) {
  if (tools.length === 0) return;
  tools[tools.length - 1].cache_control = { type: 'ephemeral' };
}
```

### Fix 3 — Clear cron/heartbeat sessions after each run

Cron sessions persist across runs, accumulating to 188K tokens. Heartbeat tasks are stateless — they use tools to fetch fresh data each run. User replies go to `main:telegram:{chatId}`, not the cron session. Session history is pure waste.

**agent-loop.ts** — in `processSystemMessage()`, after processing:
```typescript
if (msg.lane === 'heartbeat' || msg.lane === 'cron') {
  const session = await this.deps.sessions.getOrCreate(sessionKey);
  const estimate = estimateMessagesTokens(session.messages);
  if (estimate > 80_000) {
    log.warn(`[${sessionKey}] Cron session reached ~${Math.round(estimate / 1000)}K tokens`);
  }
  log.info(`[${sessionKey}] Cron session cleared (~${Math.round(estimate / 1000)}K tokens)`);
  await this.deps.sessions.clear(sessionKey);
}
```

This also fixes the "Stripped 1 orphan tool message(s) from session start" warnings caused by stale tool messages from previous runs.

### Fix 4 — Remove typing indicator during background summarization/flush

`triggerSummarization()` currently shows typing during the entire background process (up to 87s). The user already received the response — the typing indicator is misleading.

**agent-loop.ts** — in `triggerSummarization()`:
- Remove `publishOutbound({ type: 'typing' })` at start
- Remove `publishOutbound({ type: 'typing_stop' })` at end

## Files Changed

| File | Change |
|------|--------|
| `src/agent/agent-loop.ts` | Prepend dynamicPart to userContent instead of system prompt; clear cron sessions after run with size log; remove typing from triggerSummarization |
| `src/llm/anthropic-provider.ts` | Merge OAuth+static into 1 system block; ignore dynamicPart in system blocks; add `applyCacheToPenultimateMessage()`; simplify `applyCacheMarkers()` to last-tool-only |

## What We Explicitly Don't Change

- **context-builder.ts** — ContextResult interface stays as-is. staticPart/dynamicPart split is correct, only the destination changes.
- **Non-Anthropic providers** — They don't support cache_control. Dynamic context in user messages works correctly.
- **Summarization/flush LLM calls** — They use different system prompts (summarization instructions). Cache sharing with chat is not possible by design. They stay as-is.
- **Memory flush frequency** — Already consolidated to token-aware trigger in PR #181.

## Expected Impact

| Metric | Before | After |
|--------|--------|-------|
| Chat cache hit rate | 13% | 85-90% |
| cache_read per message | ~7.5K tokens | ~50K tokens |
| cache_write per message | ~50K tokens | ~5K tokens |
| Cost ratio (write vs read) | 12.5x overpay | ~1x |
| Heartbeat session size | 188K (growing) | ~50K (constant, cleared) |
| Typing after response | up to 87s | 0s |
| Morning briefing API errors | Yes (188K context) | No (~50K context) |

## Testing Strategy

- **Unit: anthropic-provider** — Verify single system block (OAuth+static merged) with cache_control. Verify dynamicPart NOT in system blocks. Verify `applyCacheToPenultimateMessage` marks messages[-2]. Verify `applyCacheMarkers` marks only last tool.
- **Unit: agent-loop** — Verify dynamicPart prepended to userContent as `<context>` XML. Verify cron session cleared after processSystemMessage. Verify no typing events in triggerSummarization.
- **Manual: `--token-debug`** — Run gateway, send 3+ messages in same chat within 5 min. Expect cache_read ~50K (vs current 7.5K). Expect heartbeat sessions show "cleared" log.
- **Existing tests** — All tests must pass.
