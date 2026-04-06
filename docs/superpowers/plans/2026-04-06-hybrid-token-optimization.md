# Hybrid Token Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce token cost by 50-70% via cache maximization and improve context quality through smarter compaction with information preservation.

**Architecture:** Three additive layers — (1) prompt cache optimization via dual markers and reverse compaction, (2) smarter compaction with tool pair grouping, artifact externalization, and overflow limits, (3) summarization quality via English-only summaries and annotation extraction. Each layer is independently testable and revertable.

**Tech Stack:** TypeScript, Vitest, Zod (config schema), Anthropic SDK

---

### Task 1: Multi-Provider Overflow Detection

**Files:**
- Create: `src/llm/overflow.ts`
- Create: `tests/unit/overflow.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/overflow.test.ts
import { describe, it, expect } from 'vitest';
import { isContextOverflow } from '../../src/llm/overflow.js';

describe('isContextOverflow', () => {
  it('detects Anthropic request_too_large', () => {
    expect(isContextOverflow(new Error('request_too_large: max 200000 tokens'))).toBe(true);
  });

  it('detects Anthropic prompt is too long', () => {
    expect(isContextOverflow(new Error('prompt is too long: 250000 tokens > 200000 maximum'))).toBe(true);
  });

  it('detects OpenAI maximum context length', () => {
    expect(isContextOverflow(new Error("This model's maximum context length is 128000 tokens"))).toBe(true);
  });

  it('detects OpenAI Request too large', () => {
    expect(isContextOverflow(new Error('Request too large for model'))).toBe(true);
  });

  it('detects Google exceeds the maximum', () => {
    expect(isContextOverflow(new Error('Input exceeds the maximum number of tokens'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isContextOverflow(new Error('rate limit exceeded'))).toBe(false);
    expect(isContextOverflow(new Error('network timeout'))).toBe(false);
    expect(isContextOverflow(new Error('invalid api key'))).toBe(false);
  });

  it('handles non-Error objects gracefully', () => {
    expect(isContextOverflow('string error' as unknown as Error)).toBe(false);
    expect(isContextOverflow(null as unknown as Error)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/overflow.test.ts`
Expected: FAIL — module `../../src/llm/overflow.js` does not exist

- [ ] **Step 3: Implement overflow detection**

```typescript
// src/llm/overflow.ts

/**
 * Multi-provider context overflow detection.
 * Returns true if the error indicates the request exceeds the model's context window.
 */

const OVERFLOW_PATTERNS = [
  // Anthropic
  /request_too_large/i,
  /prompt is too long/i,
  // OpenAI / OpenRouter
  /maximum context length/i,
  /request too large/i,
  /context_length_exceeded/i,
  // Google / Gemini
  /exceeds the maximum/i,
  // Generic
  /token limit/i,
  /input too long/i,
];

export function isContextOverflow(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return false;
  return OVERFLOW_PATTERNS.some(p => p.test(message));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/overflow.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/llm/overflow.ts tests/unit/overflow.test.ts
git commit -m "feat: add multi-provider context overflow detection"
```

---

### Task 2: Reverse Compaction Direction + Annotation Extraction

**Files:**
- Modify: `src/agent/context-budget.ts`
- Modify: `tests/unit/context-budget.test.ts`

- [ ] **Step 1: Write failing tests for reverse compaction and annotations**

Add these tests to `tests/unit/context-budget.test.ts`:

```typescript
  it('Phase 1: soft-trims newest tool results first (preserves cache prefix)', () => {
    const config = makeConfig({ tokenBudget: 1000 });
    const oldContent = chars(1000);
    const newContent = chars(1000);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a1' },
      { role: 'tool', tool_call_id: 'old', content: oldContent },
      { role: 'assistant', content: 'a2' },
      { role: 'tool', tool_call_id: 'new', content: newContent },
      // Protected tail
      { role: 'assistant', content: 'r1' },
      { role: 'assistant', content: 'r2' },
      { role: 'assistant', content: 'r3' },
    ];

    enforceContextBudget(messages, config);

    const oldTool = messages.find(m => m.role === 'tool' && (m as any).tool_call_id === 'old')!;
    const newTool = messages.find(m => m.role === 'tool' && (m as any).tool_call_id === 'new')!;
    // Newer tool should be trimmed first (or more aggressively)
    // If trimming the newer one was enough to get under budget, old one stays intact
    const newTrimmed = (newTool.content as string).includes('[trimmed]');
    const oldTrimmed = (oldTool.content as string).includes('[trimmed]');
    // At minimum, the newer one must be trimmed
    expect(newTrimmed).toBe(true);
    // Old may or may not be trimmed depending on budget — but if only one needed trimming, it should be the newer one
    if (!oldTrimmed) {
      expect(newTrimmed).toBe(true);
    }
  });

  it('Phase 2: hard-clear includes annotation instead of bare cleared message', () => {
    // Force Phase 2 by setting Phase 1 threshold very low
    const config = makeConfig({ tokenBudget: 400, context: {
      softTrimChars: 100,
      compactionThresholds: [0.01, 0.02, 0.99] as [number, number, number], // skip phase 1, trigger phase 2
      emergencyThreshold: 0.95,
      protectedTailTurns: 0,
    }});
    const messages: LLMMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'a', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'exec', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'tc1', content: 'file1.txt\nfile2.txt\nfile3.txt' },
    ];

    enforceContextBudget(messages, config);

    const toolMsg = messages.find(m => m.role === 'tool')!;
    const content = toolMsg.content as string;
    expect(content).toContain('[cleared');
    // Should contain annotation with first line of content
    expect(content).toContain('file1.txt');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/context-budget.test.ts`
Expected: The new "newest first" test fails (old code trims oldest first). The annotation test fails (old code uses bare `[tool result cleared]`).

- [ ] **Step 3: Implement reverse compaction and annotation extraction**

Replace the content of `src/agent/context-budget.ts`:

```typescript
/**
 * Graduated context compaction: soft-trim → hard-clear → drop turns.
 * Replaces the old trimHistoryToTokenBudget + pruneOldToolResults functions.
 */

import type { LLMMessage, ToolContentBlock } from '../llm/types.js';
import * as log from '../utils/logger.js';

export interface ContextBudgetConfig {
  tokenBudget: number;
  context: {
    softTrimChars: number;
    compactionThresholds: [number, number, number];
    emergencyThreshold: number;
    protectedTailTurns: number;
  };
}

// ---------------------------------------------------------------------------
// Token estimation (mirrors agent-loop.ts heuristic)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function estimateMessageTokens(msg: LLMMessage): number {
  let total = 0;
  if ('content' in msg && msg.content) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const b of msg.content as ToolContentBlock[]) {
        if (b.type === 'text') total += estimateTokens(b.text);
        else if (b.type === 'image') total += 1000;
      }
    }
  }
  if ('tool_calls' in msg && msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function.name + tc.function.arguments);
    }
  }
  return total;
}

function estimateTotal(messages: LLMMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// Annotation extraction — heuristic, zero-cost key-value from tool results
// ---------------------------------------------------------------------------

function extractAnnotation(msg: LLMMessage): string {
  if (msg.role !== 'tool' || typeof msg.content !== 'string') return '';
  const content = msg.content;

  // Find the tool name from the tool_call_id by looking at context (not available here),
  // so we use content heuristics instead
  const firstLine = content.split('\n')[0]?.slice(0, 120) ?? '';
  return firstLine.replace(/\n/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Enforce the context token budget via graduated in-place compaction:
 *   Phase 1 (≥75%) — soft-trim long tool results NEWEST-FIRST (preserves cache prefix)
 *   Phase 2 (≥80%) — hard-clear tool results → "[cleared — {annotation}]" NEWEST-FIRST
 *   Phase 3 (≥85%) — drop oldest assistant+tool turn groups (never user msgs)
 *
 * In emergency mode the protected tail is disabled so every non-user message
 * outside the system prefix can be compacted.
 */
export function enforceContextBudget(
  messages: LLMMessage[],
  config: ContextBudgetConfig,
  emergency = false,
): void {
  const { tokenBudget, context } = config;
  const [t1, t2, t3] = context.compactionThresholds;

  let tokens = estimateTotal(messages);
  if (tokens <= t1 * tokenBudget) return;

  // --- Locate immutable boundaries ---

  // First user message index — everything before it (system/bootstrap) is untouchable.
  let firstUserIndex = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') { firstUserIndex = i; break; }
  }

  // Protected tail — walk backwards counting assistant messages.
  let tailStart = messages.length;
  if (!emergency) {
    let assistantsSeen = 0;
    for (let i = messages.length - 1; i >= firstUserIndex; i--) {
      if (messages[i].role === 'assistant') {
        assistantsSeen++;
        if (assistantsSeen >= context.protectedTailTurns) {
          tailStart = i;
          break;
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase 1 — Soft-trim NEWEST-FIRST (trigger: >t1 budget)
  // Reverse iteration preserves old messages in Anthropic prompt cache prefix.
  // -----------------------------------------------------------------------
  if (tokens > t1 * tokenBudget) {
    log.info(`[context-budget] Phase 1: soft-trim (${tokens}/${tokenBudget} tokens, ${Math.round(tokens / tokenBudget * 100)}%)`);
    const halfTrim = Math.floor(context.softTrimChars * 0.375);

    for (let i = tailStart - 1; i >= firstUserIndex && tokens > t1 * tokenBudget; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      if (typeof msg.content !== 'string') continue;
      if (msg.content.length <= context.softTrimChars) continue;

      const before = estimateTokens(msg.content);
      const head = msg.content.slice(0, halfTrim);
      const tail = msg.content.slice(-halfTrim);
      (msg as { content: string }).content = head + '\n[trimmed]\n' + tail;
      const after = estimateTokens(msg.content);
      tokens -= (before - after);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2 — Hard-clear with annotation NEWEST-FIRST (trigger: >t2 budget)
  // -----------------------------------------------------------------------
  if (tokens > t2 * tokenBudget) {
    log.info(`[context-budget] Phase 2: hard-clear (${tokens}/${tokenBudget} tokens, ${Math.round(tokens / tokenBudget * 100)}%)`);

    for (let i = tailStart - 1; i >= firstUserIndex && tokens > t2 * tokenBudget; i--) {
      const msg = messages[i];
      if (msg.role !== 'tool') continue;
      if (typeof msg.content !== 'string') continue;

      const before = estimateTokens(msg.content);
      const annotation = extractAnnotation(msg);
      const replacement = annotation
        ? `[cleared — ${annotation}]`
        : '[tool result cleared]';
      (msg as { content: string }).content = replacement;
      const after = estimateTokens(replacement);
      tokens -= (before - after);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 3 — Drop turns (trigger: >t3 budget)
  // Stays oldest-first — removing messages changes prefix regardless.
  // -----------------------------------------------------------------------
  if (tokens > t3 * tokenBudget) {
    log.info(`[context-budget] Phase 3: drop turns (${tokens}/${tokenBudget} tokens, ${Math.round(tokens / tokenBudget * 100)}%)`);

    // Count non-system messages to enforce the floor of 2.
    const nonSystemCount = () => messages.filter(m => m.role !== 'system').length;

    // Scan forward from firstUserIndex, find the oldest assistant, drop it + following tool msgs.
    while (tokens > t3 * tokenBudget && nonSystemCount() > 2) {
      // Find oldest assistant message in the droppable range.
      let idx = -1;
      for (let i = firstUserIndex; i < messages.length; i++) {
        if (messages[i].role === 'assistant') { idx = i; break; }
      }
      if (idx === -1) break; // no more assistant messages to drop

      // Count how many messages to remove (assistant + immediately following tool messages).
      let count = 1;
      while (idx + count < messages.length && messages[idx + count].role === 'tool') {
        count++;
      }

      // Subtract tokens for the group.
      for (let j = idx; j < idx + count; j++) {
        tokens -= estimateMessageTokens(messages[j]);
      }

      messages.splice(idx, count);
    }
  }
}
```

