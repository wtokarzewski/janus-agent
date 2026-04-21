# Token Waste Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token consumption ~70% by fixing broken prompt caching, eliminating redundant LLM calls, and adding diagnostic visibility.

**Architecture:** Split system prompt into static (cached) and dynamic (uncached) parts for Anthropic cache hits. Consolidate 3 memory flush triggers to 1. Remove wasteful summarization retry. Add `--token-debug` CLI flag for per-request token breakdown on stdout.

**Tech Stack:** TypeScript, Vitest, Anthropic SDK, Commander.js

**Spec:** `docs/superpowers/specs/2026-04-21-token-waste-overhaul-design.md`

---

### Task 1: Token Debug Logger

Add `--token-debug` flag infrastructure and `logTokenUsage()` function. This ships first so we can observe the impact of subsequent fixes.

**Files:**
- Modify: `src/utils/logger.ts`
- Modify: `src/llm/types.ts:57-63` (ChatResponse)
- Modify: `src/llm/provider-registry.ts:37-64` (chat method)
- Modify: `src/llm/provider-registry.ts:66-103` (chatStream method)
- Modify: `src/index.ts:34-36` (CLI default command options)
- Modify: `src/index.ts:127-131` (gateway command)
- Modify: `src/commands/gateway.ts:22,31-33`
- Test: `tests/unit/token-debug-logger.test.ts`

- [ ] **Step 1: Write failing tests for logTokenUsage**

Create `tests/unit/token-debug-logger.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logTokenUsage, enableTokenDebug, tokenDebugEnabled } from '../../src/utils/logger.js';

describe('logTokenUsage', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('does nothing when token debug is disabled', () => {
    logTokenUsage('chat', 'anthropic', 'claude-sonnet-4-6', {
      promptTokens: 1000, completionTokens: 200, totalTokens: 1200,
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('logs formatted line when token debug is enabled', () => {
    enableTokenDebug();
    logTokenUsage('chat', 'anthropic', 'claude-sonnet-4-6', {
      promptTokens: 48000, completionTokens: 1250, totalTokens: 49250,
      cacheReadTokens: 41000, cacheWriteTokens: 7000,
    });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('[TOKEN]');
    expect(output).toContain('chat');
    expect(output).toContain('anthropic');
    expect(output).toContain('claude-sonnet-4-6');
    expect(output).toContain('in:48000');
    expect(output).toContain('out:1250');
    expect(output).toContain('cache_read:41000');
    expect(output).toContain('cache_write:7000');
    expect(output).toContain('hit:85%');
  });

  it('shows CACHE MISS warning when cache_write >> 0 and cache_read = 0', () => {
    enableTokenDebug();
    logTokenUsage('chat', 'anthropic', 'claude-sonnet-4-6', {
      promptTokens: 50000, completionTokens: 500, totalTokens: 50500,
      cacheReadTokens: 0, cacheWriteTokens: 50000,
    });
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('CACHE MISS');
    expect(output).toContain('hit:0%');
  });

  it('handles missing cache fields gracefully', () => {
    enableTokenDebug();
    logTokenUsage('cron', 'openai', 'gpt-4o', {
      promptTokens: 5000, completionTokens: 300, totalTokens: 5300,
    });
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('cache_read:0');
    expect(output).toContain('cache_write:0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/token-debug-logger.test.ts`
Expected: FAIL — `logTokenUsage` and `enableTokenDebug` don't exist yet.

- [ ] **Step 3: Implement logTokenUsage in logger.ts**

Add to end of `src/utils/logger.ts`:

