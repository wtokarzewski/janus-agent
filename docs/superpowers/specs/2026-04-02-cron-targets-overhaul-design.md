# Cron Targets Overhaul — Design Spec

**Date:** 2026-04-02
**Status:** Draft

## Problem Statement

Cross-user cron reminders don't work. Three interconnected failures:

1. **Agent never uses `target_user_id`** — creates jobs owned by requester, hardcodes target's chat_id in task text, uses `message` tool to deliver. Target user can't see, manage, or cancel the job. Context injection reads requester's session, never sees target's confirmation. Spam continues indefinitely.

2. **Recursion guard blocks legitimate operations** — cron jobs can't update or create other cron jobs. A "restore schedule" cron job couldn't update exercise schedules, leaving `nextRunAt` stale.

3. **Self-cancellation never worked** — even with proper `target_user_id`, the prompt is too vague ("act accordingly"), context injection silently fails when user identity is missing, and `<known_users>` doesn't expose channel/chat_id info needed to notify the requester.

## Design

### New targets model

**Owner** (`userId`) — who created the job. Never changes. Used for: job visibility in lists, notifications about status/completion.

**Targets** — always an array at runtime, never null. Self-reminders materialize owner as target. This keeps one code path for all scenarios. Legacy DB rows may have `targets: null` — normalized on read to `[{ userId: owner, status: 'pending' }]`.

```typescript
interface CronTarget {
  userId?: string;    // for user targets
  chatId?: string;    // for group chat targets (broadcast only, no status tracking)
  channel?: string;   // optional, defaults to requester's channel
  status: 'pending' | 'confirmed' | 'rejected';
  statusAt?: string;  // ISO timestamp of confirmation/rejection
}
```

Stored as JSON in a new `targets` column on `cron_jobs`.

**Scenarios:**
- Self-reminder: `targets: [{ userId: 'wojtek', status: 'pending' }]` (owner as target)
- One target: `targets: [{ userId: 'wojtek', status: 'pending' }]`
- Multiple: `targets: [{ userId: 'wojtek', status: 'pending' }, { userId: 'zuzia', status: 'pending' }]`
- Group chat: `targets: [{ chatId: '-100groupid', status: 'pending' }]` (broadcast — no status transitions)
- Mixed: `targets: [{ userId: 'wojtek', status: 'pending' }, { chatId: '-100groupid', status: 'pending' }]`

**Group chat targets:** Broadcast only. Status stays `pending` always — no one "confirms" for a group. `status` and `statusAt` fields are ignored for `chatId` targets. Group chat targets are excluded from the auto-disable check. Auto-disable triggers when all USER targets (those with `userId`) have status != `pending`. When auto-disable fires, group chat broadcasts stop too — the job is done.

**Channel resolution:**
- If `channel` specified on target: use it
- If omitted: default to the channel the requester used when creating the job
- If target user doesn't have an identity on that channel: return error with list of available channels
- If target has no identities at all: return error: "User 'wojtek' has no messaging channels configured"

### Migration 13

```sql
ALTER TABLE cron_jobs ADD COLUMN targets TEXT;
```

### Startup migration for existing jobs

On `CronService.start()`, best-effort conversion of old-format jobs:
- Jobs with task annotation `[Requested by user: X]`: extract requester from annotation as owner, create `targets` array with the current `userId` as target, status `pending`
- Jobs without annotation: leave `targets` as null (legacy behavior, no change)
- Log warning for any jobs that couldn't be parsed

This is best-effort, not guaranteed. Old jobs with hardcoded chat_id in task text (no annotation) are left as-is — cleanup is a separate task.

### Cron tool changes

**`add` action:**
- New parameter `targets` (JSON array of `{ userId?, chatId?, channel? }`)
- `target_user_id` deprecated but accepted — converted to `targets: [{ userId: value, status: 'pending' }]`
- If no `targets` provided: auto-materialize owner as target: `targets: [{ userId: reqCtx.userId, status: 'pending' }]`
- Validation: each `userId` must exist in `config.users`. Error if not found: "User 'bob' not found. Known users: wojtek, monika, zuzia"
- Channel validation: if explicit `channel` set, verify target has identity on that channel. If target doesn't have requester's default channel, return error: "User 'wojtek' is not on WhatsApp. Available channels: telegram"
- Owner = `reqCtx.userId` (requester), never transfers
- Task annotation: `[Created by: {owner}. Targets: {userId1}, {userId2}]`