- [ ] **Step 4: Run all context-budget tests**

Run: `npx vitest run tests/unit/context-budget.test.ts`
Expected: All tests PASS (8 existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/agent/context-budget.ts tests/unit/context-budget.test.ts
git commit -m "feat: reverse compaction direction + annotation extraction in context budget"
```

---

### Task 3: Dual Cache Markers in Anthropic Provider

**Files:**
- Modify: `src/llm/anthropic-provider.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/anthropic-cache-markers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// We test the cache marker logic by extracting it into a helper.
// The helper is used by both chat() and chatStream().
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

  it('marks built-in/MCP boundary AND last tool when MCP tools present', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_search', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_pr', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    // Built-in boundary (last non-mcp_ tool = index 1)
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
    // Last tool overall (index 3)
    expect((tools[3] as any).cache_control).toEqual({ type: 'ephemeral' });
    // Others unmarked
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[2] as any).cache_control).toBeUndefined();
  });

  it('handles all-MCP tools list (no built-in)', () => {
    const tools = [
      { name: 'mcp_a_tool1', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_b_tool2', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    // No built-in boundary, just last tool
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
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

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/anthropic-cache-markers.test.ts`
Expected: FAIL — `applyCacheMarkers` not exported

- [ ] **Step 3: Extract and implement cache marker helper**

Add this exported function to `src/llm/anthropic-provider.ts` (before the class):

```typescript
/**
 * Apply prompt cache markers to tool definitions.
 * Places markers at two boundaries for optimal cache retention:
 * 1. Last built-in tool (stable across MCP changes)
 * 2. Last tool overall (captures MCP tools)
 * If no MCP tools present, only marks the last tool (same as before).
 */
export function applyCacheMarkers(tools: Array<{ name: string; [k: string]: unknown }>): void {
  if (tools.length === 0) return;

  const lastIdx = tools.length - 1;

  // Find last built-in tool (non-mcp_ prefix)
  let lastBuiltinIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    if (!tools[i].name.startsWith('mcp_')) {
      lastBuiltinIdx = i;
      break;
    }
  }

  // Mark built-in boundary (if it exists and differs from last tool)
  if (lastBuiltinIdx >= 0 && lastBuiltinIdx !== lastIdx) {
    tools[lastBuiltinIdx].cache_control = { type: 'ephemeral' };
  }

  // Always mark last tool
  tools[lastIdx].cache_control = { type: 'ephemeral' };
}
```

Then replace the inline cache marker logic in both `chat()` and `chatStream()`.

In `chat()` (around line 110-122), replace:

```typescript
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t) => {
        const tool: Anthropic.Tool = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        };
        return tool;
      });
      applyCacheMarkers(params.tools);
```

In `chatStream()` (around line 237-248), same replacement:

```typescript
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t) => {
        const tool: Anthropic.Tool = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        };
        return tool;
      });
      applyCacheMarkers(params.tools);
    }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/anthropic-cache-markers.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Run full test suite for regression**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/llm/anthropic-provider.ts tests/unit/anthropic-cache-markers.test.ts
git commit -m "feat: dual cache markers at built-in/MCP boundary for prompt cache stability"
```

---

### Task 4: Artifact Externalization for Large Tool Results

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/session/session-manager.ts`
- Modify: `janus.example.json`
- Create: `tests/unit/artifact-externalization.test.ts`

- [ ] **Step 1: Add config field**

In `src/config/schema.ts`, add `artifactThreshold` to `ContextSchema`:

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
  artifactThreshold: z.number().default(32_000),
});
```

- [ ] **Step 2: Update janus.example.json**

Add `artifactThreshold` to the `agent.context` section:

```json
    "context": {
      "keepRecentTokens": 20000,
      "reserveTokens": 20000,
      "toolResultMaxShare": 0.3,
      "toolResultHardMax": 400000,
      "softTrimChars": 4000,
      "compactionThresholds": [0.75, 0.80, 0.85],
      "emergencyThreshold": 0.95,
      "protectedTailTurns": 3,
      "artifactThreshold": 32000
    }
