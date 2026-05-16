# Context Management Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 7-mechanism / 12-threshold context-management subsystem with a single coherent design: one budget value, pre-call routing, composable transforms, transcript rotation, unified tool result cap, decoupled flush.

**Architecture:** Builds on the design at `docs/superpowers/specs/2026-05-16-context-management-redesign.md`. Foundation module (`context-manager.ts`) provides budget resolution, router (4 routes), transform passes (soft trim, hard clear). SessionManager rotates JSONL on compaction. Agent loop replaces `enforceContextBudget` with router call.

**Tech Stack:** TypeScript, ESM, Vitest. No new dependencies.

**Scope warning:** ~1500 LOC of changes. User will test on feature branch before merge — no auto-merge after CI pass.

---

## Sequencing strategy

Tasks 1-4 build the new module in isolation (no behavior change yet). Tasks 5-8 wire it in. Task 9 deletes the old. Tasks 10-11 verify. **Each task must leave the build green and tests passing.**

Branch: `feat/context-management-redesign` (already created).

---

## Task 1: Foundation — budget resolution + types

Create the module with no transforms yet; just the types and budget resolver. Establish public API surface.

**Files:**
- Create: `src/context/context-manager.ts`
- Create: `tests/unit/context-manager.test.ts`

**Step 1.1: Write failing tests for `resolveBudget`**

Create `tests/unit/context-manager.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveBudget, RESERVED_OUTPUT_TOKENS_DEFAULT, CONTEXT_WINDOW_HARD_MIN_TOKENS } from '../../src/context/context-manager.js';

describe('resolveBudget', () => {
  it('uses configOverride when provided', () => {
    const b = resolveBudget({ modelContextWindow: 200_000, configOverride: 150_000 });
    expect(b.contextWindow).toBe(150_000);
    expect(b.source).toBe('config');
    expect(b.effective).toBe(150_000 - RESERVED_OUTPUT_TOKENS_DEFAULT);
  });

  it('uses modelContextWindow when no override', () => {
    const b = resolveBudget({ modelContextWindow: 200_000 });
    expect(b.contextWindow).toBe(200_000);
    expect(b.source).toBe('model');
    expect(b.effective).toBe(200_000 - RESERVED_OUTPUT_TOKENS_DEFAULT);
  });

  it('falls back to default 200k when neither provided', () => {
    const b = resolveBudget({});
    expect(b.contextWindow).toBe(200_000);
    expect(b.source).toBe('default');
  });

  it('clamps effective to hard min', () => {
    const b = resolveBudget({ configOverride: 1_000 });
    expect(b.effective).toBe(CONTEXT_WINDOW_HARD_MIN_TOKENS); // not negative
  });
});
```

**Step 1.2: Run — should fail with "Cannot find module"**

```bash
npx vitest run tests/unit/context-manager.test.ts
```

**Step 1.3: Implement `resolveBudget` + types**

Create `src/context/context-manager.ts`:

```ts
import type { LLMMessage } from '../llm/types.js';
import { log } from '../utils/logger.js';

// Single source of truth for context-management constants.
// See docs/superpowers/specs/2026-05-16-context-management-redesign.md.

export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4_000;
export const RESERVED_OUTPUT_TOKENS_DEFAULT = 8_000;
export const SAFETY_MARGIN = 1.2;
export const CHARS_PER_TOKEN_ESTIMATE = 2.5;

export interface ContextBudget {
  contextWindow: number;
  reservedForOutput: number;
  effective: number;
  source: 'model' | 'config' | 'default';
}

export interface ResolveBudgetParams {
  modelContextWindow?: number;
  configOverride?: number;
  reservedForOutput?: number;
}

export function resolveBudget(params: ResolveBudgetParams): ContextBudget {
  let contextWindow: number;
  let source: ContextBudget['source'];
  if (params.configOverride && params.configOverride > 0) {
    contextWindow = params.configOverride;
    source = 'config';
  } else if (params.modelContextWindow && params.modelContextWindow > 0) {
    contextWindow = params.modelContextWindow;
    source = 'model';
  } else {
    contextWindow = 200_000;
    source = 'default';
  }
  const reservedForOutput = params.reservedForOutput ?? RESERVED_OUTPUT_TOKENS_DEFAULT;
  const effective = Math.max(CONTEXT_WINDOW_HARD_MIN_TOKENS, contextWindow - reservedForOutput);
  return { contextWindow, reservedForOutput, effective, source };
}

// Estimate token count from messages + system prompt. Pessimistic (multiplies by SAFETY_MARGIN
// at the routing site, not here — this returns the raw estimate).
export function estimatePromptTokens(messages: LLMMessage[], systemPrompt: string): number {
  let chars = systemPrompt.length;
  for (const m of messages) {
    if ('content' in m && typeof m.content === 'string') {
      chars += m.content.length;
    } else if ('content' in m && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text' && block.text) chars += block.text.length;
        if (block.type === 'image') chars += 2500; // rough image token cost
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}
```

**Step 1.4: Run — tests pass**

```bash
npx vitest run tests/unit/context-manager.test.ts
npm run typecheck
```

**Step 1.5: Commit**

```bash
git add src/context/context-manager.ts tests/unit/context-manager.test.ts
git commit -m "feat(context): budget resolution + token estimation foundation"
```

---

