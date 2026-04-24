# Summarization & Context Loss Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix conversation context being lost after summarization — the agent forgets everything discussed in long conversations because the summarizer produces 12-57 token outputs instead of useful summaries.

**Architecture:** Improve summarization prompts to enforce minimum detail preservation, add quality validation with retry, introduce a cooldown to prevent excessive summarization cycles, and fix the date/time visibility issue. All changes preserve Phase 14 token optimizations.

**Tech Stack:** TypeScript, Vitest, Markdown prompts

---

## Background

Server logs show summarization producing outputs of **12-57 tokens** for conversations with 100+ messages. This causes a "degradation spiral" — each summarization cycle produces a shorter summary, which makes the next cycle even shorter, until the agent has zero context about the conversation.

**Root causes identified from production logs (22-24.04.2026):**
1. `initial.md` prompt too generic — doesn't enforce structured detail preservation
2. `update.md` with a 12-token previousSummary produces even shorter output (spiral)
3. No minimum quality validation — 12-token summary is accepted silently
4. Summarization fires 8 times in 2.5 days (threshold=40 msgs, user sends 100+/day)
5. No cooldown between summarizations — can fire back-to-back
6. Agent runs `exec(date /T)` to check time — temporal context lost after summarization

**Constraints (from user):**
- Phase 14 token optimizations MUST be preserved (background mode, session clearing, flush consolidation)
- Solutions must not significantly increase per-message token cost

---

### Task 1: Improve summarization prompts

**Files:**
- Modify: `src/prompts/summarization/initial.md`
- Modify: `src/prompts/summarization/update.md`

- [ ] **Step 1: Rewrite initial.md with structured preservation requirements**

Replace `src/prompts/summarization/initial.md` entirely:

```markdown
Summarize this conversation for context continuity. The summary MUST preserve enough detail for the assistant to continue the conversation without asking the user to repeat themselves.

Use EXACTLY this template. Write "None" for empty sections. Never skip a section. Each section must contain specific details, not vague descriptions.

## Goal
[Core user intent — what are they trying to accomplish?]

## Constraints & Preferences
[User-stated constraints: times, dates, names, quantities, conditions, exceptions. Quote exact words for critical constraints. Include behavioral instructions like "don't change X without asking", "only topic Y on this channel", "check before modifying".]

## Established Facts
[Specific data points established during the conversation that the user would expect the assistant to remember: names, numbers, measurements, definitions, shorthand/aliases, file paths, tools in use, formulas, recurring references. These should GROW as the conversation progresses — never discard unless explicitly superseded.]

## Progress
### Done
- [completed items with specifics — include numbers, dates, measurements]
### In Progress
- [ongoing items with current state]

## Key Decisions
- [decisions made and their rationale — include what was rejected and why]

## Open TODOs
- [pending items with any deadlines]

## Critical Context
[MUST NOT be lost: exact times, names, dates, addresses, identifiers, exceptions, user corrections, channel/routing rules. Preserve user's exact words for scheduling constraints.]

## Identifiers
[Preserve verbatim: job IDs, file paths, URLs, user IDs, UUIDs, chat IDs, calendar event IDs]
```

- [ ] **Step 2: Rewrite update.md with explicit merge rules**

Replace `src/prompts/summarization/update.md` entirely:

```markdown
Update the existing conversation summary with new information. The previous summary is in <previous-summary> tags. New conversation messages follow.

Rules:
- PRESERVE all existing information from the previous summary — especially Established Facts and Constraints
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- NEVER remove Established Facts unless the user explicitly superseded them
- NEVER remove Critical Context unless the user explicitly superseded it
- MERGE new facts into Established Facts — this section should GROW over time
- MERGE Identifiers: append new ones, keep all existing
- If the user corrected an earlier assumption, update it and note the correction
- Use EXACTLY the same template sections as the previous summary
- Write "None" for empty sections. Never skip a section.

The summary must be detailed enough that someone reading ONLY the summary (not the conversation) could continue the conversation without asking the user to repeat information.

<previous-summary>
{{previousSummary}}
</previous-summary>
```

- [ ] **Step 3: Run existing tests**

