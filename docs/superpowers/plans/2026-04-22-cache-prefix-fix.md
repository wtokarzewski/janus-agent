# Cache Prefix Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Anthropic prompt cache hit rate from 13% to 85-90% by moving dynamic context out of system blocks, adding penultimate message caching, clearing cron sessions, and removing misleading typing indicators.

**Architecture:** Four surgical changes in 2 main files (`anthropic-provider.ts`, `agent-loop.ts`) plus 1 new method in `session-manager.ts`. Dynamic context moves from system blocks to user message `<context>` XML. Cache markers consolidated to 4 breakpoints (Anthropic max). Cron sessions cleared after each run.

**Tech Stack:** TypeScript, Anthropic SDK, vitest

---

### Task 1: Simplify `applyCacheMarkers` to single marker

**Files:**
- Modify: `src/llm/anthropic-provider.ts:14-35`
- Modify: `tests/unit/anthropic-cache-markers.test.ts`

- [ ] **Step 1: Update test expectations for single-marker behavior**

In `tests/unit/anthropic-cache-markers.test.ts`, replace the entire file:

```typescript
import { describe, it, expect } from 'vitest';
import { applyCacheMarkers } from '../../src/llm/anthropic-provider.js';

describe('applyCacheMarkers', () => {
  it('marks only last tool when no MCP tools present', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks only last tool when MCP tools present (single marker saves cache budget)', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_search', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_pr', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    // Only last tool marked — saves 1 cache breakpoint for penultimate message
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toBeUndefined();
    expect((tools[2] as any).cache_control).toBeUndefined();
    expect((tools[3] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles single tool', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles empty tools list', () => {
    const tools: any[] = [];
    applyCacheMarkers(tools);
    expect(tools.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/anthropic-cache-markers.test.ts`
Expected: FAIL — MCP test expects `tools[1]` to have no marker, but current code marks it.

- [ ] **Step 3: Simplify `applyCacheMarkers` implementation**

In `src/llm/anthropic-provider.ts`, replace lines 7-35:

```typescript
/**
 * Apply prompt cache marker to last tool definition.
 * Single marker conserves Anthropic's 4-breakpoint budget
 * (system + tool + penultimate msg + last msg).
 */
export function applyCacheMarkers(tools: Array<{ name: string; cache_control?: unknown }>): void {
  if (tools.length === 0) return;
  tools[tools.length - 1].cache_control = { type: 'ephemeral' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/anthropic-cache-markers.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/llm/anthropic-provider.ts tests/unit/anthropic-cache-markers.test.ts
git commit -m "refactor: simplify applyCacheMarkers to single last-tool marker

Saves 1 cache breakpoint for penultimate message marker (Anthropic max 4)."
```

---

### Task 2: Add `applyCacheToPenultimateMessage` and merge OAuth+static system block

**Files:**
- Modify: `src/llm/anthropic-provider.ts:120-148` (non-stream path) and `260-291` (stream path)
- Modify: `tests/unit/anthropic-cache-markers.test.ts`

- [ ] **Step 1: Write tests for penultimate message cache and system block merging**

Append to `tests/unit/anthropic-cache-markers.test.ts`:

```typescript
import { applyCacheToPenultimateMessage } from '../../src/llm/anthropic-provider.js';

describe('applyCacheToPenultimateMessage', () => {
  it('marks penultimate message when 3+ messages exist', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'user' as const, content: 'question' },
    ];
    applyCacheToPenultimateMessage(messages);
    expect((messages[1] as any).content).toEqual([{
      type: 'text', text: 'hi',
      cache_control: { type: 'ephemeral' },
    }]);
    // First and last unchanged
    expect(messages[0].content).toBe('hello');
    expect(messages[2].content).toBe('question');
  });

  it('handles penultimate with array content', () => {
    const messages = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'part1' },
        { type: 'text' as const, text: 'part2' },
      ] },
      { role: 'user' as const, content: 'b' },
    ];
    applyCacheToPenultimateMessage(messages);
    expect((messages[1].content as any)[0].cache_control).toBeUndefined();
    expect((messages[1].content as any)[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('skips when fewer than 3 messages', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    applyCacheToPenultimateMessage(messages);
    expect(messages[1].content).toBe('hi');
  });

  it('skips empty messages array', () => {
    const messages: any[] = [];
    applyCacheToPenultimateMessage(messages);
    expect(messages.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/anthropic-cache-markers.test.ts`
Expected: FAIL — `applyCacheToPenultimateMessage` not exported.

- [ ] **Step 3: Implement `applyCacheToPenultimateMessage`**

In `src/llm/anthropic-provider.ts`, add after the `applyCacheToLastUserMessage` function (after line ~439):