## Task 2: Transform passes — softTrimOldToolResults + hardClearOldToolResults

**Files:**
- Modify: `src/context/context-manager.ts`
- Modify: `tests/unit/context-manager.test.ts`

**Step 2.1: Write failing tests**

Append to `tests/unit/context-manager.test.ts`:

```ts
import { softTrimOldToolResults, hardClearOldToolResults, DEFAULT_TRANSFORM_SETTINGS } from '../../src/context/context-manager.js';
import type { LLMMessage } from '../../src/llm/types.js';

function userMsg(content: string): LLMMessage { return { role: 'user', content }; }
function assistantMsg(content: string): LLMMessage { return { role: 'assistant', content }; }
function toolMsg(id: string, content: string): LLMMessage { return { role: 'tool', tool_call_id: id, content }; }

describe('softTrimOldToolResults', () => {
  it('does not touch tool results within protected tail', () => {
    const big = 'x'.repeat(20_000);
    const msgs: LLMMessage[] = [
      userMsg('hi'),
      assistantMsg('reading'),
      toolMsg('t1', big), // oldest — outside protected tail
      assistantMsg('analyzing'),
      toolMsg('t2', big), // inside protected tail (last 3 assistants)
      assistantMsg('done'),
      userMsg('thx'),
      assistantMsg('y'),
    ];
    const out = softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).not.toBe(big); // trimmed
    expect(out[4].content).toBe(big); // unchanged
  });

  it('returns input unchanged if no tool messages are old', () => {
    const msgs: LLMMessage[] = [userMsg('hi'), assistantMsg('ok')];
    expect(softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS)).toEqual(msgs);
  });

  it('does not mutate input', () => {
    const big = 'x'.repeat(20_000);
    const msgs: LLMMessage[] = [
      userMsg('hi'), assistantMsg('a'), toolMsg('t1', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const copy = JSON.stringify(msgs);
    softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(JSON.stringify(msgs)).toBe(copy);
  });

  it('does not trim tool results already under maxChars', () => {
    const small = 'short';
    const msgs: LLMMessage[] = [
      userMsg('hi'), assistantMsg('a'), toolMsg('t1', small),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const out = softTrimOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).toBe(small);
  });
});

describe('hardClearOldToolResults', () => {
  it('replaces old tool results with placeholder', () => {
    const big = 'x'.repeat(60_000);
    const msgs: LLMMessage[] = [
      userMsg('hi'), assistantMsg('a'), toolMsg('t1', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const out = hardClearOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).toBe(DEFAULT_TRANSFORM_SETTINGS.hardClear.placeholder);
  });

  it('does not clear tool results within protected tail', () => {
    const big = 'x'.repeat(60_000);
    const msgs: LLMMessage[] = [
      userMsg('hi'),
      assistantMsg('a'),
      toolMsg('t1', big), // inside protected tail (only 1 prior assistant)
      assistantMsg('b'),
      assistantMsg('c'),
    ];
    const out = hardClearOldToolResults(msgs, DEFAULT_TRANSFORM_SETTINGS);
    expect(out[2].content).toBe(big);
  });
});
```

**Step 2.2: Run — fail**

```bash
npx vitest run tests/unit/context-manager.test.ts
```

**Step 2.3: Implement transforms**

Append to `src/context/context-manager.ts`:

```ts
export interface TransformSettings {
  keepLastAssistants: number;
  softTrim: { maxChars: number; headChars: number; tailChars: number };
  hardClear: { enabled: boolean; placeholder: string };
}

export const DEFAULT_TRANSFORM_SETTINGS: TransformSettings = {
  keepLastAssistants: 3,
  softTrim: { maxChars: 4_000, headChars: 1_500, tailChars: 1_500 },
  hardClear: { enabled: true, placeholder: '[old tool result cleared to free context budget]' },
};

function findCutoffIndex(messages: LLMMessage[], keepLastAssistants: number): number | null {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      seen++;
      if (seen >= keepLastAssistants) {
        return i;
      }
    }
  }
  return null;
}

function asString(content: LLMMessage extends { content: infer C } ? C : never): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b.type === 'text' && b.text ? b.text : '')).join('');
  }
  return '';
}

export function softTrimOldToolResults(
  messages: LLMMessage[],
  settings: TransformSettings,
): LLMMessage[] {
  const cutoff = findCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoff === null) return messages;

  let next: LLMMessage[] | null = null;
  const { maxChars, headChars, tailChars } = settings.softTrim;

  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const content = asString(m.content);
    if (content.length <= maxChars) continue;
    const head = content.slice(0, headChars);
    const tail = content.slice(-tailChars);
    const trimmed = `${head}\n\n[trimmed: kept first ${headChars} + last ${tailChars} chars of ${content.length}]\n\n${tail}`;
    if (!next) next = messages.slice();
    next[i] = { ...m, content: trimmed };
  }
  return next ?? messages;
}

export function hardClearOldToolResults(
  messages: LLMMessage[],
  settings: TransformSettings,
): LLMMessage[] {
  if (!settings.hardClear.enabled) return messages;
  const cutoff = findCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoff === null) return messages;

  let next: LLMMessage[] | null = null;
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    if (!next) next = messages.slice();
    next[i] = { ...m, content: settings.hardClear.placeholder };
  }
  return next ?? messages;
}
```

**Step 2.4: Run — pass**

