# Context Management Overhaul — Design Spec

**Date:** 2026-04-01
**Status:** Draft

## Problem Statement

Agent becomes unusable during tool-heavy conversations. Observed failures:

1. **Lost user instructions** — forgot "start from 12:00" after several tool calls
2. **Cron fired 2h early** — user said "start today from 12:00", cron fired at 10:00
3. **Wrong day calculation** — called April 4 "Friday" when it's Saturday, argued 3 times
4. **No conflict awareness** — scheduled exercises during tire appointment without warning
5. **Wrong rotation pattern** — created 3 cron jobs instead of 1 hourly with rotation

## Root Causes

**A. Fixed message count limit (50) causes context loss.** Each tool call = 2 messages. After 25 tool calls, user instructions disappear. Trimming treats user messages and tool results equally.

**B. No date computation help.** LLMs can't reliably compute day-of-week.

**C. No `not_before` on cron.** Job fires at next matching time from NOW, ignoring user's intended start.

**D. No scheduling guidance.** No rules about verifying dates, checking conflicts, planning before acting.

---

## Configuration

All context management parameters are configurable in `janus.json` under `agent.context`. Defaults are set in the Zod schema — users don't need to add anything to their config, but can override any value. All new fields documented in `janus.example.json`.

Values that are ratios (0.0–1.0) scale automatically with the model's context window — switching from a 1M model to a 200K model adjusts all thresholds proportionally.

```json
{
  "agent": {
    "contextWindow": 1000000,
    "tokenBudget": 750000,
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
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `keepRecentTokens` | 20000 | Tokens of recent messages to keep verbatim after compaction |
| `reserveTokens` | 20000 | Headroom reserved for model output |
| `toolResultMaxShare` | 0.3 | Max share of context window for a single tool result at persist time |
| `toolResultHardMax` | 400000 | Absolute char cap per tool result regardless of window size |
| `softTrimChars` | 4000 | Char limit for soft-trimmed tool results (head 1.5K + tail 1.5K + marker) |
| `compactionThresholds` | [0.75, 0.80, 0.85] | Budget ratios triggering phases 1 (soft-trim), 2 (hard-clear), 3 (drop turns) |
| `emergencyThreshold` | 0.95 | Budget ratio triggering emergency compression (no protected tail) |
| `protectedTailTurns` | 3 | Number of most recent assistant turns immune from compaction phases 1-2 |

---

## Design

### 1. Token-only context management

Remove `maxMessages` entirely. No message count limit. Context is managed exclusively by token budget through a multi-layer system.

#### Layer 1: Tool result cap at persist time

In `append()`, cap each tool result at `toolResultMaxShare` of context window (default 30%, dynamic — scales with model). Hard max `toolResultHardMax` (default 400K chars). Use smart head+tail truncation — keep first 70% + last 30% of the cap so error output at the end is preserved.

Applied once at write time. Prevents a single massive tool result from dominating the session.

#### Layer 2: Graduated context compaction before each LLM call

New function `enforceContextBudget(messages, config)` replaces `trimHistoryToTokenBudget()` and `pruneOldToolResults()`.

Protected tail: last `protectedTailTurns` (default 3) assistant messages + their associated tool results are immune from phases 1-2.

User messages are **NEVER** modified or removed by any phase. Messages before the first user message are never touched.

```
Phase 1 — Soft-trim old tool results (trigger: compactionThresholds[0], default 75%):
  Outside protected tail, truncate tool result content to softTrimChars (default 4K)
  using head+tail (1.5K + 1.5K + "[trimmed]"). Oldest first. Stop when under threshold.

Phase 2 — Hard-clear old tool results (trigger: compactionThresholds[1], default 80%):
  Replace tool result content with "[tool result cleared]".
  Oldest first, outside protected tail. Stop when under threshold.

Phase 3 — Drop complete turns (trigger: compactionThresholds[2], default 85%):
  Remove oldest assistant message + its tool results as a group.
  Never drop user messages. Stop when under threshold.
```

Turn boundary safety: assistant + its tool results always handled as a group, never split.

#### Layer 3: Emergency compression (improved)

At `emergencyThreshold` (default 95%), same phases 1-3 but without protected tail (everything except user messages eligible). If still over, keep system prompt + all user messages + last 2 complete turns.

Same turn-aware logic for error-triggered and timeout-triggered compression (replaces current "drop first half of everything").

#### What gets deleted:
- `maxMessages` parameter from `getHistory()` (`session-manager.ts:110`)
- `trimHistoryToTokenBudget()` (`agent-loop.ts:1283-1312`)
- `pruneOldToolResults()` (`agent-loop.ts:1319-1329`)
- Old emergency compression logic (`agent-loop.ts:684-689, 735-738, 747-749`)

### 2. Structured summarization with iterative merge

Replace free-form summarization with rigid template and iterative merging.

**Initial summarization prompt:**

```
Summarize this conversation for context continuity. Use EXACTLY this template.
Write "None" for empty sections. Never skip a section.

## Goal
[Core user intent]