```typescript
import type { TokenUsage } from '../llm/types.js';

let _tokenDebugEnabled = false;

export function enableTokenDebug(): void {
  _tokenDebugEnabled = true;
}

export function tokenDebugEnabled(): boolean {
  return _tokenDebugEnabled;
}

export function logTokenUsage(purpose: string, provider: string, model: string, usage: TokenUsage): void {
  if (!_tokenDebugEnabled) return;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const total = usage.promptTokens + cacheRead + cacheWrite;
  const hitRate = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
  const missWarning = cacheWrite > 5000 && cacheRead === 0 ? ' ⚠ CACHE MISS' : '';
  console.log(`[TOKEN] ${purpose.padEnd(9)} | ${provider} ${model} | in:${usage.promptTokens} out:${usage.completionTokens} | cache_read:${cacheRead} cache_write:${cacheWrite} | hit:${hitRate}%${missWarning}`);
}
```

Note: The `import type` for `TokenUsage` creates a circular dependency risk since logger is imported everywhere. Instead, inline the type:

```typescript
export function logTokenUsage(
  purpose: string,
  provider: string,
  model: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): void {
```

- [ ] **Step 4: Add provider/model to ChatResponse and set in ProviderRegistry**

In `src/llm/types.ts`, add two optional fields to `ChatResponse` (after line 62):

```typescript
export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
  thinkingContent?: string;
  /** Provider name that fulfilled this request (set by ProviderRegistry). */
  provider?: string;
  /** Model ID used (set by ProviderRegistry). */
  model?: string;
}
```

In `src/llm/provider-registry.ts`, in `chat()` method (after line 50, where `return await entry.provider.chat(req)`):

```typescript
const result = await entry.provider.chat(req);
result.provider = entry.name;
result.model = entry.model;
return result;
```

Same pattern in `chatStream()` — after line 80 `return await entry.provider.chatStream(req, onChunk)`:

```typescript
const result = await entry.provider.chatStream(req, onChunk);
result.provider = entry.name;
result.model = entry.model;
return result;
```

And the fallback path at line 85:

```typescript
const response = await entry.provider.chat(req);
response.provider = entry.name;
response.model = entry.model;
```

- [ ] **Step 5: Wire --token-debug flag in CLI entry points**

In `src/index.ts`, update the default command (line 34):

```typescript
program
  .option('-m, --message <text>', 'Send a single message and exit')
  .option('-d, --debug', 'Enable debug logging')
  .option('--token-debug', 'Log per-request token breakdown to stdout')
  .action(async (opts: { message?: string; debug?: boolean; tokenDebug?: boolean }) => {
    if (opts.debug) log.setLogLevel('debug');
    if (opts.tokenDebug) log.enableTokenDebug();
```

In `src/index.ts`, update the gateway command (line 127-131):

```typescript
program
  .command('gateway')
  .description('Run in headless mode (Telegram and other channels)')
  .option('--token-debug', 'Log per-request token breakdown to stdout')
  .action(async (opts: { tokenDebug?: boolean }) => {
    await runGateway(opts);
  });
```

In `src/commands/gateway.ts`, update `runGateway` signature (line 22):

```typescript
export async function runGateway(opts?: { tokenDebug?: boolean }): Promise<void> {
  const config = await loadConfig();
  // ... existing code ...
  if (process.argv.includes('--debug') || process.argv.includes('-d')) {
    log.setLogLevel('debug');
  }
  if (opts?.tokenDebug) {
    log.enableTokenDebug();
  }
```

- [ ] **Step 6: Add logTokenUsage calls in agent-loop.ts**

In `src/agent/agent-loop.ts`, after the LLM response is received (after line 800):

```typescript
log.info(`[${sessionKey}] LLM call done in ${Date.now() - llmStart}ms (tokens=${response.usage.totalTokens})`);
log.logTokenUsage(
  msg.lane ?? 'chat',
  response.provider ?? 'unknown',
  response.model ?? 'unknown',
  response.usage,
);
```

In `flushMemory()`, after flushResponse is received (after line 1087):

```typescript
log.info(`[${sessionKey}] Memory flush: LLM call done in ${Date.now() - flushStart}ms`);
log.logTokenUsage('flush', flushResponse.provider ?? 'unknown', flushResponse.model ?? 'unknown', flushResponse.usage);
```