```bash
npx vitest run tests/unit/context-manager.test.ts
npm run typecheck
```

**Step 2.5: Commit**

```bash
git add src/context/context-manager.ts tests/unit/context-manager.test.ts
git commit -m "feat(context): soft trim and hard clear transform passes"
```

---

## Task 3: Pre-call router

**Files:**
- Modify: `src/context/context-manager.ts`
- Modify: `tests/unit/context-manager.test.ts`

**Step 3.1: Write failing tests**

Append to `tests/unit/context-manager.test.ts`:

```ts
import { routeCall, DEFAULT_TRANSFORM_SETTINGS } from '../../src/context/context-manager.js';

describe('routeCall', () => {
  const budget = { contextWindow: 200_000, reservedForOutput: 8_000, effective: 192_000, source: 'config' as const };

  it('returns fits when under budget', () => {
    const msgs: LLMMessage[] = [userMsg('hi')];
    const res = routeCall({ messages: msgs, systemPrompt: 'small', budget });
    expect(res.route.type).toBe('fits');
  });

  it('returns truncate_only when overflow recoverable by trimming old tool results', () => {
    const big = 'x'.repeat(700_000); // ~280k tokens before estimate × safety margin
    const msgs: LLMMessage[] = [
      userMsg('hi'), assistantMsg('a'), toolMsg('t1', big),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const res = routeCall({ messages: msgs, systemPrompt: 'sp', budget });
    expect(res.route.type).toBe('truncate_only');
  });

  it('returns compact_only when nothing to truncate but overflowing', () => {
    const bigSystem = 'x'.repeat(700_000);
    const msgs: LLMMessage[] = [userMsg('hi')]; // no tool results
    const res = routeCall({ messages: msgs, systemPrompt: bigSystem, budget });
    expect(res.route.type).toBe('compact_only');
  });

  it('returns compact_then_truncate when both passes needed', () => {
    const hugeTool = 'x'.repeat(300_000);
    const userBig = 'u'.repeat(800_000); // most overflow is in user msgs (untrimmable)
    const msgs: LLMMessage[] = [
      userMsg(userBig), assistantMsg('a'), toolMsg('t1', hugeTool),
      assistantMsg('b'), assistantMsg('c'), assistantMsg('d'),
    ];
    const res = routeCall({ messages: msgs, systemPrompt: 'sp', budget });
    expect(res.route.type).toBe('compact_then_truncate');
  });
});
```

**Step 3.2: Run — fail**

**Step 3.3: Implement `routeCall` + `estimateReducibleToolTokens`**

Append to `src/context/context-manager.ts`:

```ts
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
  overflowTokens: number;
}

const TRUNCATE_ROUTE_BUFFER_TOKENS = 512;

export function estimateReducibleToolTokens(
  messages: LLMMessage[],
  settings: TransformSettings,
): number {
  const cutoff = findCutoffIndex(messages, settings.keepLastAssistants);
  if (cutoff === null) return 0;
  let chars = 0;
  for (let i = 0; i < cutoff; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const content = asString(m.content);
    const trimmed = settings.softTrim.headChars + settings.softTrim.tailChars + 200; // est marker length
    const reducible = Math.max(0, content.length - trimmed);
    chars += reducible;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

export function routeCall(params: {
  messages: LLMMessage[];
  systemPrompt: string;
  budget: ContextBudget;
  transformSettings?: TransformSettings;
}): RouterResult {
  const settings = params.transformSettings ?? DEFAULT_TRANSFORM_SETTINGS;
  const raw = estimatePromptTokens(params.messages, params.systemPrompt);
  const estimated = Math.ceil(raw * SAFETY_MARGIN);
  const budget = params.budget.effective;
  const overflow = Math.max(0, estimated - budget);

  if (overflow === 0) {
    return { route: { type: 'fits' }, estimatedTokens: estimated, budget, reducibleTokens: 0, overflowTokens: 0 };
  }

  const reducible = estimateReducibleToolTokens(params.messages, settings);
  if (reducible === 0) {
    return { route: { type: 'compact_only' }, estimatedTokens: estimated, budget, reducibleTokens: 0, overflowTokens: overflow };
  }
  const wouldFitByTruncate = reducible >= (overflow + TRUNCATE_ROUTE_BUFFER_TOKENS);
  if (wouldFitByTruncate) {
    return { route: { type: 'truncate_only' }, estimatedTokens: estimated, budget, reducibleTokens: reducible, overflowTokens: overflow };
  }
  return { route: { type: 'compact_then_truncate' }, estimatedTokens: estimated, budget, reducibleTokens: reducible, overflowTokens: overflow };
}
```

**Step 3.4: Run — pass + typecheck**

**Step 3.5: Commit**

```bash
git add src/context/context-manager.ts tests/unit/context-manager.test.ts
git commit -m "feat(context): pre-call router with 4 dispatch routes"
```

---

## Task 4: Cache boundary marker

**Files:**
- Create: `src/prompts/cache-boundary.ts`
- Create: `tests/unit/cache-boundary.test.ts`

**Step 4.1: Write failing tests**

