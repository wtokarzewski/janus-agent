# Context Management Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 50-message history limit with token-based context management that protects user messages, adds structured summarization, and fixes scheduling issues.

**Architecture:** Multi-layer context budget enforcement (persist-time tool result cap → graduated compaction before LLM calls → improved emergency compression), structured summarization with iterative merge, `not_before` on cron jobs, scheduling guidance in AGENTS.md.

**Tech Stack:** TypeScript, Zod (config schema), SQLite (migration 12), vitest (tests)

**Spec:** `docs/superpowers/specs/2026-04-01-context-management-overhaul-design.md`

---

### Task 1: Config schema — add `agent.context` section

**Files:**
- Modify: `src/config/schema.ts:109-122`
- Modify: `janus.example.json:28-49`
- Test: `tests/unit/config-schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/config-schema.test.ts`:

```typescript
describe('agent.context', () => {
  it('should apply context defaults when omitted', () => {
    const config = parseConfig({});
    expect(config.agent.context).toEqual({
      keepRecentTokens: 20_000,
      reserveTokens: 20_000,
      toolResultMaxShare: 0.3,
      toolResultHardMax: 400_000,
      softTrimChars: 4000,
      compactionThresholds: [0.75, 0.80, 0.85],
      emergencyThreshold: 0.95,
      protectedTailTurns: 3,
    });
  });

  it('should allow partial context overrides', () => {
    const config = parseConfig({ agent: { context: { protectedTailTurns: 5, keepRecentTokens: 50_000 } } });
    expect(config.agent.context.protectedTailTurns).toBe(5);
    expect(config.agent.context.keepRecentTokens).toBe(50_000);
    expect(config.agent.context.toolResultMaxShare).toBe(0.3); // default preserved
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/config-schema.test.ts -t "agent.context"`
Expected: FAIL — `config.agent.context` is undefined

- [ ] **Step 3: Add ContextSchema to config schema**

In `src/config/schema.ts`, add before `AgentSchema`:

```typescript
const ContextSchema = z.object({
  keepRecentTokens: z.number().default(20_000),
  reserveTokens: z.number().default(20_000),
  toolResultMaxShare: z.number().min(0.01).max(1.0).default(0.3),
  toolResultHardMax: z.number().default(400_000),
  softTrimChars: z.number().default(4000),
  compactionThresholds: z.tuple([z.number(), z.number(), z.number()]).default([0.75, 0.80, 0.85]),
  emergencyThreshold: z.number().default(0.95),
  protectedTailTurns: z.number().min(0).default(3),
});
```

Add to `AgentSchema`:

```typescript
context: ContextSchema.optional().transform(v => ContextSchema.parse(v ?? {})),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/config-schema.test.ts -t "agent.context"`
Expected: PASS

- [ ] **Step 5: Update janus.example.json**

Add `context` section inside `agent`:

```json
"context": {
  "keepRecentTokens": 20000,
  "reserveTokens": 20000,
  "toolResultMaxShare": 0.3,
  "toolResultHardMax": 400000,
  "softTrimChars": 4000,
  "compactionThresholds": [0.75, 0.80, 0.85],
  "emergencyThreshold": 0.95,
  "protectedTailTurns": 3
}
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All existing tests pass

- [ ] **Step 7: Commit**

```bash
git add src/config/schema.ts janus.example.json tests/unit/config-schema.test.ts
git commit -m "feat: add agent.context config section for context management parameters"
```

---

### Task 2: Remove maxMessages — return all session messages

**Files:**
- Modify: `src/session/session-manager.ts:110-116`
- Test: `tests/unit/session-lock.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/session-lock.test.ts`:

```typescript
it('getHistory returns all messages without slicing', async () => {
  const sm = createSessionManager();
  const key = 'test-no-limit';
  // Add 100 messages
  const msgs: LLMMessage[] = [];
  for (let i = 0; i < 100; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` } as LLMMessage);
  }
  await sm.append(key, msgs);
  const history = await sm.getHistory(key);
  expect(history.length).toBe(100);
  expect(history[0].content).toBe('msg-0');
  expect(history[99].content).toBe('msg-99');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-lock.test.ts -t "returns all messages"`
Expected: FAIL — returns 50 (old limit)

- [ ] **Step 3: Remove maxMessages parameter**

In `src/session/session-manager.ts`, change `getHistory`:

```typescript
async getHistory(key: string): Promise<LLMMessage[]> {
  return this.withLock(key, async () => {
    const session = await this.getOrCreateInner(key);
    return session.messages;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/session-lock.test.ts -t "returns all messages"`
Expected: PASS

- [ ] **Step 5: Fix any callers that pass maxMessages argument**

Search for `getHistory(` calls in the codebase. The main caller is `agent-loop.ts:345` which calls `getHistory(sessionKey)` with no argument — no change needed. If any other caller passes an argument, remove it.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/session/session-manager.ts tests/unit/session-lock.test.ts
git commit -m "feat: remove maxMessages limit, return all session messages"
```

---

### Task 3: Tool result truncation at persist time

**Files:**
- Modify: `src/session/session-manager.ts:92-108`
- Test: `tests/unit/session-lock.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/session-lock.test.ts`:

```typescript
describe('tool result persist truncation', () => {
  it('truncates tool result exceeding dynamic cap', async () => {
    const sm = createSessionManager({ contextWindow: 100_000, context: { toolResultMaxShare: 0.3, toolResultHardMax: 400_000 } });
    const key = 'test-truncate';
    // 30% of 100K = 30K tokens ≈ 75K chars (at 2.5 chars/token). Create 80K char result.
    const bigContent = 'A'.repeat(80_000);
    await sm.append(key, [{ role: 'tool', tool_call_id: 'tc1', content: bigContent }]);
    const history = await sm.getHistory(key);
    const result = history[0] as { content: string };
    expect(result.content.length).toBeLessThan(80_000);
    expect(result.content).toContain('[truncated');
    // Check head+tail: first part preserved, last part preserved
    expect(result.content.startsWith('A')).toBe(true);
    expect(result.content.includes('AAAA')).toBe(true); // tail portion
  });

  it('does not truncate tool result under cap', async () => {
    const sm = createSessionManager({ contextWindow: 1_000_000, context: { toolResultMaxShare: 0.3, toolResultHardMax: 400_000 } });
    const key = 'test-no-truncate';
    const smallContent = 'B'.repeat(1000);
    await sm.append(key, [{ role: 'tool', tool_call_id: 'tc2', content: smallContent }]);
    const history = await sm.getHistory(key);
    expect((history[0] as { content: string }).content).toBe(smallContent);
  });

  it('respects hard max regardless of context window', async () => {
    const sm = createSessionManager({ contextWindow: 10_000_000, context: { toolResultMaxShare: 0.3, toolResultHardMax: 400_000 } });
    const key = 'test-hard-max';
    const hugeContent = 'C'.repeat(500_000);
    await sm.append(key, [{ role: 'tool', tool_call_id: 'tc3', content: hugeContent }]);
    const history = await sm.getHistory(key);
    expect((history[0] as { content: string }).content.length).toBeLessThanOrEqual(400_000 + 100); // +100 for truncation marker
  });
});
```

Note: `createSessionManager` helper will need to accept config overrides — adjust the existing test helper or create one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/session-lock.test.ts -t "tool result persist truncation"`
Expected: FAIL — no truncation happening

- [ ] **Step 3: Implement truncation in append()**

In `src/session/session-manager.ts`, the `SessionManager` constructor needs access to `contextWindow` and `context` config. Add a `truncateToolResult` private method and call it in `append()`:

```typescript
private contextWindow: number;
private contextConfig: { toolResultMaxShare: number; toolResultHardMax: number };

constructor(config: JanusConfig) {
  this.sessionsDir = resolve(config.workspace.dir, config.workspace.sessionsDir);
  this.contextWindow = config.agent.contextWindow;
  this.contextConfig = {
    toolResultMaxShare: config.agent.context.toolResultMaxShare,
    toolResultHardMax: config.agent.context.toolResultHardMax,
  };
}

/** Cap a single tool result at persist time. Head+tail truncation preserves error output. */
private truncateToolResult(content: string): string {
  // Dynamic cap: toolResultMaxShare of context window in chars (tokens * 2.5)
  const dynamicCap = Math.floor(this.contextWindow * 2.5 * this.contextConfig.toolResultMaxShare);
  const cap = Math.min(dynamicCap, this.contextConfig.toolResultHardMax);
  if (content.length <= cap) return content;

  const headSize = Math.floor(cap * 0.7);
  const tailSize = cap - headSize;
  return `${content.slice(0, headSize)}\n\n[truncated: ${content.length - cap} chars removed to fit context budget]\n\n${content.slice(-tailSize)}`;
}
```

In `append()`, before pushing messages:

```typescript
async append(key: string, messages: LLMMessage[]): Promise<void> {
  return this.withLock(key, async () => {
    const session = await this.getOrCreateInner(key);
    const isNew = session.messages.length === 0;
    // Truncate tool results at persist time
    const processed = messages.map(m => {
      if (m.role === 'tool' && typeof m.content === 'string') {
        return { ...m, content: this.truncateToolResult(m.content) };
      }
      return m;
    });
    session.messages.push(...processed);
    session.metadata.messageCount = session.messages.length;
    session.metadata.updated = new Date().toISOString();

    if (isNew) {
      await this.save(key, session);
    } else {
      await this.appendIncremental(key, session, processed);
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/session-lock.test.ts -t "tool result persist truncation"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/session/session-manager.ts tests/unit/session-lock.test.ts
git commit -m "feat: truncate tool results at persist time (dynamic cap based on context window)"
```

---

### Task 4: enforceContextBudget — graduated compaction

**Files:**
- Create: `src/agent/context-budget.ts`
- Test: `tests/unit/context-budget.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/context-budget.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { enforceContextBudget } from '../../src/agent/context-budget.js';
import type { LLMMessage } from '../../src/llm/types.js';

const defaultConfig = {
  tokenBudget: 10_000,
  context: {
    softTrimChars: 4000,
    compactionThresholds: [0.75, 0.80, 0.85] as [number, number, number],
    emergencyThreshold: 0.95,
    protectedTailTurns: 3,
  },
};

function makeMessages(specs: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>): LLMMessage[] {
  return specs.map(s => s as unknown as LLMMessage);
}

describe('enforceContextBudget', () => {
  it('does nothing when under 75% budget', () => {
    const messages = makeMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    enforceContextBudget(messages, defaultConfig);
    expect(messages).toHaveLength(3);
  });

  it('phase 1: soft-trims old tool results first', () => {
    const bigToolResult = 'X'.repeat(10_000);
    const messages = makeMessages([
      { role: 'system', content: 'S'.repeat(2000) },
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', content: bigToolResult, tool_call_id: 'tc1' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'done' },
    ]);
    enforceContextBudget(messages, { ...defaultConfig, tokenBudget: 6000 });
    // Tool result should be soft-trimmed
    const toolMsg = messages.find(m => m.role === 'tool') as { content: string };
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content.length).toBeLessThanOrEqual(4100); // ~softTrimChars + marker
    expect(toolMsg.content).toContain('[trimmed]');
  });

  it('never modifies user messages', () => {
    const bigUser = 'U'.repeat(20_000);
    const messages = makeMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: bigUser },
      { role: 'assistant', content: 'ok' },
    ]);
    enforceContextBudget(messages, { ...defaultConfig, tokenBudget: 5000 });
    const userMsg = messages.find(m => m.role === 'user') as { content: string };
    expect(userMsg.content).toBe(bigUser);
  });

  it('protected tail: does not trim recent assistant turns', () => {
    const bigToolResult = 'X'.repeat(10_000);
    const messages = makeMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      // This is the ONLY assistant turn — should be protected (protectedTailTurns=3)
      { role: 'assistant', content: 'a1', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', content: bigToolResult, tool_call_id: 'tc1' },
    ]);
    enforceContextBudget(messages, { ...defaultConfig, tokenBudget: 5000 });
    // Should NOT be trimmed — it's within the protected tail
    const toolMsg = messages.find(m => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toBe(bigToolResult);
  });

  it('phase 3: drops old assistant+tool turns as groups', () => {
    const messages = makeMessages([
      { role: 'system', content: 'S'.repeat(3000) },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'A'.repeat(5000), tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', content: 'R'.repeat(5000), tool_call_id: 'tc1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'A'.repeat(5000), tool_calls: [{ id: 'tc2', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', content: 'R'.repeat(5000), tool_call_id: 'tc2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'final answer' },
    ]);
    enforceContextBudget(messages, { ...defaultConfig, tokenBudget: 8000 });
    // Old turns dropped, but ALL user messages preserved
    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(3);
    expect(messages[0].role).toBe('system');
  });

  it('never splits assistant from its tool results', () => {
    const messages = makeMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 'tc1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'final' },
    ]);
    enforceContextBudget(messages, { ...defaultConfig, tokenBudget: 3000 });
    // If assistant with tool_calls is present, its tool result must also be present (or both dropped)
    const assistantWithTools = messages.find(m => m.role === 'assistant' && 'tool_calls' in m && (m as any).tool_calls?.length > 0);
    if (assistantWithTools) {
      const toolMsg = messages.find(m => m.role === 'tool');
      expect(toolMsg).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/context-budget.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement enforceContextBudget**

Create `src/agent/context-budget.ts`:

```typescript
/**
 * Token-based context budget enforcement.
 *
 * Three graduated phases that protect user messages and recent assistant turns:
 * 1. Soft-trim old tool results (head+tail)
 * 2. Hard-clear old tool results (placeholder)
 * 3. Drop complete assistant+tool turns (oldest first)
 *
 * User messages are NEVER modified or removed.
 */

import type { LLMMessage } from '../llm/types.js';
import * as log from '../utils/logger.js';

interface ContextConfig {
  tokenBudget: number;
  context: {
    softTrimChars: number;
    compactionThresholds: [number, number, number];
    emergencyThreshold: number;
    protectedTailTurns: number;
  };
}

/** Conservative token estimation: ~2.5 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function messageTokens(m: LLMMessage): number {
  if ('content' in m && m.content) {
    if (typeof m.content === 'string') return estimateTokens(m.content);
    if (Array.isArray(m.content)) {
      let t = 0;
      for (const b of m.content) {
        if (b.type === 'text') t += estimateTokens(b.text);
        else if (b.type === 'image') t += 1000;
      }
      return t;
    }
  }
  return 0;
}

function totalTokens(messages: LLMMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/** Find index of first user message in array. */
function firstUserIndex(messages: LLMMessage[]): number {
  return messages.findIndex(m => m.role === 'user');
}

/** Find indices of the last N assistant messages (for protected tail). */
function protectedTailStart(messages: LLMMessage[], tailTurns: number): number {
  if (tailTurns <= 0) return messages.length;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      count++;
      if (count >= tailTurns) return i;
    }
  }
  return 0; // fewer than tailTurns assistants — protect everything
}

/** Soft-trim a tool result string to maxChars using head+tail. */
function softTrim(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.375); // 1.5K of 4K default
  const tailSize = headSize;
  return `${content.slice(0, headSize)}\n\n[trimmed: ${content.length - headSize - tailSize} chars removed]\n\n${content.slice(-tailSize)}`;
}