In `doSummarization()`, after summaryResponse is received (after line 1281):

```typescript
log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);
log.logTokenUsage('summarize', summaryResponse.provider ?? 'unknown', summaryResponse.model ?? 'unknown', summaryResponse.usage);
```

- [ ] **Step 7: Run all tests**

Run: `npm test`
Expected: All 563+ tests pass, new token-debug tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/utils/logger.ts src/llm/types.ts src/llm/provider-registry.ts src/index.ts src/commands/gateway.ts src/agent/agent-loop.ts tests/unit/token-debug-logger.test.ts
git commit -m "feat: --token-debug flag for per-request token breakdown

Adds logTokenUsage() to logger with structured one-liner format.
Shows input/output tokens, cache read/write, hit rate, and CACHE MISS warnings.
Provider name and model now tracked on ChatResponse via ProviderRegistry."
```

---

### Task 2: Split System Prompt Static/Dynamic

The biggest win — enables Anthropic prompt cache hits by keeping stable content in a cached block.

**Files:**
- Modify: `src/context/context-builder.ts` (return ContextResult, move time to session)
- Modify: `src/agent/agent-loop.ts:335-382` (handle ContextResult)
- Modify: `src/llm/anthropic-provider.ts:120-138,244-262` (3 system blocks)
- Modify: `src/agent/subagent.ts` (if it calls context.build)
- Test: `tests/unit/context-builder.test.ts` (update existing + add new)

- [ ] **Step 1: Write failing tests for ContextResult**

Add to `tests/unit/context-builder.test.ts`:

```typescript
describe('ContextBuilder static/dynamic split', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    writeFileSync(join(tempDir, '.janus', 'EGO.md'), '# Ego\nI am Janus.');
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Agent Rules\nBe helpful.');
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), '# Tasks\n- every 5m: ping');
    writeFileSync(join(tempDir, 'JANUS.md'), '# Project\nTest project.');
  });

  it('build returns staticPart and dynamicPart', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'cli', chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
      userMessage: 'hello',
    });
    expect(result).toHaveProperty('staticPart');
    expect(result).toHaveProperty('dynamicPart');
  });

  it('staticPart contains identity, EGO, AGENTS, HEARTBEAT, JANUS, skills', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'cli', chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'full',
    });
    expect(result.staticPart).toContain('<identity>');
    expect(result.staticPart).toContain('<ego>');
    expect(result.staticPart).toContain('<agents>');
    expect(result.staticPart).toContain('<heartbeat>');
    expect(result.staticPart).toContain('<project>');
  });

  it('staticPart does NOT contain timestamp (only date in dynamic)', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'cli', chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
    });
    // Identity should NOT have "Current time: YYYY-MM-DD HH:MM:SS"
    expect(result.staticPart).not.toMatch(/Current time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    // Session in dynamic part should have date + time
    expect(result.dynamicPart).toContain('<session>');
    expect(result.dynamicPart).toMatch(/Date:/);
    expect(result.dynamicPart).toMatch(/Time:/);
  });

  it('dynamicPart contains session, and NOT EGO/AGENTS/HEARTBEAT/JANUS', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'cli', chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
    });
    expect(result.dynamicPart).toContain('<session>');
    expect(result.dynamicPart).not.toContain('<ego>');
    expect(result.dynamicPart).not.toContain('<agents>');
    expect(result.dynamicPart).not.toContain('<project>');
  });

  it('summary goes into dynamicPart', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'cli', chatId: 'test',
      tools: [{ name: 'exec', description: 'Run command' }],
      summary: 'Previous conversation about weather.',
    });
    expect(result.dynamicPart).toContain('<previous_summary>');
    expect(result.dynamicPart).toContain('weather');
    expect(result.staticPart).not.toContain('<previous_summary>');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/context-builder.test.ts`
Expected: FAIL — `build()` returns string, not `{ staticPart, dynamicPart }`.

- [ ] **Step 3: Implement ContextResult in context-builder.ts**

Change the return type and split the build method. Key changes:

1. Export `ContextResult` interface at top of file:
```typescript
export interface ContextResult {
  staticPart: string;
  dynamicPart: string;
}
```

2. Change `build()` return type from `Promise<string>` to `Promise<ContextResult>`.

3. Use two arrays: `staticParts` and `dynamicParts` instead of one `parts` array.

4. Move `localTimestamp()` out of `buildIdentity()` — identity becomes static (no time). Add time to `<session>` block in dynamic part.

5. Static parts: identity (without time), known users, chat files, EGO, AGENTS, HEARTBEAT, JANUS, skills.

6. Dynamic parts: user section, memory, learner, session info (with date AND time), previous summary.

Specifically in `buildIdentity()` (line 183-201): Remove lines 188-190 (nowTime, tz, clockLine) and the `${clockLine}` reference from the template string.

In the session block (line 131-141): Add time:
```typescript
const nowDate = localDateWithDay();
const nowTime = localTimestamp();
const tz = getTimezone();
const timeLine = tz ? `Time: ${nowTime} (${tz})` : `Time: ${nowTime}`;
const sessionParts = [`Date: ${nowDate}`, timeLine, `Channel: ${opts.channel}`, `Chat: ${opts.chatId}`];
```

Return:
```typescript
return {
  staticPart: staticParts.join('\n\n---\n\n'),
  dynamicPart: dynamicParts.join('\n\n---\n\n'),
};
```

- [ ] **Step 4: Update all callers of context.build()**

In `src/agent/agent-loop.ts` (around line 335), change:
```typescript
const { staticPart, dynamicPart } = await this.deps.context.build({ ... });
```

Update the system message in the messages array (line 378-379):
```typescript
const messages: LLMMessage[] = [
  { role: 'system', content: staticPart + '\n\n---\n\n' + dynamicPart },
  ...cleanHistory,
  userMessage,
];
```

Add `systemStaticPart` to the data passed to the iterate method (or store on `this`) so the Anthropic provider can split it. The simplest approach: add `systemParts` to `ChatRequest`:

In `src/llm/types.ts`, add to ChatRequest:
```typescript
export interface ChatRequest {
  // ... existing fields
  /** Static/dynamic system prompt parts for Anthropic cache optimization. */
  systemParts?: { staticPart: string; dynamicPart: string };
}
```

In agent-loop, pass systemParts in chatRequest:
```typescript
const chatRequest = {
  model: '',
  messages,
  tools: tools.length > 0 ? tools : undefined,
  // ... existing fields
  systemParts: { staticPart, dynamicPart },
};
```

- [ ] **Step 5: Update Anthropic provider for 3 system blocks**

In `src/llm/anthropic-provider.ts`, update both `chat()` (lines 120-138) and `chatStream()` (lines 244-262):

```typescript
// OAuth tokens require Claude Code identity in system prompt
const systemBlocks: Anthropic.TextBlockParam[] = [];
if (this.useOAuth) {
  systemBlocks.push({
    type: 'text' as const,
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' as const },
  });
}
if (request.systemParts) {
  // Static part — cached (stable across requests)
  systemBlocks.push({
    type: 'text' as const,
    text: request.systemParts.staticPart,
    cache_control: { type: 'ephemeral' as const },
  });
  // Dynamic part — NOT cached (changes per request)
  systemBlocks.push({
    type: 'text' as const,
    text: request.systemParts.dynamicPart,
  });
} else if (systemMsg) {
  // Fallback for non-split callers (flush, summarization)
  systemBlocks.push({
    type: 'text' as const,
    text: systemMsg.content,
    cache_control: { type: 'ephemeral' as const },
  });
}
```

- [ ] **Step 6: Update anthropic cache markers test**

In `tests/unit/anthropic-cache-markers.test.ts`, the existing tests should still pass (they test tool markers, not system blocks). No changes needed unless tests import ChatRequest — then add `systemParts` as optional.

- [ ] **Step 7: Update existing context-builder tests**

The existing tests in `tests/unit/context-builder.test.ts` call `builder.build()` and expect a string. Update them to destructure:

```typescript
// Before:
const prompt = await builder.build({ ... });
expect(prompt).toContain('<agents>');