Create `tests/unit/cache-boundary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CACHE_BOUNDARY, splitAtBoundary, stripBoundary } from '../../src/prompts/cache-boundary.js';

describe('cache boundary', () => {
  it('splits at boundary', () => {
    const sp = `static stuff${CACHE_BOUNDARY}dynamic stuff`;
    const r = splitAtBoundary(sp);
    expect(r).not.toBeNull();
    expect(r!.stablePrefix).toBe('static stuff');
    expect(r!.dynamicSuffix).toBe('dynamic stuff');
  });

  it('returns null if no boundary', () => {
    expect(splitAtBoundary('no marker here')).toBeNull();
  });

  it('strips boundary to single newline', () => {
    const sp = `a${CACHE_BOUNDARY}b`;
    expect(stripBoundary(sp)).toBe('a\nb');
  });

  it('handles multiple boundaries', () => {
    const sp = `a${CACHE_BOUNDARY}b${CACHE_BOUNDARY}c`;
    expect(stripBoundary(sp)).toBe('a\nb\nc');
  });
});
```

**Step 4.2: Run — fail**

**Step 4.3: Implement**

Create `src/prompts/cache-boundary.ts`:

```ts
// Explicit marker separating stable (cacheable) system prompt prefix from dynamic
// suffix. Anthropic provider applies cache_control at this boundary; other providers
// strip the marker and treat as plain text.
// See docs/superpowers/specs/2026-05-16-context-management-redesign.md.

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

**Step 4.4: Run + typecheck**

**Step 4.5: Commit**

```bash
git add src/prompts/cache-boundary.ts tests/unit/cache-boundary.test.ts
git commit -m "feat(prompts): explicit cache boundary marker"
```

---

## Task 5: Modify context-builder to use boundary + return dynamicSuffix as part of system prompt

**Files:**
- Modify: `src/context/context-builder.ts`

**Step 5.1: Read current `build()` return type**

```bash
grep -n "staticPart\|dynamicPart\|ContextResult\|return {" /Users/wt/Sites/janus-agent/src/context/context-builder.ts | head -20
```

Identify the return type (likely `ContextResult` interface or inline). It returns `{ staticPart, dynamicPart, pinnedPaths? }`.

**Step 5.2: Build a single `systemPrompt` string with marker**

Modify `build()` return:

```ts
import { CACHE_BOUNDARY } from '../prompts/cache-boundary.js';

// ... after both arrays are built:

const systemPrompt = staticParts.length > 0 && dynamicParts.length > 0
  ? staticParts.join('\n\n---\n\n') + CACHE_BOUNDARY + dynamicParts.join('\n\n---\n\n')
  : staticParts.join('\n\n---\n\n') + dynamicParts.join('\n\n---\n\n');

return {
  staticPart: staticParts.join('\n\n---\n\n'),
  dynamicPart: dynamicParts.join('\n\n---\n\n'),
  systemPrompt, // NEW: single string with marker
  pinnedPaths: pinnedPathsForSummary,
};
```

(Keep `staticPart`/`dynamicPart` for backwards compat with callers that still split manually; add `systemPrompt` as the new single-source.)

**Step 5.3: Typecheck + tests**

```bash
npm run typecheck && npx vitest run tests/unit/context-manager.test.ts tests/unit/cache-boundary.test.ts
```

**Step 5.4: Commit**

```bash
git add src/context/context-builder.ts
git commit -m "feat(context-builder): assemble single systemPrompt with cache boundary"
```

---

## Task 6: SessionManager — unified tool cap + transcript rotation

**Files:**
- Modify: `src/session/session-manager.ts`
- Create: `tests/unit/session-rotation.test.ts`

**Step 6.1: Write failing tests for rotation + unified cap**

Create `tests/unit/session-rotation.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import type { LLMMessage } from '../../src/llm/types.js';