```typescript
/**
 * Add cache_control to the penultimate message to cache conversation history prefix.
 * Between requests, the previous "last user message" becomes the penultimate —
 * its prefix (system + tools + history) is identical, enabling cache hit on ~50K tokens.
 */
export function applyCacheToPenultimateMessage(messages: Anthropic.MessageParam[]): void {
  if (messages.length < 3) return;
  const msg = messages[messages.length - 2];

  if (Array.isArray(msg.content)) {
    const lastBlock = msg.content[msg.content.length - 1];
    if (lastBlock && ('type' in lastBlock)) {
      (lastBlock as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
  } else if (typeof msg.content === 'string') {
    (msg as unknown as Record<string, unknown>).content = [{
      type: 'text' as const,
      text: msg.content,
      cache_control: { type: 'ephemeral' as const },
    }];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/anthropic-cache-markers.test.ts`
Expected: PASS — all tests green.

- [ ] **Step 5: Update non-stream path — merge OAuth+static, remove dynamicPart, add penultimate**

In `src/llm/anthropic-provider.ts`, replace the system blocks section (lines 120-148) and add penultimate call (after line 175):

Replace lines 120-148:
```typescript
    // OAuth tokens require Claude Code identity in system prompt
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    if (request.systemParts) {
      // Merge OAuth prefix + staticPart into single cached block (1 of 4 breakpoints)
      const prefix = this.useOAuth
        ? "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
        : '';
      systemBlocks.push({
        type: 'text' as const,
        text: prefix + request.systemParts.staticPart,
        cache_control: { type: 'ephemeral' as const },
      });
      // dynamicPart is injected into user message by agent-loop (not in system blocks)
    } else if (this.useOAuth) {
      systemBlocks.push({
        type: 'text' as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' as const },
      });
      if (systemMsg) {
        systemBlocks.push({
          type: 'text' as const,
          text: systemMsg.content,
          cache_control: { type: 'ephemeral' as const },
        });
      }
    } else if (systemMsg) {
      systemBlocks.push({
        type: 'text' as const,
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' as const },
      });
    }
```

After the existing `applyCacheToLastUserMessage(params.messages);` line, add:
```typescript
    applyCacheToPenultimateMessage(params.messages);
```

- [ ] **Step 6: Update stream path — same changes**

In `src/llm/anthropic-provider.ts`, replace the stream system blocks section (lines ~260-291) with the same pattern:

```typescript
    // OAuth tokens require Claude Code identity in system prompt
    const streamSystemBlocks: Anthropic.TextBlockParam[] = [];
    if (request.systemParts) {
      const prefix = this.useOAuth
        ? "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
        : '';
      streamSystemBlocks.push({
        type: 'text' as const,
        text: prefix + request.systemParts.staticPart,
        cache_control: { type: 'ephemeral' as const },
      });
    } else if (this.useOAuth) {
      streamSystemBlocks.push({
        type: 'text' as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' as const },
      });
      if (systemMsg) {
        streamSystemBlocks.push({
          type: 'text' as const,
          text: systemMsg.content,
          cache_control: { type: 'ephemeral' as const },
        });
      }
    } else if (systemMsg) {
      streamSystemBlocks.push({
        type: 'text' as const,
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' as const },
      });
    }
```

After the existing `applyCacheToLastUserMessage(params.messages);` in the stream path, add:
```typescript
    applyCacheToPenultimateMessage(params.messages);
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions.

- [ ] **Step 8: Commit**

```bash
git add src/llm/anthropic-provider.ts tests/unit/anthropic-cache-markers.test.ts
git commit -m "feat: add penultimate message cache marker, merge OAuth+static system block

Consolidates 4 cache breakpoints within Anthropic's limit:
1. System (OAuth+static merged)
2. Last tool
3. Penultimate message (enables ~50K cache hit between messages)
4. Last user message (enables ~57K cache hit within multi-iteration)"
```

---

### Task 3: Move dynamicPart from system prompt to user message

**Files:**
- Modify: `src/agent/agent-loop.ts:342` and `~360`

- [ ] **Step 1: Change systemPrompt to staticPart only**

In `src/agent/agent-loop.ts`, replace line 342:

```typescript
    // BEFORE:
    // const systemPrompt = staticPart + '\n\n---\n\n' + dynamicPart;
    // AFTER — dynamicPart moves to user message for Anthropic prefix cache stability
    const systemPrompt = staticPart;
```

- [ ] **Step 2: Inject dynamicPart into userContent**

In `src/agent/agent-loop.ts`, after the cron context injection block (after line 358 — `}`), add:

```typescript

    // Dynamic context in user message — system blocks stay stable for Anthropic prefix cache.
    // Order: <context>dynamic</context> → cron injection → reply context → user message
    if (dynamicPart) {
      userContent = `<context>\n${dynamicPart}\n</context>\n\n${userContent}`;
    }
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. The integration test mocks LLM so it doesn't test cache behavior, but it verifies the agent loop still works end-to-end.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: Clean — no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "feat: move dynamicPart from system blocks to user message