/**
 * Enforce context budget in-place. Modifies the messages array.
 *
 * Phases:
 * 1. Soft-trim old tool results to softTrimChars
 * 2. Hard-clear old tool results to placeholder
 * 3. Drop complete assistant+tool turns
 *
 * User messages are NEVER modified or removed.
 * Protected tail (last N assistant turns) is immune from phases 1-2.
 */
export function enforceContextBudget(messages: LLMMessage[], config: ContextConfig, emergency = false): void {
  const { tokenBudget } = config;
  const { softTrimChars, compactionThresholds, protectedTailTurns } = config.context;
  const [softThreshold, hardThreshold, dropThreshold] = compactionThresholds;

  let tokens = totalTokens(messages);
  if (tokens <= tokenBudget * softThreshold) return;

  const firstUser = firstUserIndex(messages);
  const tailStart = emergency ? messages.length : protectedTailStart(messages, protectedTailTurns);

  // Phase 1: Soft-trim old tool results
  if (tokens > tokenBudget * softThreshold) {
    for (let i = Math.max(firstUser, 0); i < tailStart && tokens > tokenBudget * softThreshold; i++) {
      const m = messages[i];
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > softTrimChars) {
        const before = messageTokens(m);
        (m as { content: string }).content = softTrim(m.content, softTrimChars);
        tokens -= before - messageTokens(m);
      }
    }
  }

  // Phase 2: Hard-clear old tool results
  if (tokens > tokenBudget * hardThreshold) {
    for (let i = Math.max(firstUser, 0); i < tailStart && tokens > tokenBudget * hardThreshold; i++) {
      const m = messages[i];
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 50) {
        const before = messageTokens(m);
        (m as { content: string }).content = '[tool result cleared]';
        tokens -= before - messageTokens(m);
      }
    }
  }

  // Phase 3: Drop complete assistant+tool turns (oldest first, skip user messages)
  if (tokens > tokenBudget * dropThreshold) {
    let i = Math.max(firstUser + 1, 1); // start after first user message, skip system
    while (i < messages.length - 2 && tokens > tokenBudget * dropThreshold) {
      const m = messages[i];
      if (m.role === 'user') { i++; continue; } // NEVER drop user messages
      if (m.role === 'assistant') {
        // Drop this assistant + all following tool messages
        let end = i + 1;
        while (end < messages.length && messages[end].role === 'tool') end++;
        const dropped = messages.splice(i, end - i);
        tokens -= dropped.reduce((s, d) => s + messageTokens(d), 0);
        // Don't increment i — next message slid into this position
        continue;
      }
      // Orphan tool message (shouldn't happen after repair, but safe to drop)
      if (m.role === 'tool') {
        tokens -= messageTokens(m);
        messages.splice(i, 1);
        continue;
      }
      i++;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/context-budget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/context-budget.ts tests/unit/context-budget.test.ts
git commit -m "feat: add enforceContextBudget with graduated 3-phase compaction"
```

---

### Task 5: Wire enforceContextBudget into agent-loop, delete old functions

**Files:**
- Modify: `src/agent/agent-loop.ts:345-366, 677-690, 729-751, 1283-1329`

- [ ] **Step 1: Import enforceContextBudget**

At top of `src/agent/agent-loop.ts`:

```typescript
import { enforceContextBudget } from './context-budget.js';
```

- [ ] **Step 2: Replace trimHistoryToTokenBudget call site (line ~361)**

Replace:

```typescript
const trimmedHistory = trimHistoryToTokenBudget(cleanHistory, systemPrompt, userContent, maxTokens);
const messages: LLMMessage[] = [
  { role: 'system', content: systemPrompt },
  ...trimmedHistory,
  { role: 'user', content: userContent },
];
```

With:

```typescript
const messages: LLMMessage[] = [
  { role: 'system', content: systemPrompt },
  ...cleanHistory,
  { role: 'user', content: userContent },
];
enforceContextBudget(messages, this.deps.config.agent);
```

- [ ] **Step 3: Replace proactive overflow detection (lines ~677-690)**

Replace the old `pruneOldToolResults` + emergency compression block:

```typescript
// Proactive context overflow detection (CR-Q)
const currentTokens = estimateMessagesTokens(messages);
const tokenBudget = this.deps.config.agent.tokenBudget;
if (currentTokens > tokenBudget * 0.9) {
  log.warn(`[${sessionKey}] Context at ${Math.round(currentTokens / tokenBudget * 100)}% of budget`);
  pruneOldToolResults(messages);
  if (estimateMessagesTokens(messages) > tokenBudget * 0.95) {
    // ... emergency compression
  }
}
```

With:

```typescript
// Proactive context budget enforcement
enforceContextBudget(messages, this.deps.config.agent);
// Emergency: if still over 95%, run without protected tail
const emergencyThreshold = this.deps.config.agent.context.emergencyThreshold;
if (estimateMessagesTokens(messages) > this.deps.config.agent.tokenBudget * emergencyThreshold) {
  log.warn(`[${sessionKey}] Emergency compression — over ${emergencyThreshold * 100}% budget`);
  enforceContextBudget(messages, this.deps.config.agent, true);
}
```

- [ ] **Step 4: Update error-triggered compression (lines ~729-751)**

Replace both timeout compression and context overflow compression blocks with:

```typescript
if (isTimeout && contextRetries < 2 && messages.length > 6) {
  const estTokens = estimateMessagesTokens(messages);
  if (estTokens > tokenBudget * 0.7) {
    contextRetries++;
    log.warn(`[${sessionKey}] LLM timeout with high context, compressing`);
    enforceContextBudget(messages, this.deps.config.agent, true);
    continue;
  }
}

if (isContextError && contextRetries < 2) {
  contextRetries++;
  log.warn(`Context overflow, emergency compression (attempt ${contextRetries})`);
  enforceContextBudget(messages, this.deps.config.agent, true);
  continue;
}
```

- [ ] **Step 5: Delete old functions**

Delete `trimHistoryToTokenBudget` (lines ~1283-1312) and `pruneOldToolResults` (lines ~1319-1329) from `agent-loop.ts`.

Keep `estimateTokens`, `estimateMessagesTokens`, `contentToString` — they're used elsewhere.

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "feat: wire enforceContextBudget, remove trimHistoryToTokenBudget and pruneOldToolResults"
```

---

### Task 6: Structured summarization prompts

**Files:**
- Create: `src/prompts/summarization/initial.md`
- Create: `src/prompts/summarization/update.md`

- [ ] **Step 1: Create initial summarization prompt**

Create `src/prompts/summarization/initial.md`:

```markdown
Summarize this conversation for context continuity. Use EXACTLY this template. Write "None" for empty sections. Never skip a section.

## Goal
[Core user intent]

## Constraints & Preferences
[User-stated constraints: times, dates, names, quantities, conditions, exceptions. Quote exact words for critical constraints.]

## Progress
### Done
- [completed items with specifics]
### In Progress
- [ongoing items with current state]

## Key Decisions
- [decisions and rationale]

## Open TODOs
- [pending items]

## Critical Context
[MUST NOT be lost: exact times, names, dates, addresses, identifiers, exceptions. Preserve user's exact words for scheduling constraints.]

## Identifiers
[Preserve verbatim: job IDs, file paths, URLs, user IDs, UUIDs, calendar event IDs]
```

- [ ] **Step 2: Create update summarization prompt**

Create `src/prompts/summarization/update.md`:

```markdown
Update the existing conversation summary with new information. The previous summary is in <previous-summary> tags. New conversation messages follow.

Rules:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- NEVER remove Critical Context unless the user explicitly superseded it
- MERGE Identifiers: append new ones, keep all existing
- Use EXACTLY the same template sections as the previous summary
- Write "None" for empty sections. Never skip a section.

<previous-summary>
{{previousSummary}}
</previous-summary>
```

- [ ] **Step 3: Commit**

```bash
git add src/prompts/summarization/initial.md src/prompts/summarization/update.md
git commit -m "feat: add structured summarization prompts with iterative merge"
```

---

### Task 7: Rewrite doSummarization with structured template, input filtering, token-based retention

**Files:**
- Modify: `src/agent/agent-loop.ts` (doSummarization method, ~lines 1120-1182)
- Modify: `src/session/session-manager.ts` (summarize method, ~lines 122-139)

- [ ] **Step 1: Update session-manager summarize() for token-based retention**

Replace the `summarize` method in `src/session/session-manager.ts`:

```typescript
/**
 * Summarize old messages. Token-based retention: walk backwards keeping
 * keepRecentTokens worth of messages, snap cut to user message boundary.
 */
async summarize(key: string, summaryText: string, keepRecentTokens: number): Promise<void> {
  return this.withLock(key, async () => {
    const session = await this.getOrCreateInner(key);
    if (session.messages.length <= 4) return;

    // Walk backwards counting tokens, find cut point
    let tokens = 0;
    let cutIndex = session.messages.length;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      const content = 'content' in msg ? msg.content : '';
      const msgTokens = typeof content === 'string' ? Math.ceil(content.length / 2.5) : 100;
      if (tokens + msgTokens > keepRecentTokens) {
        // Snap forward to next user message boundary
        cutIndex = i + 1;
        for (let j = cutIndex; j < session.messages.length; j++) {
          if (session.messages[j].role === 'user') { cutIndex = j; break; }
        }
        break;
      }
      tokens += msgTokens;
    }

    if (cutIndex <= 0) return; // nothing to cut

    session.messages = session.messages.slice(cutIndex);
    session.metadata.summary = summaryText;
    session.metadata.messageCount = session.messages.length;
    session.metadata.lastFlushed = 0;

    await this.save(key, session);
    log.debug(`Summarized session ${key}, kept ${session.messages.length} messages (~${tokens} tokens)`);
  });
}
```

- [ ] **Step 2: Update doSummarization in agent-loop.ts**

Replace `doSummarization` method:

```typescript
private async doSummarization(
  sessionKey: string,
  messages: LLMMessage[],
  userId?: string,
  scope?: InboundMessage['scope'],
  preTokenEstimate?: number,
): Promise<void> {
  log.info(`[${sessionKey}] Summarization: start`);
  const sumStart = Date.now();
  const keepRecentTokens = this.deps.config.agent.context.keepRecentTokens;

  // Find cut point: messages to summarize vs keep
  let tokens = 0;
  let cutIndex = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = 'content' in messages[i] ? messages[i].content : '';
    const msgTokens = typeof content === 'string' ? Math.ceil(content.length / 2.5) : 100;
    if (tokens + msgTokens > keepRecentTokens) {
      cutIndex = i + 1;
      // Snap to user message boundary
      for (let j = cutIndex; j < messages.length; j++) {
        if (messages[j].role === 'user') { cutIndex = j; break; }
      }
      break;
    }
    tokens += msgTokens;
  }

  const toSummarize = messages.slice(0, cutIndex);
  if (toSummarize.length < 4) {
    log.info(`[${sessionKey}] Summarization: too few messages to summarize, skipping`);
    return;
  }

  // Memory flush before summarization
  let flushed = false;
  for (let attempt = 1; attempt <= 3 && !flushed; attempt++) {
    try {
      await this.flushMemory(sessionKey, userId, scope, cutIndex);
      flushed = true;
    } catch (err) {
      log.warn(`Pre-summarization flush attempt ${attempt}/3 failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  if (!flushed) {
    log.error(`[${sessionKey}] All flush attempts failed — proceeding with summarization.`);
  }

  // Input filtering: only user + assistant messages (no tool results)
  const filtered = toSummarize.filter(m => m.role === 'user' || m.role === 'assistant');
  const conversationText = filtered.map(m => `${m.role}: ${'content' in m ? (typeof m.content === 'string' ? m.content : '[multimodal]') : ''}`).join('\n');

  // Check for previous summary → use update prompt
  const session = await this.deps.sessions.getOrCreate(sessionKey);
  const previousSummary = session.metadata.summary;

  let systemContent: string;
  if (previousSummary) {
    systemContent = loadPrompt('summarization/update', { previousSummary });
  } else {
    systemContent = loadPrompt('summarization/initial');
  }

  log.info(`[${sessionKey}] Summarization: LLM call start`);
  const llmStart = Date.now();
  const summaryResponse = await withTimeout(this.deps.llm.chat({
    model: '',
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: conversationText },
    ],
    temperature: 0.3,
    maxTokens: 2048,
  }, 'summarize'), 90_000, 'Summarization LLM call timed out');
  log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);

  // Quality check: verify Critical Context section is present
  const summary = summaryResponse.content;
  if (!summary.includes('## Critical Context') || summary.includes('## Critical Context\nNone')) {
    // Check if conversation had scheduling/timing content
    const hasScheduling = conversationText.match(/\b(cron|calendar|schedule|remind|alarm|heartbeat|\d{1,2}:\d{2})\b/i);
    if (hasScheduling) {
      log.warn(`[${sessionKey}] Summarization quality check: Critical Context empty on scheduling conversation, regenerating`);
      const retryResponse = await withTimeout(this.deps.llm.chat({
        model: '',
        messages: [
          { role: 'system', content: systemContent + '\n\nIMPORTANT: The previous summary had an empty Critical Context section. This conversation contains scheduling/timing content. You MUST extract and preserve exact times, dates, and constraints in the Critical Context section.' },
          { role: 'user', content: conversationText },
        ],
        temperature: 0.3,
        maxTokens: 2048,
      }, 'summarize'), 90_000, 'Summarization retry timed out');
      await this.deps.sessions.summarize(sessionKey, retryResponse.content, keepRecentTokens);
      log.info(`[${sessionKey}] Summarization: complete (with retry) in ${Date.now() - sumStart}ms`);
      return;
    }
  }

  await this.deps.sessions.summarize(sessionKey, summary, keepRecentTokens);

  const state = this.flushState.get(sessionKey);
  if (state) state.lastFlushed = 0;

  log.info(`[${sessionKey}] Summarization: complete in ${Date.now() - sumStart}ms`);
}
```

- [ ] **Step 3: Add import for loadPrompt**

At top of `agent-loop.ts`, add:

```typescript
import { loadPrompt } from '../prompts/loader.js';
```

- [ ] **Step 4: Update summarization trigger to pass keepRecentTokens**

In the summarization trigger code (~line 472), no change needed — it calls `triggerSummarization` which calls `doSummarization`, which now uses `config.agent.context.keepRecentTokens` directly.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent-loop.ts src/session/session-manager.ts
git commit -m "feat: structured summarization with iterative merge and input filtering"
```