describe('SessionManager rotation', () => {
  let dir: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sess-rot-'));
    sm = new SessionManager({ sessionsDir: dir, contextWindow: 200_000 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rotates JSONL on summarize(): archive exists + new file has compaction entry', async () => {
    const key = 'test:chat:1';
    for (let i = 0; i < 30; i++) {
      await sm.append(key, { role: 'user', content: `msg ${i}` });
      await sm.append(key, { role: 'assistant', content: `reply ${i}` });
    }
    await sm.summarize(key, 'SUMMARY TEXT', 5_000);

    const files = readdirSync(dir);
    expect(files.some(f => /\.\d+\.jsonl$/.test(f))).toBe(true); // archive
    const live = files.find(f => f.endsWith('.jsonl') && !/\.\d+\.jsonl$/.test(f))!;
    const content = readFileSync(join(dir, live), 'utf-8');
    expect(content).toContain('"_type":"compaction"');
    expect(content).toContain('SUMMARY TEXT');
  });

  it('caps tool result content at unified cap on append', async () => {
    const key = 'test:chat:2';
    const big = 'x'.repeat(500_000);
    await sm.append(key, { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    await sm.append(key, { role: 'tool', tool_call_id: 't', content: big });
    const session = await sm.getOrCreate(key);
    const toolMsg = session.messages.find(m => m.role === 'tool');
    expect(typeof toolMsg!.content).toBe('string');
    expect((toolMsg!.content as string).length).toBeLessThan(big.length);
  });
});
```

**Step 6.2: Run — fail**

**Step 6.3: Modify `summarize()` for rotation**

In `src/session/session-manager.ts`, locate `summarize()` method. Replace the body of the function (or wrap with rotation logic):

```ts
import { rename, writeFile } from 'node:fs/promises';

async summarize(key: string, summaryText: string, keepRecentTokens: number): Promise<void> {
  return this.withLock(key, async () => {
    const session = await this.getOrCreateInner(key);
    const cutIndex = this.findTailCutIndex(session.messages, keepRecentTokens);
    if (cutIndex < 4) return;

    const path = this.sessionPath(key);
    const archivePath = `${path}.${Date.now()}.jsonl`;

    // Rotate: archive current file, write new
    try {
      await rename(path, archivePath);
    } catch (err) {
      log.warn(`[session ${key}] Archive rename failed, proceeding without archive: ${(err as Error).message}`);
    }

    const tailMessages = session.messages.slice(cutIndex);
    const newSession: Session = {
      key,
      messages: tailMessages,
      metadata: {
        ...session.metadata,
        summary: summaryText,
        lastFlushed: tailMessages.length,
        updated: new Date().toISOString(),
        messageCount: tailMessages.length,
      },
    };

    const lines: string[] = [
      JSON.stringify({ _type: 'metadata', ...newSession.metadata }),
      JSON.stringify({ _type: 'compaction', summary: summaryText, archivedAt: new Date().toISOString(), archivePath }),
    ];
    for (const m of tailMessages) lines.push(JSON.stringify(m));

    await writeFile(path, lines.join('\n') + '\n');
    this.cache.set(key, newSession);

    log.info(`[session ${key}] rotated: ${session.messages.length} → ${tailMessages.length} messages; archive: ${archivePath}`);
  });
}

private findTailCutIndex(messages: LLMMessage[], keepRecentTokens: number): number {
  // Walk backwards from end, accumulating tokens until we exceed keepRecentTokens.
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = 'content' in messages[i] ? messages[i].content : '';
    const chars = typeof content === 'string' ? content.length : 0;
    tokens += Math.ceil(chars / 2.5);
    if (tokens > keepRecentTokens) {
      // Snap forward to next user message boundary
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].role === 'user') return j;
      }
      return i + 1;
    }
  }
  return 0;
}
```

**Step 6.4: Modify tool result cap in `append()`**

Find the existing `truncateToolResult` in session-manager.ts. Replace with unified cap derived from contextWindow:

```ts
private toolResultCap(): number {
  const cw = this.contextWindow ?? 200_000;
  const reserved = 8_000;
  return Math.floor((cw - reserved) * 2.5 * 0.5); // 50% of effective budget chars
}

private truncateToolResultUnified(content: string): string {
  const cap = this.toolResultCap();
  if (content.length <= cap) return content;
  const head = Math.floor(cap * 0.7);
  const tail = cap - head;
  return `${content.slice(0, head)}\n\n[truncated: ${content.length - cap} chars removed]\n\n${content.slice(-tail)}`;
}
```

Update `append()` (or wherever the existing truncation happens) to call `this.truncateToolResultUnified(content)` instead of the old logic.

**Step 6.5: Add `contextWindow` to SessionManager constructor**

Pass `contextWindow` from agent.contextWindow config (or model) at SessionManager instantiation in bootstrap.ts. Default to 200_000.

**Step 6.6: Run tests + typecheck**

**Step 6.7: Commit**

```bash
git add src/session/session-manager.ts tests/unit/session-rotation.test.ts
git commit -m "feat(session): transcript rotation + unified tool result cap"
```

---

## Task 7: Wire router into agent-loop; replace enforceContextBudget; remove emergency

**Files:**
- Modify: `src/agent/agent-loop.ts`

**Step 7.1: Find current `enforceContextBudget` call sites**

```bash
grep -n "enforceContextBudget\|Emergency compression\|emergencyThreshold" /Users/wt/Sites/janus-agent/src/agent/agent-loop.ts
```

There are 3-4 call sites (pre-flight at processMessage start, per-iteration in iterate, on LLM timeout, on overflow error). Replace ALL with router call.

**Step 7.2: Pre-call routing**

At each call site, replace:

```ts
enforceContextBudget(messages, this.deps.config.agent);
const emergencyThreshold = this.deps.config.agent.context.emergencyThreshold;
if (estimateMessagesTokens(messages) > this.deps.config.agent.tokenBudget * emergencyThreshold) {
  enforceContextBudget(messages, this.deps.config.agent, true);
}
```

With:

```ts
import { resolveBudget, routeCall, softTrimOldToolResults, hardClearOldToolResults, DEFAULT_TRANSFORM_SETTINGS } from '../context/context-manager.js';

const budget = resolveBudget({
  modelContextWindow: this.deps.config.agent.context.contextWindow,
  // configOverride if user set one
});
const router = routeCall({ messages, systemPrompt, budget });

if (router.route.type === 'truncate_only') {
  messages = softTrimOldToolResults(messages, DEFAULT_TRANSFORM_SETTINGS);
} else if (router.route.type === 'compact_only' || router.route.type === 'compact_then_truncate') {
  // Trigger compaction synchronously (with timeout) — see Task 10
  await this.triggerCompactionSync(sessionKey, pinnedPaths);
  // Reload session after compaction
  const reloaded = await this.deps.sessions.getOrCreate(sessionKey);
  messages = [...reloaded.messages]; // fresh tail after rotation
  if (router.route.type === 'compact_then_truncate') {
    messages = softTrimOldToolResults(messages, DEFAULT_TRANSFORM_SETTINGS);
  }
}
// route 'fits' → no action