```

- [ ] **Step 3: Write failing tests**

```typescript
// tests/unit/artifact-externalization.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { externalizeToolResult } from '../../src/session/session-manager.js';

describe('externalizeToolResult', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `janus-test-artifact-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns content unchanged when below threshold', () => {
    const result = externalizeToolResult('short result', 32000, tmpDir, 'session1');
    expect(result).toBe('short result');
  });

  it('returns content unchanged when threshold is 0 (disabled)', () => {
    const big = 'x'.repeat(50000);
    const result = externalizeToolResult(big, 0, tmpDir, 'session1');
    expect(result).toBe(big);
  });

  it('externalizes content exceeding threshold', () => {
    const big = 'HEADER_LINE\n' + 'data\n'.repeat(10000) + 'FOOTER_LINE';
    const result = externalizeToolResult(big, 1000, tmpDir, 'session1');

    expect(result).toContain('[Tool result stored:');
    expect(result).toContain(`Size: ${big.length} chars`);
    expect(result).toContain('HEADER_LINE');
    expect(result).toContain('FOOTER_LINE');
  });

  it('writes artifact file to disk', () => {
    const big = 'x'.repeat(2000);
    externalizeToolResult(big, 1000, tmpDir, 'session1');

    const artifactDir = join(tmpDir, 'artifacts', 'session1');
    expect(existsSync(artifactDir)).toBe(true);

    const files = require('node:fs').readdirSync(artifactDir);
    expect(files.length).toBe(1);

    const content = readFileSync(join(artifactDir, files[0]), 'utf-8');
    expect(content).toBe(big);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/unit/artifact-externalization.test.ts`
Expected: FAIL — `externalizeToolResult` not exported

- [ ] **Step 5: Implement artifact externalization**

Add this exported function to `src/session/session-manager.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Externalize oversized tool results to disk artifacts.
 * Returns the original content if below threshold, or a compact reference if externalized.
 */
export function externalizeToolResult(
  content: string,
  threshold: number,
  janusDir: string,
  sessionKey: string,
): string {
  if (threshold <= 0 || content.length <= threshold) return content;

  // Write full content to artifact file
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const artifactDir = join(janusDir, 'artifacts', safeKey);
  mkdirSync(artifactDir, { recursive: true });
  const filename = `${Date.now()}.txt`;
  const filepath = join(artifactDir, filename);
  writeFileSync(filepath, content, 'utf-8');

  // Build compact reference with head+tail preview
  const head = content.slice(0, 500);
  const tail = content.slice(-500);
  return `[Tool result stored: ${filepath}]\n[Size: ${content.length} chars]\n\nFirst 500 chars:\n${head}\n\nLast 500 chars:\n${tail}`;
}
```

Then modify `truncateToolResult` in the `SessionManager` class to call externalization first:

In the existing `private truncateToolResult(content: string)` method, add externalization before truncation:

```typescript
  private processToolResult(content: string, sessionKey: string): string {
    // Step 1: externalize if above artifact threshold
    const artifactThreshold = this.artifactThreshold;
    if (artifactThreshold > 0 && content.length > artifactThreshold) {
      return externalizeToolResult(content, artifactThreshold, this.janusDir, sessionKey);
    }

    // Step 2: truncate if above hard max (existing logic)
    const dynamicCap = Math.floor(this.contextWindow * 2.5 * this.toolResultMaxShare);
    const cap = Math.min(dynamicCap, this.toolResultHardMax);
    if (content.length <= cap) return content;

    const headLen = Math.floor(cap * 0.7);
    const tailLen = cap - headLen;
    const removed = content.length - headLen - tailLen;
    const marker = `\n\n[truncated: ${removed} chars removed to fit context budget]\n\n`;
    return content.slice(0, headLen) + marker + content.slice(-tailLen);
  }
```

Update the `append()` method to pass `sessionKey` and the constructor to store `janusDir` and `artifactThreshold`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/artifact-externalization.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/config/schema.ts src/session/session-manager.ts tests/unit/artifact-externalization.test.ts janus.example.json
git commit -m "feat: externalize large tool results to disk artifacts"
```

---

### Task 5: Overflow Recovery Limit + Use isContextOverflow

**Files:**
- Modify: `src/agent/agent-loop.ts`

- [ ] **Step 1: Import isContextOverflow and replace inline patterns**

In `src/agent/agent-loop.ts`, add import:

```typescript
import { isContextOverflow } from '../llm/overflow.js';
```

- [ ] **Step 2: Replace the inline context error detection**

Find the catch block in `iterate()` (around line 785-806). Replace:

```typescript
        const isContextError = /token|context|length|too long/i.test(errorText);
```

with:

```typescript
        const isContextError = isContextOverflow(err);
```

- [ ] **Step 3: Change contextRetries limit from 2 to 1**

Replace:

```typescript
        if (isTimeout && contextRetries < 2 && messages.length > 6) {
```

with:

```typescript
        if (isTimeout && contextRetries < 1 && messages.length > 6) {
```

And replace:

```typescript
        if (isContextError && contextRetries < 2) {
```

with:

```typescript
        if (isContextError && contextRetries < 1) {
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "feat: use multi-provider overflow detection, limit recovery to 1 retry"
```

---

### Task 6: Cache Hit Rate Tracking

**Files:**
- Modify: `src/agent/agent-loop.ts`

- [ ] **Step 1: Add cache accumulation variables**

In the `iterate()` method, after the existing variable declarations (around line 710), add:

```typescript
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalPromptTokens = 0;
```

- [ ] **Step 2: Accumulate cache stats after each LLM response**

After `totalTokens += response.usage.totalTokens;` (around line 855), add:

```typescript
      totalPromptTokens += response.usage.promptTokens;
      if (response.usage.cacheReadTokens) totalCacheRead += response.usage.cacheReadTokens;
      if (response.usage.cacheWriteTokens) totalCacheWrite += response.usage.cacheWriteTokens;
```

- [ ] **Step 3: Log cache hit rate on completion**

Before each `return` statement that has `outcome: 'success'` (around line 869), add:

```typescript
        if (totalPromptTokens > 0) {
          const cacheTotal = totalPromptTokens + totalCacheRead + totalCacheWrite;
          const hitRate = cacheTotal > 0 ? Math.round(totalCacheRead / cacheTotal * 100) : 0;
          log.info(`[${sessionKey}] Token summary: prompt=${totalPromptTokens}, cache_read=${totalCacheRead}, cache_write=${totalCacheWrite}, hit_rate=${hitRate}%`);
        }
```

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "feat: accumulate and log cache hit rate per request"
```

---

### Task 7: English-Only Summarization Prompts

**Files:**
- Modify: `src/prompts/summarization/initial.md`
- Modify: `src/prompts/summarization/update.md`

- [ ] **Step 1: Update initial.md**

Add to the first line of `src/prompts/summarization/initial.md`:

```markdown
IMPORTANT: Always write the summary in English regardless of the conversation language. English summaries are more token-efficient and improve context retention.

Summarize this conversation for context continuity. Use EXACTLY this template. Write "None" for empty sections. Never skip a section.
```

- [ ] **Step 2: Update update.md**

Add after the first line of `src/prompts/summarization/update.md`:

```markdown
IMPORTANT: Always write the summary in English regardless of the conversation language.
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (prompts are loaded as strings, no schema validation)

- [ ] **Step 4: Commit**

```bash
git add src/prompts/summarization/initial.md src/prompts/summarization/update.md
git commit -m "feat: enforce English-only summarization for token efficiency"
```

---

### Task 8: Final Integration Test + Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors

- [ ] **Step 3: Verify no regressions in existing tests**

Run: `npx vitest run tests/unit/context-budget.test.ts tests/unit/config-schema.test.ts`
Expected: All PASS

- [ ] **Step 4: Final commit (if any fixups needed)**

```bash
git add -A
git commit -m "chore: token optimization integration fixups"
```