## Constraints & Preferences
[User-stated constraints: times, dates, names, quantities, conditions, exceptions.
Quote exact words for critical constraints.]

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
[MUST NOT be lost: exact times, names, dates, addresses, identifiers, exceptions.
Preserve user's exact words for scheduling constraints.]

## Identifiers
[Preserve verbatim: job IDs, file paths, URLs, user IDs, UUIDs, calendar event IDs]
```

**Iterative merge:** When previous summary exists, send it in `<previous-summary>` tags with UPDATE prompt:
- PRESERVE all existing information
- ADD new progress and decisions
- UPDATE Progress section (move items between Done/InProgress)
- NEVER remove Critical Context unless explicitly superseded by user
- MERGE Identifiers (append new, keep existing)

**Input filtering:** Only `user` and `assistant` messages go to the summarization LLM call. Tool results are excluded — they add noise without semantic value for summarization.

**Retention:** Walk backwards from end of session counting tokens. Keep `keepRecentTokens` (default 20K) of recent messages. Snap cut point to nearest user message boundary (never cut mid-turn).

**Quality check:** After summarization, verify:
- All required sections present
- Critical Context non-empty if conversation had scheduling/timing content
- Identifiers section preserves UUIDs/paths/IDs from conversation
- If check fails, regenerate once with feedback about what's missing.

**Pre-compaction memory flush:** Existing `flushMemory()` already runs before summarization — keep this.

### 3. Date verification guidance in AGENTS.md

No changes to system prompt. Instead, add a rule to AGENTS.md:

```markdown
### Date verification
- Never compute day-of-week mentally — LLMs are unreliable at this.
- When you need to know what day a date falls on, use exec: `date -d "2026-04-04" +%A`
- When you need to find the date of "next Friday" etc., use exec: `date -d "next Friday" +%Y-%m-%d`
- Always verify before creating calendar events or scheduling.
```

Zero extra tokens in the system prompt. Agent verifies only when needed.

### 4. `not_before` on cron jobs

- New field `notBefore` on `CronJobInput` and `CronJob`
- New column `not_before` in `cron_jobs` (migration 12)
- `computeNextRun()`: for `cron` kind, loop `cron.nextRun()` until result is after `notBefore`
- `onTimer()`: skip job if `now < notBefore`
- New cron tool parameter `not_before`: "ISO timestamp — job will not fire before this time even if schedule matches. Use for 'start from X' patterns."
- `rowToJob()`, `addJob()`, `updateJob()` handle the new field

### 5. AGENTS.md scheduling guidance

Add to Scheduling section:

```markdown
### Before scheduling:
1. **Verify dates** — never compute day-of-week mentally. Use the "Upcoming" line in
   your context. For dates >7 days ahead, use exec with `date` to verify.
2. **Check for conflicts** — look at the user's calendar (if available) and existing
   cron jobs for the same time window. If conflict, inform user before proceeding.
3. **Plan first** — for complex schedules (rotations, multiple items, exceptions),
   present the full plan with specific dates/times to user BEFORE creating any jobs.

### Rotation pattern:
- Use ONE recurring job with rotation logic in the task, not multiple separate jobs.
- Example task: "Exercise rotation: current Warsaw hour mod 3 determines exercise.
  0=suwanie, 1=dociskanie, 2=przetaczanie. 10 reps."

### "Today exception" pattern:
- When recurring schedule should start later today, use `not_before` parameter.
- Example: cron `0 8-20 * * *` with not_before today at 12:00 — today starts at 12,
  tomorrow at 8 as normal.

### After creating a job:
- Verify `nextRunAt` in the response matches user intent.
- If it doesn't, fix immediately.
```

---

## Implementation Order

All changes ship together as one PR.

1. `src/config/schema.ts` — add `agent.context` schema with defaults
2. `janus.example.json` — document all new fields
3. `session-manager.ts` — remove `maxMessages`, add dynamic tool result cap in `append()`, change `summarize()` to token-based retention with user message boundary snapping
4. `agent-loop.ts` — delete old functions, add `enforceContextBudget()`, update emergency compression, structured summarization with iterative merge and input filtering
5. `src/prompts/summarization/` — initial + update prompt files
6. DB migration 12 + `cron-service.ts` + `cron.ts` — `not_before`
7. `src/prompts/cron/param-schedule-kind.md` — document `not_before`
8. `AGENTS.md` — scheduling guidance + date verification rule

---

## What Gets Deleted

| Code | Location | Reason |
|------|----------|--------|
| `maxMessages` parameter | `session-manager.ts:110` | Replaced by token-based budget |
| `trimHistoryToTokenBudget()` | `agent-loop.ts:1283-1312` | Replaced by `enforceContextBudget()` |
| `pruneOldToolResults()` | `agent-loop.ts:1319-1329` | Replaced by graduated compaction |
| Old emergency compression | `agent-loop.ts:684-689, 735-738, 747-749` | Replaced by turn-aware compression |
| Free-form summarization prompt | `agent-loop.ts:1155` | Replaced by structured template |
| `keepCount = 4` retention | `session-manager.ts:129`, `agent-loop.ts:1131` | Replaced by `keepRecentTokens` |

---

## Testing

| Change | Tests |
|--------|-------|
| Config schema | New: `agent.context` validates, defaults applied, ratios scale with contextWindow |
| No maxMessages | Existing session tests updated — getHistory returns all messages |
| Dynamic tool result cap | New: > 30% context window truncated with head+tail; <= cap untouched; hard max 400K; scales with contextWindow |
| enforceContextBudget | New: phase 1 soft-trims oldest tool results; phase 2 hard-clears; phase 3 drops turns; user messages NEVER touched; protected tail immune; turn boundaries respected; respects config thresholds |
| Emergency compression | New: turn-aware, protects user messages, drops assistant+tool groups |
| Structured summarization | New: all sections present; iterative merge preserves previous; Critical Context preserved; identifiers preserved |
| Input filtering | New: only user+assistant in summarization input; tool messages excluded |
| Token retention | New: keeps ~keepRecentTokens from end; cuts at user message boundary |
| Quality check | New: regenerates if Critical Context empty on scheduling conversations |
| Date verification | Manual: agent uses exec to verify dates when scheduling |
| not_before | New: computeNextRun advances past not_before; onTimer skips; ISO with offset |
| janus.example.json | Verify all new fields documented |
| AGENTS.md | Manual scheduling scenarios |