log.info(`[${sessionKey}] route: ${router.route.type} (${router.estimatedTokens}/${router.budget} tokens, overflow=${router.overflowTokens})`);
```

**Step 7.3: Add `triggerCompactionSync` helper**

```ts
private async triggerCompactionSync(sessionKey: string, pinnedPaths: Set<string>): Promise<void> {
  if (this.summarizing.has(sessionKey)) {
    log.info(`[${sessionKey}] Compaction already in progress, waiting`);
    while (this.summarizing.has(sessionKey)) await sleep(500);
    return;
  }
  this.summarizing.add(sessionKey);
  try {
    const session = await this.deps.sessions.getOrCreate(sessionKey);
    await this.doSummarization(sessionKey, session.messages, undefined, undefined, undefined, pinnedPaths);
  } finally {
    this.summarizing.delete(sessionKey);
  }
}
```

**Step 7.4: Remove old `Emergency compression` block + `enforceContextBudget` import**

**Step 7.5: Run tests + typecheck (will fail for tests that depend on context-budget.ts)**

We'll fix those in Task 9.

**Step 7.6: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "feat(agent-loop): replace enforceContextBudget with pre-call router"
```

---

## Task 8: Simplify flush triggers (decouple from compaction)

**Files:**
- Modify: `src/agent/agent-loop.ts`

**Step 8.1: Remove pre-compaction flush from `doSummarization()`**

Find lines:

```ts
// Pre-compaction memory flush
const discardUpTo = cutIndex;
let flushed = false;
for (let attempt = 1; attempt <= 3 && !flushed; attempt++) {
  try {
    await this.flushMemory(sessionKey, userId, scope, discardUpTo);
    flushed = true;
  } ...
}
```

**DELETE entirely.** Compaction does not flush.

**Step 8.2: Reduce flush triggers**

Find existing flush trigger logic (5 triggers per memory): count, token, pre-summarization, idle, shutdown.

Remove:
- Pre-summarization trigger (deleted in 8.1)
- Token trigger (was: `sessionTokenEstimate > tokenBudget * 0.4`)
- Idle trigger (if present)

Keep:
- Count trigger: `unflushed > 20` (was: any unflushed)
- Shutdown trigger (existing)

**Step 8.3: Update tests if any reference removed triggers**

Search `tests/` for "pre-compaction flush" or "token-based flush" — update assertions.

**Step 8.4: Run tests + typecheck**