Run: `npm test -- --reporter=verbose 2>&1 | head -80`
Expected: All existing tests pass (prompts are loaded at runtime, tests don't validate content).

- [ ] **Step 4: Commit**

```bash
git add src/prompts/summarization/initial.md src/prompts/summarization/update.md
git commit -m "fix: rewrite summarization prompts to enforce structured detail preservation

Previous prompts produced summaries of 12-57 tokens, losing all conversation
context. New prompts enforce structured sections (Established Facts, Constraints,
Identifiers) that grow over time rather than shrinking with each cycle."
```

---

### Task 2: Add summarization quality validation with retry

**Files:**
- Modify: `src/agent/agent-loop.ts:1257-1273` (doSummarization method)
- Modify: `tests/unit/summarization-retry.test.ts`

- [ ] **Step 1: Update the summarization-retry test to expect the new validation**

Replace `tests/unit/summarization-retry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Summarization quality validation', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should not contain old scheduling quality retry heuristic', () => {
    expect(source).not.toContain('hasScheduling');
    expect(source).not.toContain('hasCriticalContext');
  });

  it('should validate summary length and retry if too short', () => {
    expect(source).toContain('MIN_SUMMARY_TOKENS');
    expect(source).toContain('Summary too short');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/summarization-retry.test.ts --reporter=verbose`
Expected: FAIL — `MIN_SUMMARY_TOKENS` not found in source.

- [ ] **Step 3: Add quality validation in doSummarization**

In `src/agent/agent-loop.ts`, find the section after the summarization LLM call (around line 1267-1273). Replace:

```typescript
    log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);
    logTokenUsage('summarize', summaryResponse.usage, summaryResponse.provider, summaryResponse.model);

    let summary = summaryResponse.content;

    await this.deps.sessions.summarize(sessionKey, summary, keepRecentTokens);
```

With:

```typescript
    log.info(`[${sessionKey}] Summarization: LLM call done in ${Date.now() - llmStart}ms`);
    logTokenUsage('summarize', summaryResponse.usage, summaryResponse.provider, summaryResponse.model);

    let summary = summaryResponse.content;

    // Quality gate: if summary is too short, retry once with explicit instruction.
    // 200 tokens ≈ 500 chars — a minimum for preserving structured context.
    const MIN_SUMMARY_TOKENS = 200;
    const estimatedTokens = Math.ceil(summary.length / 2.5);
    if (estimatedTokens < MIN_SUMMARY_TOKENS && toSummarize.length >= 10) {
      log.warn(`[${sessionKey}] Summary too short (${estimatedTokens} tokens), retrying with explicit instruction`);
      const retryResponse = await withTimeout(this.deps.llm.chat({
        model: '',
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: conversationText },
          { role: 'assistant', content: summary },
          { role: 'user', content: 'This summary is too short and will cause context loss. The conversation contained specific products, numbers, user preferences, and decisions that MUST be preserved. Rewrite the summary with ALL details from the template sections. Every section must have specific content — do not write "None" unless the conversation truly had nothing for that section.' },
        ],
        temperature: 0.3,
        maxTokens: 2048,
      }, 'summarize'), 90_000, 'Summarization retry timed out');
      logTokenUsage('summarize-retry', retryResponse.usage, retryResponse.provider, retryResponse.model);
      const retryTokens = Math.ceil(retryResponse.content.length / 2.5);
      if (retryTokens > estimatedTokens) {
        log.info(`[${sessionKey}] Summary retry improved: ${estimatedTokens} → ${retryTokens} tokens`);
        summary = retryResponse.content;
      }
    }

    await this.deps.sessions.summarize(sessionKey, summary, keepRecentTokens);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/summarization-retry.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test -- --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent-loop.ts tests/unit/summarization-retry.test.ts
git commit -m "fix: add summarization quality validation with retry

If the summary is shorter than 200 tokens (~500 chars) for conversations
with 10+ messages, retry once with explicit instruction to preserve all
details. Prevents the degradation spiral where each summarization cycle
produces shorter and shorter output."
```

---

### Task 3: Add summarization cooldown

**Files:**
- Modify: `src/agent/agent-loop.ts:459-473` (summarization trigger)
- Create: `tests/unit/summarization-cooldown.test.ts`

- [ ] **Step 1: Write the cooldown test**

Create `tests/unit/summarization-cooldown.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('Summarization cooldown', () => {
  const source = readFileSync('src/agent/agent-loop.ts', 'utf-8');

  it('should track last summarization time per session', () => {
    expect(source).toContain('lastSummarizedAt');
  });

  it('should enforce minimum gap between summarizations', () => {
    expect(source).toContain('SUMMARIZATION_COOLDOWN_MS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/summarization-cooldown.test.ts --reporter=verbose`
Expected: FAIL

- [ ] **Step 3: Add cooldown tracking to AgentLoop**

In `src/agent/agent-loop.ts`, add a new Map near the existing `summarizing` set (around line 78):

```typescript
  /** Guard against concurrent summarization (C2) */
  private summarizing = new Set<string>();
  /** Track when each session was last summarized to enforce cooldown. */
  private lastSummarizedAt = new Map<string, number>();
```

- [ ] **Step 4: Add cooldown check to the summarization trigger**

In the "Maybe summarize" section (around line 459-473), update the condition:

Replace:
```typescript
    // 7. Maybe summarize (async, non-blocking)
    // CR-AU: Skip compaction for heartbeat/cron — they're short-lived, compaction wastes tokens
    const isEphemeralLane = msg.lane === 'heartbeat' || msg.lane === 'cron';
    const tokenThreshold = this.deps.config.agent.tokenBudget * 0.75;
    if (!isEphemeralLane && (fullSession.messages.length > this.deps.config.agent.summarizationThreshold
        || sessionTokenEstimate > tokenThreshold)) {
      // Double-fire guard: skip if already summarizing this session (C2)
      if (this.summarizing.has(sessionKey)) {
        log.debug(`[${sessionKey}] Skipping summarization — already in progress`);
      } else {
        this.triggerSummarization(sessionKey, fullSession.messages, msg.user?.userId, msg.scope, sessionTokenEstimate).catch(err => {
          log.warn(`Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
```

With:
```typescript
    // 7. Maybe summarize (async, non-blocking)
    // CR-AU: Skip compaction for heartbeat/cron — they're short-lived, compaction wastes tokens
    const isEphemeralLane = msg.lane === 'heartbeat' || msg.lane === 'cron';
    const tokenThreshold = this.deps.config.agent.tokenBudget * 0.75;
    // Cooldown: minimum 10 minutes between summarizations for the same session.
    // Prevents rapid-fire summarization on active chats (100+ msgs/day was triggering
    // 8 summarizations in 2.5 days, each degrading the summary further).
    const SUMMARIZATION_COOLDOWN_MS = 10 * 60 * 1000;
    const lastSumTime = this.lastSummarizedAt.get(sessionKey) ?? 0;
    const cooldownElapsed = Date.now() - lastSumTime > SUMMARIZATION_COOLDOWN_MS;
    if (!isEphemeralLane && cooldownElapsed
        && (fullSession.messages.length > this.deps.config.agent.summarizationThreshold
            || sessionTokenEstimate > tokenThreshold)) {
      // Double-fire guard: skip if already summarizing this session (C2)
      if (this.summarizing.has(sessionKey)) {
        log.debug(`[${sessionKey}] Skipping summarization — already in progress`);
      } else {
        this.triggerSummarization(sessionKey, fullSession.messages, msg.user?.userId, msg.scope, sessionTokenEstimate).catch(err => {
          log.warn(`Summarization failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
```

- [ ] **Step 5: Record summarization time in triggerSummarization**

In `triggerSummarization` (around line 1163-1175), add timestamp recording after successful summarization:

Replace:
```typescript
  private async triggerSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    userId?: string,
    scope?: InboundMessage['scope'],
    preTokenEstimate?: number,
  ): Promise<void> {
    // Double-fire guard (C2)
    this.summarizing.add(sessionKey);
    try {
      await this.doSummarization(sessionKey, messages, userId, scope, preTokenEstimate);
    } finally {
```

With:
```typescript
  private async triggerSummarization(
    sessionKey: string,
    messages: LLMMessage[],
    userId?: string,
    scope?: InboundMessage['scope'],
    preTokenEstimate?: number,
  ): Promise<void> {
    // Double-fire guard (C2)
    this.summarizing.add(sessionKey);
    try {
      await this.doSummarization(sessionKey, messages, userId, scope, preTokenEstimate);
      this.lastSummarizedAt.set(sessionKey, Date.now());
    } finally {
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- tests/unit/summarization-cooldown.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Run full test suite**

Run: `npm test -- --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/agent/agent-loop.ts tests/unit/summarization-cooldown.test.ts
git commit -m "fix: add 10-minute cooldown between summarizations

Active chats (100+ msgs/day) were triggering summarization every 40 messages,
resulting in 8 cycles in 2.5 days. Each cycle degraded the summary further.
10-minute cooldown allows more messages to accumulate before summarizing,
producing higher-quality summaries with more context to preserve."
```

---

### Task 4: Increase summarization threshold

**Files:**
- Modify: `src/config/schema.ts:121`
- Modify: `src/commands/onboard.ts:36`

- [ ] **Step 1: Raise default summarizationThreshold from 40 to 80**

In `src/config/schema.ts`, line 121:

Replace:
```typescript
  summarizationThreshold: z.number().default(40),
```

With:
```typescript
  summarizationThreshold: z.number().default(80),
```

- [ ] **Step 2: Update onboard default to match**

In `src/commands/onboard.ts`, line 36:

Replace:
```typescript
    summarizationThreshold: 20,
```

With:
```typescript
    summarizationThreshold: 40,
```

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/config/schema.ts src/commands/onboard.ts
git commit -m "fix: raise summarization threshold 40→80 messages

At 40 messages, active chats triggered summarization every few hours.
At 80, more conversation context is available for the summarizer, producing
richer summaries. Combined with the cooldown, this reduces summarization
frequency by ~50% while keeping session size manageable."
```

---

### Task 5: Fix date/time visibility after summarization

**Files:**
- Modify: `src/agent/agent-loop.ts:1257-1263` (doSummarization — inject date into summary input)

The problem: after summarization, the agent doesn't trust the date in `<session>` and runs `exec(date /T)` to verify. The fix is to include current date/time in the summarization input so it's anchored in the summary itself.

- [ ] **Step 1: Add date context to summarization input**

In `src/agent/agent-loop.ts`, find where `conversationText` is built for summarization (around line 1241-1244). After building it, add a date header:

Replace:
```typescript
    const filtered = toSummarize.filter(m => m.role === 'user' || m.role === 'assistant');
    const conversationText = filtered.map(m => {
      const content = 'content' in m ? msg.content : '';
      return `${m.role}: ${typeof content === 'string' ? content : '[multimodal]'}`;
    }).join('\n');
```

With:
```typescript
    const filtered = toSummarize.filter(m => m.role === 'user' || m.role === 'assistant');
    const rawConversation = filtered.map(m => {
      const content = 'content' in m ? m.content : '';
      return `${m.role}: ${typeof content === 'string' ? content : '[multimodal]'}`;
    }).join('\n');
    // Anchor the summary with current date so temporal context survives summarization.
    const conversationText = `[Current date: ${localDateWithDay()}, time: ${localTimestamp()}]\n\n${rawConversation}`;
```

Note: `localDateWithDay` and `localTimestamp` are already imported at the top of context-builder.ts. Check if they're imported in agent-loop.ts — if not, add the import.

- [ ] **Step 2: Verify import exists**

Check if `localDateWithDay` and `localTimestamp` are imported in `agent-loop.ts`. If not, add to the existing date import line:

```typescript
import { localDateWithDay, localTimestamp } from '../utils/date.js';
```

- [ ] **Step 3: Run full test suite**

Run: `npm test -- --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "fix: anchor current date/time in summarization input

Agent was running exec(date /T) to check the time because the temporal
context was lost after summarization. Prepending current date/time to
the conversation text fed to the summarizer ensures the summary includes
absolute temporal markers."
```

---

### Task 6: Log summary length for monitoring

**Files:**
- Modify: `src/agent/agent-loop.ts` (doSummarization, after quality gate)

- [ ] **Step 1: Add summary length to log output**

After the quality gate (retry section from Task 2), before `await this.deps.sessions.summarize(...)`, add:

```typescript
    const finalTokens = Math.ceil(summary.length / 2.5);
    log.info(`[${sessionKey}] Summarization: summary length ${finalTokens} tokens (~${summary.length} chars)`);
```

- [ ] **Step 2: Run full test suite**

Run: `npm test -- --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No type errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent/agent-loop.ts
git commit -m "fix: log summary token length for monitoring

Adds explicit logging of summary length in tokens and chars after
summarization completes. Makes it easy to spot degraded summaries
in production logs (previous values were 12-57 tokens)."
```

---

### Task 7: Update janus.example.json if needed

**Files:**
- Check: `janus.example.json` — ensure `summarizationThreshold` default matches new value

- [ ] **Step 1: Check if janus.example.json has explicit summarizationThreshold**

Read `janus.example.json` and check if `summarizationThreshold` is specified. If it has the old value (40 or 20), update it to match the new default. If it's not specified (relies on schema default), no change needed.

- [ ] **Step 2: Commit if changed**

```bash
git add janus.example.json
git commit -m "chore: update example config with new summarization threshold"
```

---

## Summary of changes

| Fix | What | Token cost impact |
|-----|------|-------------------|
| Better prompts | Structured preservation of established facts, constraints | 0 — same prompt size, better output |
| Quality validation | Retry if summary < 200 tokens | +1 LLM call only when summary is too short |
| Cooldown | 10-minute gap between summarizations | Reduces total summarization calls by ~50% |
| Higher threshold | 80 messages instead of 40 | Slightly more tokens in session, fewer summarizations |
| Date anchoring | Current date/time in summarization input | +1 line of text in summarization input |
| Monitoring log | Summary length in tokens | 0 |

**Net effect:** Fewer summarization calls, each producing better output. Token cost per summarization stays same or slightly higher (retry), but total summarization token cost drops because there are fewer cycles.