// After:
const { staticPart, dynamicPart } = await builder.build({ ... });
const prompt = staticPart + '\n\n---\n\n' + dynamicPart;
expect(prompt).toContain('<agents>');
```

Update all existing test cases to use this pattern. The `minimal` mode tests should verify both parts.

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/context/context-builder.ts src/llm/anthropic-provider.ts src/llm/types.ts src/agent/agent-loop.ts tests/unit/context-builder.test.ts
git commit -m "feat: split system prompt static/dynamic for Anthropic cache hits

Static part (identity, EGO, AGENTS, HEARTBEAT, JANUS, skills) gets
cache_control: ephemeral. Dynamic part (session, memory, learner, summary)
sent uncached. Time moved from identity to session block.
Consecutive requests within 5-min TTL now hit cache (0.1x vs 1.25x cost)."
```

---

### Task 3: Consolidate Memory Flush 3→1

Remove idle timer and count-based triggers. Keep only token-aware flush.

**Files:**
- Modify: `src/agent/agent-loop.ts:444-478` (remove 2 triggers)
- Test: `tests/integration/agent-loop.test.ts` (if flush tests exist) or new unit test

- [ ] **Step 1: Write test verifying only token-aware flush fires**

Add `tests/unit/memory-flush-triggers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Memory flush consolidation', () => {
  it('agent-loop should not contain idle timer logic', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');
    // Idle timer should be removed
    expect(source).not.toContain('idleTimer');
    expect(source).not.toContain('memoryIdleFlushMs');
    // Count-based should be removed
    expect(source).not.toContain('lastFlushHash');
    expect(source).not.toContain('memoryFlushInterval');
    // Token-aware should remain
    expect(source).toContain('tokenFlushThreshold');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/memory-flush-triggers.test.ts`