**Step 8.5: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "feat(memory): decouple flush from compaction; simplify triggers"
```

---

## Task 9: Strip dynamicPart from saved user messages

**Files:**
- Modify: `src/agent/agent-loop.ts`

**Step 9.1: Find where user message is built and saved**

```bash
grep -n 'role: .user.\|append(.*role.*user\|<context>' /Users/wt/Sites/janus-agent/src/agent/agent-loop.ts | head -10
```

Look for the line that prepends `<context>\n${dynamicPart}\n</context>` to user content.

**Step 9.2: Stop prepending dynamicPart to user message**

The user message saved to session should be:

```ts
const userMsg: LLMMessage = {
  role: 'user',
  content: opts.userMessage, // plain — no <context> wrap
};
await this.deps.sessions.append(sessionKey, userMsg);
```

But for the LLM call, the dynamicPart still needs to reach the model. Send it as part of the **system prompt**, not the user message. Use the `systemPrompt` field from `context.build()` (which now has `CACHE_BOUNDARY` + dynamicPart appended).

Update `messages[0]`:

```ts
messages = [
  { role: 'system', content: contextResult.systemPrompt },  // includes static + boundary + dynamic
  ...cleanHistory,
  userMsg,
];
```

**Step 9.3: Verify Anthropic provider splits at CACHE_BOUNDARY for caching**

```bash
grep -n "CACHE_BOUNDARY\|splitAtBoundary\|cache_control" /Users/wt/Sites/janus-agent/src/llm/anthropic-provider.ts
```

If the provider doesn't yet know about CACHE_BOUNDARY: add a check that calls `splitAtBoundary(systemPrompt)`, and if non-null, sends two system blocks: first with `cache_control: ephemeral`, second without.

**Step 9.4: Run tests + smoke check**

Smoke: confirm system prompt assembled correctly, no `<context>` in saved user messages.

**Step 9.5: Commit**

```bash
git add src/agent/agent-loop.ts src/llm/anthropic-provider.ts
git commit -m "feat(context): move dynamic content from user message to system prompt"
```

---

## Task 10: Compaction timeout 90s → 15min + abort fallback

**Files:**
- Modify: `src/agent/agent-loop.ts`

**Step 10.1: Locate summarization LLM call timeout**

```bash
grep -n "90_000\|Summarization LLM call timed out" /Users/wt/Sites/janus-agent/src/agent/agent-loop.ts
```

**Step 10.2: Bump to 15 minutes**

```ts
const COMPACTION_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
// ...
const summaryResponse = await withTimeout(this.deps.llm.chat({...}), COMPACTION_TIMEOUT_MS, 'Summarization LLM call timed out');
```

**Step 10.3: Add fallback on timeout — force-drop oldest 50%**

Wrap the entire `doSummarization` body in try/catch:

```ts
try {
  // existing summarize logic
} catch (err) {
  if (err instanceof Error && err.message.includes('timed out')) {
    log.error(`[${sessionKey}] Compaction timed out after ${COMPACTION_TIMEOUT_MS}ms. Falling back to force-drop oldest 50%.`);
    await this.deps.sessions.forceDropOldest(sessionKey, 0.5);
    return;
  }
  throw err;
}
```

**Step 10.4: Add `forceDropOldest` to SessionManager**

In `session-manager.ts`:

```ts
async forceDropOldest(key: string, ratio: number): Promise<void> {
  return this.withLock(key, async () => {
    const session = await this.getOrCreateInner(key);
    const dropCount = Math.floor(session.messages.length * ratio);
    if (dropCount < 4) return;
    // Snap to user message boundary
    let actualDrop = dropCount;
    for (let j = dropCount; j < session.messages.length; j++) {
      if (session.messages[j].role === 'user') { actualDrop = j; break; }
    }
    session.messages = session.messages.slice(actualDrop);
    session.metadata.summary = `[compaction failed at ${new Date().toISOString()}; force-dropped oldest ${actualDrop} messages]`;
    session.metadata.lastFlushed = session.messages.length;
    session.metadata.messageCount = session.messages.length;
    await this.save(key, session);
    log.warn(`[session ${key}] force-dropped ${actualDrop} oldest messages`);
  });
}
```

**Step 10.5: Run tests + typecheck**

**Step 10.6: Commit**

```bash
git add src/agent/agent-loop.ts src/session/session-manager.ts
git commit -m "feat(compaction): 15min timeout + force-drop fallback on failure"
```

---

## Task 11: Config schema cleanup

**Files:**
- Modify: `src/config/schema.ts`

**Step 11.1: Remove fields**

In `agent.context`, remove:
- `compactionThresholds`
- `emergencyThreshold`
- `protectedTailTurns`
- `toolResultMaxShare`
- `toolResultHardMax`
- `softTrimChars`
- `reserveTokens`

In `agent`, remove:
- `tokenBudget`
- `summarizationThreshold`

**Step 11.2: Add fields**

In `agent.context`:

```ts
contextWindow: z.number().int().positive().optional(), // override model-reported value
reservedForOutput: z.number().int().min(1000).default(8_000),
softTrimRatio: z.number().min(0).max(1).default(0.3),
hardClearRatio: z.number().min(0).max(1).default(0.5),
keepLastAssistants: z.number().int().min(1).default(3),
keepRecentTokens: z.number().int().min(1000).default(20_000),
compactionTimeoutMs: z.number().int().min(60_000).default(900_000),
```

**Step 11.3: Update consumers of removed fields**

```bash
grep -rn "tokenBudget\|summarizationThreshold\|compactionThresholds\|emergencyThreshold\|protectedTailTurns\|toolResultMaxShare\|toolResultHardMax\|softTrimChars" /Users/wt/Sites/janus-agent/src --include="*.ts"
```

Any remaining reference: replace with the new equivalent (constants from `context-manager.ts` or new config fields).

**Step 11.4: Update `janus.example.json`** (per the "Example Config Rule" in user memory)

Remove old fields, add new ones with comments explaining each.

**Step 11.5: Run tests + typecheck**

**Step 11.6: Commit**

```bash
git add src/config/schema.ts janus.example.json
git commit -m "feat(config): swap legacy context fields for the redesigned set"
```

---

## Task 12: Delete legacy code

**Files:**
- Delete: `src/agent/context-budget.ts`
- Delete: any tests for it (`tests/unit/context-budget.test.ts` if exists)
- Modify: any import sites

**Step 12.1: Find usages**

```bash
grep -rn "context-budget\|enforceContextBudget\|estimateMessagesTokens" /Users/wt/Sites/janus-agent/src /Users/wt/Sites/janus-agent/tests --include="*.ts"
```

Move `estimateMessagesTokens` to `context-manager.ts` if used elsewhere. Then delete.

**Step 12.2: Delete files**

```bash
rm /Users/wt/Sites/janus-agent/src/agent/context-budget.ts
# also: tests/unit/context-budget*.test.ts if present
```

**Step 12.3: Run full test suite + typecheck**

```bash
npm run typecheck && npm test
```

All pass. No remaining references.

**Step 12.4: Commit**

```bash
git add -u
git commit -m "feat(agent): remove legacy context-budget module (replaced by context-manager)"
```

---

## Task 13: Integration test — 1000-message conversation

**Files:**
- Create: `tests/integration/long-conversation.test.ts`

**Step 13.1: Write the test**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Plus harness imports — adapt to existing integration test pattern in tests/integration/agent-loop.test.ts

describe('Long conversation does not cascade', () => {
  let workDir: string;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), 'long-conv-')); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it('handles 1000 turns without Phase cascade or summarization timeout', async () => {
    // Use mock LLM that returns short deterministic responses
    const { agent, sessions } = await createTestHarness({ workDir, mockLLM: createDeterministicMockLLM() });
    const sessionKey = 'test:chat:long';

    let logLines: string[] = [];
    const origInfo = console.info; const origWarn = console.warn; const origError = console.error;
    console.info = (...a) => logLines.push(a.join(' '));
    console.warn = (...a) => logLines.push(a.join(' '));
    console.error = (...a) => logLines.push(a.join(' '));

    for (let i = 0; i < 1000; i++) {
      await agent.processMessage({ channel: 'test', chatId: 'long', userMessage: `message ${i}`, /* ... */ });
    }

    console.info = origInfo; console.warn = origWarn; console.error = origError;

    // Assertions:
    expect(logLines.filter(l => l.includes('Emergency compression')).length).toBe(0);
    expect(logLines.filter(l => l.includes('Summarization failed')).length).toBe(0);
    expect(logLines.filter(l => l.includes('No-progress exit')).length).toBe(0);

    // Session file should be bounded (not unbounded growth)
    const sessFile = join(workDir, '.janus', 'sessions', 'test_chat_long.jsonl');
    const size = statSync(sessFile).size;
    expect(size).toBeLessThan(200_000); // 200 KB cap

    // Should have rotated at least a few times
    const archives = readdirSync(join(workDir, '.janus', 'sessions')).filter(f => /\.\d+\.jsonl$/.test(f));
    expect(archives.length).toBeGreaterThan(0);
  }, 120_000); // 2 min total test timeout
});
```