Dynamic context (memory, profile, timestamp, summary) now injected as
<context> XML in user message instead of Anthropic system block[2].
Keeps system+tools prefix stable for cache hits between messages."
```

---

### Task 4: Add `SessionManager.clear()` and clear cron sessions after run

**Files:**
- Modify: `src/session/session-manager.ts`
- Modify: `src/agent/agent-loop.ts:486-496`

- [ ] **Step 1: Add `clear()` method to SessionManager**

In `src/session/session-manager.ts`, add after the `summarize` method (after line ~200, before `private async appendIncremental`):

```typescript
  /** Clear all messages from a session, preserving the session file. */
  async clear(key: string): Promise<void> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);
      session.messages = [];
      session.metadata.summary = undefined;
      session.metadata.messageCount = 0;
      session.metadata.lastFlushed = 0;
      session.metadata.updated = new Date().toISOString();
      await this.save(key, session);
    });
  }
```

- [ ] **Step 2: Add cron session clearing in processSystemMessage**

In `src/agent/agent-loop.ts`, in the `processSystemMessage` method, after line 545 (end of the routing block — the line `if (sentTargets.some(...)`) find the end of the method. The method ends around line 550-555. Before the final closing brace of `processSystemMessage`, add the session clearing logic.

Actually, the cleanest insertion point is right after `const response = await this.processMessage(msg, { sentTargets });` (line 486) and before the no-op checks. But we need the session key. Let me locate it precisely.

The session key is computed inside `processMessage`. We need it here. The session key pattern is `{agentId}:{channel}:{chatId}`. We can reconstruct it or better — add the clearing at the END of processSystemMessage, after all routing.

Find the end of `processSystemMessage` — it's the closing `}` of the method. Before that closing brace, add:

```typescript
    // Clear cron/heartbeat sessions after each run — they're stateless
    // (tasks fetch fresh data via tools, user replies go to telegram session)
    if (msg.lane === 'heartbeat' || msg.lane === 'cron') {
      const agentId = this.deps.agentResolver?.resolve(msg)?.id ?? 'main';
      const sessionKey = `${agentId}:${msg.channel}:${msg.chatId}`;
      try {
        const session = await this.deps.sessions.getOrCreate(sessionKey);
        const estimate = estimateMessagesTokens(session.messages);
        if (estimate > 80_000) {
          log.warn(`[${sessionKey}] Cron session reached ~${Math.round(estimate / 1000)}K tokens`);
        }
        log.info(`[${sessionKey}] Cron session cleared (~${Math.round(estimate / 1000)}K tokens)`);
        await this.deps.sessions.clear(sessionKey);
      } catch (err) {
        log.warn(`Failed to clear cron session: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/session/session-manager.ts src/agent/agent-loop.ts
git commit -m "feat: clear cron/heartbeat sessions after each run

Prevents session accumulation (188K+ tokens). Adds SessionManager.clear()
method. Logs session size before clearing, warns if >80K tokens."
```

---

### Task 5: Remove typing indicator during background summarization

**Files:**
- Modify: `src/agent/agent-loop.ts:1138-1163`

- [ ] **Step 1: Remove typing events from triggerSummarization**

In `src/agent/agent-loop.ts`, replace the `triggerSummarization` method (lines 1138-1163):

```typescript
  private async triggerSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    channel: string,
    chatId: string,
    userId?: string,
    scope?: InboundMessage['scope'],
    preTokenEstimate?: number,
  ): Promise<void> {
    // Double-fire guard (C2)
    this.summarizing.add(sessionKey);
    try {
      await this.doSummarization(sessionKey, messages, userId, scope, preTokenEstimate);
    } finally {
      this.summarizing.delete(sessionKey);
    }
  }
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "fix: remove misleading typing indicator during background summarization

User already received the response — showing 'typing...' for up to 87s
during background flush/summarization is confusing."
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: Clean.

- [ ] **Step 3: Verify no external project references**

Run: `grep -ri 'competitor' src/ docs/ tests/ --include='*.ts' --include='*.md' | grep -v node_modules`
Expected: No matches.

- [ ] **Step 4: Create PR branch and push**

```bash
git checkout -b fix/cache-prefix-optimization
git push -u origin fix/cache-prefix-optimization
```

- [ ] **Step 5: Create PR**

Title: `fix: Anthropic prompt cache prefix optimization`

Body:
```
## Summary

- Move dynamic context (memory, profile, timestamp, summary) from system blocks to user message `<context>` XML — fixes prefix cache chain for tools and history
- Add penultimate message cache marker — enables ~50K token cache hit between messages
- Consolidate cache breakpoints to 4 (Anthropic max): system, last tool, penultimate msg, last user msg
- Clear cron/heartbeat sessions after each run — prevents 188K+ token session accumulation
- Remove misleading typing indicator during background summarization (up to 87s "typing..." after response)

## Test plan

- [x] All existing tests pass
- [x] Typecheck clean
- [x] No competitor references
- [ ] Manual: `npm start -- gateway --token-debug` — verify cache_read ~50K (was 7.5K) on consecutive chat messages
- [ ] Manual: Verify heartbeat sessions show "cleared" log after each run
```