**`update` action:**
- Can update `targets` array (set `status: 'confirmed'` or `status: 'rejected'` on individual targets)
- Allowed from cron context (recursion guard removed)
- Target users can NOT update — only owner and cron agent can modify targets

**`remove` action:**
- Allowed from cron context (unchanged)
- Owner calls remove: deletes the entire job
- Target calls remove: does NOT delete the job — sets their own status to `rejected` and notifies owner. This prevents one target from cancelling a reminder for everyone.

**Access control (`canAccess`):**
- Owner: full access (list with full details, update, remove entire job)
- Target userId: limited view + remove-self only
  - View: sees job name, schedule, own status. Does NOT see task text (may contain private info from owner) or other targets
  - Remove: sets own status to `rejected`, does NOT delete the job
- Target can NOT update (can't change other targets, schedule, or task)
- Family members: view only (existing behavior)

### Remove recursion guard

Delete the `cronDepth` check that blocks `add` and `update` (cron.ts line 105). Keep `cronDepth` field itself — still used for context injection trigger. Existing safety mechanisms handle runaway loops: `MAX_ITERATIONS=200`, cross-tool loop detection (6-call pattern window), per-lane concurrency limits.

### `<known_users>` with full profiles

Current format: `- wojtek (Wojtek)`

New format:
```
- wojtek (Wojtek) channels: telegram:6209059349
- monika (Monika) channels: telegram:8490468579
- zuzia (Zuzia) channels: telegram:8719751387
```

Agent sees channel + chat_id for every user. Can send messages without guessing. Can verify whether a user exists and what channels they use.

### Context injection on cron fire

When a job with targets fires:

1. Read targets from job. Separate user targets (`userId`) from group chat targets (`chatId`).
2. If all USER targets have status != `pending`: auto-disable job, publish completion notification to owner with per-target summary, skip LLM call. Group chat targets do not affect this check.
3. For pending user targets (max 3): inject last 5 messages from each pending target's DM session.
4. If more than 3 pending user targets: inject summary only ("Pending: wojtek, zuzia, janek, ola. No recent messages injected due to count.")
5. Add status summary: `"Confirmed: zuzia (2026-04-02 14:30). Rejected: none. Pending: wojtek. Group broadcast: -100groupid."`
6. Inject via updated `cron-context-injection.md` prompt.

For self-reminders (owner is the only target): inject from owner's DM session (same as current behavior).

Silent failure fix: if `findUserProfile` returns undefined for a target, log warning and include in injection: `"Warning: cannot read session for user '{userId}' — profile or identity not found."` instead of silently returning null.

**Mixed user + group targets:** When all user targets respond, the job auto-disables. Group chat targets stop receiving broadcasts at that point too — the job is done. If the owner wants a persistent group broadcast independent of user confirmations, they create a separate job targeting only the group.

### Auto-disable on full response

In `executeJob()`, before publishing to agent:

```typescript
const targets = job.targets ? JSON.parse(job.targets) as CronTarget[] : [];
const userTargets = targets.filter(t => t.userId); // exclude group chat targets
if (userTargets.length > 0 && userTargets.every(t => t.status !== 'pending')) {
  this.db.db.prepare('UPDATE cron_jobs SET enabled = 0 WHERE id = ?').run(job.id);
  // publish completion notification to owner with per-target status
  return; // skip LLM call
}
```

Code-level guarantee — doesn't depend on LLM following prompt instructions. Triggers when all USER targets have responded (confirmed OR rejected). Group chat targets (broadcast) are excluded from this check.

**Edge case: jobs with only group chat targets** never auto-disable (no user targets to track). These must be manually removed by the owner.

**Rejected targets are excluded from delivery**, same as confirmed. Only `pending` targets receive reminders.

### Strengthened cron-context-injection prompt

```
[Cron job: {name}] (id: {jobId})
Created by: {owner}

Target status:
{for each target: - userId/chatId: status (timestamp if responded)}

{For each pending target (max 3):
--- Recent messages from {userId} ---
{last 5 messages}
--- End ---
}

INSTRUCTIONS:
- If a pending target confirmed the task (e.g. "done", "ok", "zrobione", "gotowe"),
  call cron update to set that target's status to "confirmed"
- If a pending target rejected (e.g. "cancel", "stop", "nie chcę", "nie"),
  call cron update to set that target's status to "rejected" and notify the owner
- Only send reminders to PENDING targets, never to confirmed or rejected ones
- Use the channel from <known_users> to reach each target
- The job ID for cron update is shown in parentheses above
- Job lifecycle (disable after all responded) is handled automatically by the system — do NOT call cron remove yourself
```

### AGENTS.md scheduling guidance

Scheduling section already updated with date verification, conflict checking, rotation patterns, not_before, nextRunAt verification. Verify it's current after implementation.

### Backward compatibility

- `target_user_id` parameter: deprecated, still accepted, silently converted to `targets: [{ userId: value, status: 'pending' }]`
- `canAccess()`: owner has full access. Target's userId can view + remove only
- Old jobs with `target_user_id` in DB: startup migration converts (best-effort)
- Old jobs with hardcoded chat_id in task text: left as-is, separate cleanup task
- Jobs with `targets: null` in DB (pre-migration): treated as self-reminder to owner

---

## Files affected

| File | Change |
|------|--------|
| `src/db/migrations.ts` | Migration 13: add `targets` column |
| `src/services/cron-service.ts` | `CronTarget` type, startup migration, auto-disable on full response, targets in addJob/updateJob/getJob/rowToJob, recompute stale nextRunAt on startup |
| `src/tools/builtin/cron.ts` | New `targets` param, remove recursion guard, channel/user validation, auto-materialize owner as target, backward compat for `target_user_id`, updated canAccess for target view+remove |
| `src/agent/agent-loop.ts` | Updated context injection for multi-target (max 3 pending, 5 msgs each), status summary, silent failure fix with warning |
| `src/context/context-builder.ts` | `<known_users>` with full channel info |
| `src/prompts/cron/cron-context-injection.md` | Rewritten with explicit per-target instructions |
| `src/prompts/cron/param-target-user-id.md` | Deprecated notice, point to `targets` |
| `tests/unit/cron-service.test.ts` | New tests for targets, auto-disable, startup migration, stale nextRunAt |
| `tests/unit/cron-tool.test.ts` | New tests for targets validation, channel resolution, access control, backward compat |

## Testing

| Scenario | Test |
|----------|------|
| Self-reminder | Auto-materializes owner as target, delivers to owner |
| Single target | Injects target's session, delivers to target |
| Multiple targets | Injects pending sessions (max 3, 5 msgs each), skips non-pending |
| Target confirms | Agent updates status to confirmed, stops sending to that target |
| Target rejects | Agent updates status to rejected, notifies owner |
| All user targets responded | Auto-disable at code level, notify owner with per-target summary |
| Group chat target | Broadcast only, status stays pending, excluded from auto-disable check |
| Mixed user + group targets | Auto-disable when all USER targets responded, group still gets broadcasts until disabled |
| Unknown user in targets | Error: "User 'bob' not found. Known users: ..." |
| Channel mismatch | Error: "User 'wojtek' not on WhatsApp. Available: telegram" |
| No channels configured | Error: "User 'wojtek' has no messaging channels configured" |
| Channel default | Uses requester's channel when target.channel omitted |
| Legacy target_user_id | Converted to targets array with status pending |
| Legacy targets null in DB | Normalized on read to [{ userId: owner, status: pending }] |
| Recursion guard removed | Cron job can add/update/remove other cron jobs |
| Target access: view | Target can see job in their list |
| Target calls remove | Sets own status to rejected, does NOT delete entire job |
| Owner calls remove | Deletes entire job |
| Target access: update denied | Target cannot modify targets/schedule/task |
| Cron updates target status | Status persists across runs in DB |
| Startup migration | Old jobs with annotation converted best-effort, warning logged for failures |
| known_users format | Shows channel:chatId for each user |
| Context injection failure | Logs warning, includes message in prompt |
| Many pending targets (>3) | Summary only, no raw messages |
| Stale nextRunAt on startup | Recomputed for recurring jobs with nextRunAt in the past |