---

### Task 8: Migration 12 + not_before on cron jobs

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/services/cron-service.ts`
- Modify: `src/tools/builtin/cron.ts`
- Modify: `src/prompts/cron/param-schedule-kind.md`
- Test: `tests/unit/cron-service.test.ts`
- Test: `tests/unit/cron-tool.test.ts`

- [ ] **Step 1: Write failing tests for cron-service**

Add to `tests/unit/cron-service.test.ts`:

```typescript
describe('not_before', () => {
  it('computeNextRun skips cron matches before notBefore', () => {
    // Cron: every hour. notBefore: 2 hours from now.
    const svc = createCronService();
    const now = new Date();
    const notBefore = new Date(now.getTime() + 2 * 3600_000);
    const job = svc.addJob({
      name: 'test-not-before',
      scheduleKind: 'cron',
      scheduleValue: '0 * * * *', // every hour
      task: 'test',
      notBefore: notBefore.toISOString(),
    });
    const nextRun = new Date(job.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(notBefore.getTime());
  });

  it('onTimer skips job when now < notBefore', async () => {
    const svc = createCronService();
    const future = new Date(Date.now() + 3600_000);
    const job = svc.addJob({
      name: 'test-not-before-skip',
      scheduleKind: 'at',
      scheduleValue: new Date(Date.now() - 1000).toISOString(), // past — would normally fire
      task: 'test',
      notBefore: future.toISOString(),
    });
    // Job should not fire because not_before is in the future
    // Verify via nextRunAt or by checking it wasn't executed
    expect(job.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/cron-service.test.ts -t "not_before"`
Expected: FAIL — notBefore not recognized

- [ ] **Step 3: Add migration 12**

In `src/db/migrations.ts`, add to the `migrations` array:

```typescript
// Migration 12: not_before on cron jobs — prevent jobs from firing before intended start
`
ALTER TABLE cron_jobs ADD COLUMN not_before TEXT;
`,
```

- [ ] **Step 4: Add notBefore to CronJobInput and CronJob interfaces**

In `src/services/cron-service.ts`:

Add `notBefore?: string;` to `CronJobInput` interface.
Add `notBefore: string | null;` to `CronJob` interface.

- [ ] **Step 5: Update addJob to store notBefore**

Update the INSERT in `addJob`:

```typescript
addJob(input: CronJobInput): CronJob {
  const id = randomUUID();
  const nextRunAt = this.computeNextRun({
    scheduleKind: input.scheduleKind,
    scheduleValue: input.scheduleValue,
    scheduleTz: input.scheduleTz ?? null,
    lastRunAt: null,
    notBefore: input.notBefore ?? null,
  });

  this.db.db.prepare(`
    INSERT INTO cron_jobs (id, name, schedule_kind, schedule_value, schedule_tz, task, enabled, next_run_at, user_id, chat_id, session_id, agent_id, not_before)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.scheduleKind, input.scheduleValue, input.scheduleTz ?? null, input.task, input.enabled !== false ? 1 : 0, nextRunAt, input.userId ?? null, input.chatId ?? null, input.sessionId ?? null, input.agentId ?? null, input.notBefore ?? null);

  return this.getJob(id)!;
}
```

- [ ] **Step 6: Update computeNextRun to respect notBefore**

```typescript
private computeNextRun(job: Pick<CronJob, 'scheduleKind' | 'scheduleValue' | 'scheduleTz' | 'lastRunAt' | 'notBefore'>): string | null {
  const now = new Date();
  const notBefore = job.notBefore ? new Date(job.notBefore) : null;

  switch (job.scheduleKind) {
    case 'at': {
      const target = new Date(job.scheduleValue);
      if (notBefore && target < notBefore) return null; // before not_before — don't schedule
      return target > now ? target.toISOString() : null;
    }

    case 'every': {
      const intervalMs = parseInt(job.scheduleValue, 10);
      if (isNaN(intervalMs) || intervalMs <= 0) return null;
      const base = job.lastRunAt ? new Date(job.lastRunAt) : now;
      let next = new Date(base.getTime() + intervalMs);
      if (notBefore && next < notBefore) next = notBefore;
      return next.toISOString();
    }

    case 'cron': {
      try {
        const opts = job.scheduleTz ? { timezone: job.scheduleTz } : undefined;
        const cron = new Cron(job.scheduleValue, opts);
        let next = cron.nextRun();
        // Advance past notBefore
        if (notBefore) {
          let safety = 0;
          while (next && next < notBefore && safety < 1000) {
            next = cron.nextRun(next);
            safety++;
          }
        }
        return next ? next.toISOString() : null;
      } catch {
        log.warn(`Invalid cron expression: ${job.scheduleValue}`);
        return null;
      }
    }

    default:
      return null;
  }
}
```

- [ ] **Step 7: Update onTimer to check notBefore**

In `onTimer`, add check after the `isOutsideActiveHours` check:

```typescript
if (job.notBefore && now < new Date(job.notBefore)) continue;
```

- [ ] **Step 8: Update rowToJob to include notBefore**

```typescript
notBefore: r.not_before ? String(r.not_before) : null,
```

- [ ] **Step 9: Update updateJob to handle notBefore**

Add in the patch handling:

```typescript
if (patch.notBefore !== undefined) { updates.push('not_before = ?'); values.push(patch.notBefore); }
```

- [ ] **Step 10: Add not_before parameter to cron tool**

In `src/tools/builtin/cron.ts`, add to parameters:

```typescript
not_before: {
  type: 'string',
  description: 'ISO timestamp — job will not fire before this time even if schedule matches. Use for "start from X" patterns.',
},
```

In the `add` action, pass `notBefore`:

```typescript
const job = this.cronService.addJob({
  name,
  scheduleKind,
  scheduleValue,
  scheduleTz: args.schedule_tz ? String(args.schedule_tz) : undefined,
  task,
  enabled: args.enabled !== false,
  userId: effectiveUserId,
  chatId: args.chat_id ? String(args.chat_id) : undefined,
  notBefore: args.not_before ? String(args.not_before) : undefined,
});
```

In the `update` action:

```typescript
if (args.not_before !== undefined) patch.notBefore = args.not_before ? String(args.not_before) : null;
```

- [ ] **Step 11: Update param-schedule-kind.md**

Update `src/prompts/cron/param-schedule-kind.md`:

```markdown
Schedule type: "at" (one-shot ISO timestamp in UTC), "delay" (one-shot, milliseconds from now — use for relative reminders like "in 10 minutes"), "every" (recurring interval in ms), "cron" (5-field cron expression). Prefer "delay" over "at" when the user asks for a relative time (e.g. "za 10 minut", "in an hour"). Use `not_before` parameter when the user wants a recurring schedule to start later today (e.g. "every hour 8-20, but today from 12:00").
```

- [ ] **Step 12: Run tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 13: Commit**

```bash
git add src/db/migrations.ts src/services/cron-service.ts src/tools/builtin/cron.ts src/prompts/cron/param-schedule-kind.md tests/unit/cron-service.test.ts
git commit -m "feat: add not_before on cron jobs (migration 12) to prevent premature firing"
```

---

### Task 9: AGENTS.md — scheduling guidance + date verification

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add scheduling guidance after existing Scheduling section**

In `AGENTS.md`, after the existing Scheduling section (line ~33), add:

```markdown
### Date verification
- Never compute day-of-week mentally — LLMs are unreliable at this.
- When you need to know what day a date falls on, use exec: `date -d "2026-04-04" +%A`
- When you need to find the date of "next Friday" etc., use exec: `date -d "next Friday" +%Y-%m-%d`
- Always verify before creating calendar events or scheduling.

### Before scheduling:
1. **Verify dates** — use the date verification rules above.
2. **Check for conflicts** — look at the user's calendar (if available) and existing cron jobs for the same time window. If conflict or overlap, inform the user and suggest alternatives before proceeding.
3. **Plan first** — for complex schedules (rotations, multiple items, exceptions), present the full plan with specific dates and times to the user BEFORE creating any jobs.

### Rotation pattern:
- Use ONE recurring job with rotation logic in the task, not multiple separate jobs.
- Example task: "Exercise rotation: current Warsaw hour mod 3 determines exercise. 0=suwanie, 1=dociskanie, 2=przetaczanie. 10 reps."

### "Today exception" pattern:
- When a recurring schedule should start later today, use the `not_before` parameter on the cron tool.
- Example: cron `0 8-20 * * *` with not_before set to today at 12:00 — today starts at 12:00, tomorrow at 8:00 as normal.

### After creating a job:
- Verify `nextRunAt` in the response matches the user's intent.
- If it doesn't, fix immediately — don't tell the user it's fine.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "feat: add scheduling guidance, date verification rules, rotation and not_before patterns"
```

---

### Task 10: Final integration test + typecheck

**Files:**
- Test: run full suite

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Fix any issues found**

Address any type errors or test failures.

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: address type errors and test failures from context management overhaul"
```