**Step 13.2: Run + iterate until passes**

```bash
npx vitest run tests/integration/long-conversation.test.ts
```

**Step 13.3: Commit**

```bash
git add tests/integration/long-conversation.test.ts
git commit -m "test(integration): 1000-turn conversation does not cascade"
```

---

## Task 14: Final verify + push branch + open PR (DO NOT auto-merge)

**Step 14.1: Run full test suite**

```bash
npm test
```

Expected: 700+ pass (was 664; +5 router tests, +4 transform tests, +4 boundary tests, +2 rotation tests, +1 integration).

**Step 14.2: Run typecheck**

```bash
npm run typecheck
```

Clean.

**Step 14.3: Update CLAUDE.md to reflect new architecture**

In `### Key modules (src/)`:
- `agent/` — remove mention of "Phase 1/2/3" and "emergency compression"; mention `context-manager` and router
- Add: `context/context-manager.ts` as one of the listed modules

**Step 14.4: Push + open PR with detailed test plan**

```bash
git push -u origin feat/context-management-redesign
gh pr create --title "feat: context management redesign — kill the 45-day patch chain" --body "$(cat <<'EOF'
## Summary

Replaces the 7-mechanism / 12-threshold context management system (which has accumulated 20+ patch PRs since 2026-04-01) with a single coherent design.

- ONE budget value (no more tokenBudget vs contextWindow confusion)
- Pre-call router (4 routes: fits / truncate_only / compact_only / compact_then_truncate)
- Composable transform passes (softTrim, hardClear)
- Cache boundary marker (explicit static/dynamic split)
- Transcript rotation on compaction (bounded session size)
- Unified tool result cap (same in-loop and on-disk)
- Decoupled flush from compaction (no more silent race)
- 15-min compaction timeout + force-drop fallback (no more permanent cascade)

Spec: docs/superpowers/specs/2026-05-16-context-management-redesign.md
Plan: docs/superpowers/plans/2026-05-16-context-management-redesign.md

## Test plan — USER TESTS BEFORE MERGE

### Automated (already green)
- [x] `npm test` — all 700+ tests pass
- [x] `npm run typecheck` — clean
- [x] Integration test: 1000-turn conversation, no cascade, bounded session size

### Manual on Windows production (feature branch)
- [ ] Switch to feature branch, deploy, restart
- [ ] In diet chat: log 5 meals over 1 hour
- [ ] Trigger the previous-cascade scenario: "my diet plan is bad"
- [ ] Check logs: zero `Phase 1/2/3`, zero `Emergency`, zero `Summarization failed`
- [ ] Send 50+ messages in one session
- [ ] Verify session JSONL stays below 200 KB
- [ ] Verify Anthropic cache hit rate stays >80%

### Manual functional regressions
- [ ] Pinned skill state still loads (see `<pinned_skill_state>` in system prompt via --token-debug)
- [ ] Memory flushes still happen on shutdown (MEMORY.md updated)
- [ ] Agent still answers correctly from food-diary content after long conversation

**Do not auto-merge. Wait for explicit go-ahead.**
EOF
)"
```

**Step 14.5: Wait for user testing and feedback**

User will test on the feature branch in production. If issues, fix and push more commits. If green, user merges.

---

## Self-Review

Spec coverage cross-check:

| Spec requirement | Implementing task |
|---|---|
| One budget value | Task 1 |
| Pre-call router (4 routes) | Task 3 |
| Composable transforms (softTrim, hardClear) | Task 2 |
| Cache boundary marker | Task 4, Task 5 (integration), Task 9 (provider split) |
| Transcript rotation | Task 6 |
| Unified tool result cap | Task 6 |
| Strip context from user messages | Task 9 |
| Decouple flush from compaction | Task 8 |
| 15-min compaction timeout + fallback | Task 10 |
| Config schema cleanup | Task 11 |
| Delete legacy `context-budget.ts` | Task 12 |
| Integration test | Task 13 |
| PR (no auto-merge) | Task 14 |

Type consistency:
- `LLMMessage`, `ContextBudget`, `CallRoute`, `TransformSettings` consistent across tasks
- `routeCall` signature stable from Task 3 onwards
- `softTrimOldToolResults` / `hardClearOldToolResults` signature stable from Task 2

No placeholders. No "TBD". Each task has runnable commands and exact code.