Expected: FAIL — source still contains `idleTimer`, `memoryIdleFlushMs`, etc.

- [ ] **Step 3: Remove idle timer and count-based flush from agent-loop.ts**

Delete the idle timer block (lines 444-454):
```typescript
// DELETE: Reset idle flush timer
// if (state.idleTimer) clearTimeout(state.idleTimer);
// if (this.deps.memory) { ... setTimeout ... }
```

Delete the count-based flush block (lines 456-468):
```typescript
// DELETE: Count-based flush trigger
// const flushInterval = this.deps.config.agent.memoryFlushInterval;
// const unflushed = fullSession.messages.length - state.lastFlushed;
// if (this.deps.memory && !state.flushing && unflushed >= flushInterval) { ... }
```

Remove `idleTimer` and `lastFlushHash` from flush state type (wherever it's defined in the class).

Change the token-aware threshold from `0.5` to `0.4` (line 473):
```typescript
const tokenFlushThreshold = this.deps.config.agent.tokenBudget * 0.4;
```

Keep the `unflushed` variable computation (needed for token-aware check) — move it up before the token-aware block if needed.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests pass. If any tests relied on idle flush or count flush behavior, update them.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts tests/unit/memory-flush-triggers.test.ts
git commit -m "fix: consolidate memory flush from 3 triggers to 1

Remove idle timer (120s) and count-based (every 5 msgs) flush triggers.
Keep only token-aware flush at 40% budget threshold.
Eliminates 2-3 redundant LLM calls per conversation."
```

---

### Task 4: Remove Summarization Quality Retry

Delete the scheduling keyword heuristic that triggers a second summarization LLM call.

**Files:**
- Modify: `src/agent/agent-loop.ts:1285-1303`
- Test: `tests/unit/summarization-retry.test.ts`

- [ ] **Step 1: Write test verifying quality retry is removed**

Add `tests/unit/summarization-retry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('Summarization quality retry removal', () => {
  it('agent-loop should not contain scheduling quality retry heuristic', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');
    expect(source).not.toContain('hasScheduling');
    expect(source).not.toContain('hasCriticalContext');
    expect(source).not.toContain('quality check');
    expect(source).not.toContain('Summarization quality');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/summarization-retry.test.ts`
Expected: FAIL — source still contains the quality retry block.

- [ ] **Step 3: Delete the quality retry block**

In `src/agent/agent-loop.ts`, delete lines 1285-1303 (the entire `hasScheduling` check and retry LLM call):

```typescript
// DELETE everything from:
//   const hasScheduling = /\b(cron|calendar|schedule|...
// to:
//   }  (closing brace of the if block)
```

This leaves `let summary = summaryResponse.content;` followed directly by the session truncation logic.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts tests/unit/summarization-retry.test.ts
git commit -m "fix: remove summarization quality retry

The scheduling keyword heuristic was too broad and triggered
unnecessary second LLM calls on any conversation mentioning times."
```

---

### Task 5: Background Context Mode for Cron/Heartbeat

Add `'background'` context mode that skips memory, learner, HEARTBEAT, JANUS — but keeps EGO and AGENTS for agent personality.

**Files:**
- Modify: `src/bus/types.ts:17` (add 'background' to union)
- Modify: `src/context/context-builder.ts` (gate sections by background mode)
- Modify: `src/services/cron-service.ts:465-476` (set contextMode)
- Test: `tests/unit/context-builder.test.ts` (add background mode tests)

- [ ] **Step 1: Write failing tests for background mode**

Add to `tests/unit/context-builder.test.ts`:

```typescript
describe('ContextBuilder background mode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    writeFileSync(join(tempDir, '.janus', 'EGO.md'), '# Ego\nI am Janus.');
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Agent Rules\nBe helpful.');
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), '# Tasks\n- every 5m: ping');
    writeFileSync(join(tempDir, 'JANUS.md'), '# Project\nTest project.');
  });

  it('background mode keeps identity, EGO, AGENTS, skills', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'system', chatId: 'cron:1',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'background',
    });
    const prompt = result.staticPart + '\n\n---\n\n' + result.dynamicPart;
    expect(prompt).toContain('<identity>');
    expect(prompt).toContain('<ego>');
    expect(prompt).toContain('<agents>');
  });

  it('background mode skips HEARTBEAT, JANUS, memory, learner', async () => {
    const { builder } = createBuilder(tempDir);
    const result = await builder.build({
      channel: 'system', chatId: 'cron:1',
      tools: [{ name: 'exec', description: 'Run command' }],
      mode: 'background',
      userMessage: 'remind about meeting',
    });
    const prompt = result.staticPart + '\n\n---\n\n' + result.dynamicPart;
    expect(prompt).not.toContain('<heartbeat>');
    expect(prompt).not.toContain('<project>');
    expect(prompt).not.toContain('<memory>');
    expect(prompt).not.toContain('<learner>');
  });

  it('background mode produces shorter prompt than full mode', async () => {
    const { builder } = createBuilder(tempDir);
    const opts = {
      channel: 'system', chatId: 'cron:1',
      tools: [{ name: 'exec', description: 'Run command' }],
    };
    const full = await builder.build({ ...opts, mode: 'full' });
    const bg = await builder.build({ ...opts, mode: 'background' });
    const fullLen = full.staticPart.length + full.dynamicPart.length;
    const bgLen = bg.staticPart.length + bg.dynamicPart.length;
    expect(bgLen).toBeLessThan(fullLen);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/unit/context-builder.test.ts`
Expected: FAIL — `'background'` mode not recognized.

- [ ] **Step 3: Add 'background' to contextMode type**

In `src/bus/types.ts` line 17, change:
```typescript
contextMode?: 'full' | 'minimal' | 'background';
```

In `src/agent/agent-loop.ts` line 120, update the same type:
```typescript
contextMode?: 'full' | 'minimal' | 'background';
```

- [ ] **Step 4: Implement background mode in context-builder.ts**

In the `build()` method, after `const minimal = opts.mode === 'minimal';` add:
```typescript
const background = opts.mode === 'background';
```

Change the section guards:
- EGO (line 90): `if (!minimal)` stays — background still loads EGO
- AGENTS (line 97): `if (!minimal)` stays — background still loads AGENTS
- HEARTBEAT (line 103): Change to `if (!minimal && !background)`
- JANUS (line 109): Change to `if (!minimal && !background)`
- Memory (line 118): Change to `if (!minimal && !background)`
- Learner (line 124): Change to `if (!minimal && !background)`

- [ ] **Step 5: Set contextMode on cron job execution**

In `src/services/cron-service.ts`, in `executeJob()` at line 465, add `contextMode`:

```typescript
await this.bus.publishInbound({
  id: `cron-${job.id}-${Date.now()}`,
  channel: 'system',
  chatId,
  content: `[Cron job: ${job.name}] (id: ${job.id}) (${localTimestamp()})\n\n${job.task}`,
  author: 'system',
  timestamp: startedAt,
  cronDepth: 1,
  contextMode: 'background',
  lane: job.name.startsWith('heartbeat:') ? 'heartbeat' : 'cron',
  user: job.userId ? { userId: job.userId } : undefined,
  agentId: job.agentId ?? undefined,
});
```

- [ ] **Step 6: Run all tests**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/bus/types.ts src/context/context-builder.ts src/services/cron-service.ts src/agent/agent-loop.ts tests/unit/context-builder.test.ts
git commit -m "feat: background context mode for cron/heartbeat jobs

New 'background' mode skips HEARTBEAT, JANUS, memory search, and learner
but keeps EGO and AGENTS for agent personality. Cron/heartbeat jobs now
use this mode, saving ~10-20K tokens per job execution."
```

---

### Task 6: Final Verification & PR

Run full test suite, typecheck, and create PR.

**Files:**
- No new code changes

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All 563+ tests pass (plus new tests from tasks 1-5).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 3: Verify token-debug output manually**

Run: `npm start -- -m "hello" --token-debug`
Expected: See `[TOKEN]` line in output with token breakdown.

- [ ] **Step 4: Create PR**

```bash
gh pr create --title "feat: token waste overhaul — cache fix, flush consolidation, debug flag" --body "$(cat <<'EOF'
## Summary

- **Split system prompt static/dynamic** for Anthropic cache hits (~12x cost reduction on system prompt)
- **Consolidate memory flush** from 3 triggers to 1 (token-aware only, at 40% budget)
- **Remove summarization quality retry** (eliminated wasteful second LLM call)
- **Background context mode** for cron/heartbeat (skips memory/learner/HEARTBEAT/JANUS)
- **--token-debug flag** for per-request token breakdown on stdout with CACHE MISS warnings

Addresses excessive token consumption that was draining subscription with light usage.

## Test plan

- [ ] All existing tests pass (563+)
- [ ] New tests for: token debug logger, context split, flush consolidation, quality retry removal, background mode
- [ ] Typecheck passes
- [ ] Manual test: `janus gateway --token-debug` shows [TOKEN] lines
- [ ] Manual test: cache_read > 0 on consecutive requests (confirms cache fix works)
- [ ] Manual test: cron jobs show smaller token counts than before
EOF
)"
```

- [ ] **Step 5: Verify CI passes**

Check: `gh pr checks` — wait for CI to pass.
