# Cron Targets Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `target_user_id` with a multi-target model (owner + targets array with per-target status tracking), remove recursion guard, fix context injection, update known_users.

**Architecture:** New `targets` JSON column on cron_jobs (migration 13). Owner never changes. Targets is always an array at runtime (legacy null normalized on read). Per-target status (pending/confirmed/rejected). Auto-disable at code level when all user targets responded. Group chat targets are broadcast-only.

**Tech Stack:** TypeScript, SQLite (migration 13), Zod, vitest

**Spec:** `docs/superpowers/specs/2026-04-02-cron-targets-overhaul-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/services/cron-service.ts` | CronTarget type, targets on CronJob/CronJobInput, addJob/updateJob with targets, auto-disable on full response, startup migration, recompute stale nextRunAt |
| `src/tools/builtin/cron.ts` | New targets param, remove recursion guard, user/channel validation, backward compat target_user_id, updated canAccess (target view+remove-self), list filtering for targets |
| `src/db/migrations.ts` | Migration 13: add targets column |
| `src/context/context-builder.ts` | known_users with full channel info |
| `src/agent/agent-loop.ts` | Multi-target context injection, status summary |
| `src/prompts/cron/cron-context-injection.md` | Rewritten prompt with per-target instructions |
| `src/prompts/cron/param-target-user-id.md` | Deprecated notice |
| `tests/unit/cron-service.test.ts` | Targets, auto-disable, startup migration tests |
| `tests/unit/cron-tool.test.ts` | Targets validation, access control, backward compat tests |

---

### Task 1: CronTarget type + migration 13

**Files:**
- Modify: `src/services/cron-service.ts` (types section, lines 20-61)
- Modify: `src/db/migrations.ts` (add migration 13)

- [ ] **Step 1: Add CronTarget type and update CronJob/CronJobInput**

In `src/services/cron-service.ts`, add after the `ScheduleKind` type (line 20):

```typescript
export interface CronTarget {
  userId?: string;
  chatId?: string;
  channel?: string;
  status: 'pending' | 'confirmed' | 'rejected';
  statusAt?: string;
}
```

Add to `CronJobInput`:
```typescript
targets?: CronTarget[];
```

Add to `CronJob`:
```typescript
targets: CronTarget[];
```

- [ ] **Step 2: Add migration 13**

In `src/db/migrations.ts`, add to the `migrations` array:

```typescript
// Migration 13: targets array for multi-user cron delivery
`
ALTER TABLE cron_jobs ADD COLUMN targets TEXT;
`,
```

- [ ] **Step 3: Update rowToJob to parse targets**

In `rowToJob()`, add targets parsing with legacy null normalization:

```typescript
targets: r.targets ? JSON.parse(String(r.targets)) as CronTarget[] : [],
```

Note: empty array `[]` for null — will be materialized with owner on read in service methods.

- [ ] **Step 4: Update addJob to store targets**

In `addJob()`, store targets JSON. Update the INSERT to include targets column:

```typescript
const targetsJson = input.targets?.length ? JSON.stringify(input.targets) : null;
```

Add `targets` to the INSERT statement and `.run(...)` arguments.

- [ ] **Step 5: Update updateJob to handle targets patch**

In `updateJob()`, add targets handling in the patch:

```typescript
if (patch.targets !== undefined) {
  updates.push('targets = ?');
  values.push(patch.targets.length ? JSON.stringify(patch.targets) : null);
}
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 7: Run tests**

Run: `npm test`

---

### Task 2: Remove recursion guard

**Files:**
- Modify: `src/tools/builtin/cron.ts` (lines 104-107)

- [ ] **Step 1: Delete the recursion guard**

Remove these lines from `execute()`:

```typescript
// Recursion guard: block scheduling from within cron jobs
if (this.cronDepth > 0 && (action === 'add' || action === 'update')) {
  return 'Error: Cannot schedule or modify cron jobs from within a cron job (recursion guard).';
}
```

Update the class JSDoc comment (line 7) to remove mention of blocking add/update.

- [ ] **Step 2: Run tests**

Run: `npm test`
Expected: cron-tool tests that relied on recursion guard may need updating.

- [ ] **Step 3: Fix any failing tests**

If any test expected the recursion guard error, update it to expect success instead.

---

### Task 3: known_users with full channel info

**Files:**
- Modify: `src/context/context-builder.ts` (lines 71-75)
- Test: `tests/unit/context-builder.test.ts`

- [ ] **Step 1: Update known_users format**

Change the `known_users` section from:

```typescript
const userLines = this.deps.config.users.map(u => `- ${u.id} (${u.name})`);
```

To:

```typescript
const userLines = this.deps.config.users.map(u => {
  const channels = u.identities
    ?.map(i => `${i.channel}:${i.channelUserId}`)
    .join(', ') ?? '';
  return `- ${u.id} (${u.name})${channels ? ` channels: ${channels}` : ''}`;
});
```

- [ ] **Step 2: Run tests**

Run: `npm test`

---

### Task 4: Cron tool — new targets parameter, validation, backward compat

**Files:**
- Modify: `src/tools/builtin/cron.ts`

- [ ] **Step 1: Add targets parameter to tool definition**

In `parameters.properties`, add:

```typescript
targets: {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Target user ID from <known_users>' },
      chatId: { type: 'string', description: 'Target group chat ID' },
      channel: { type: 'string', description: 'Delivery channel (e.g. telegram). Defaults to requester channel if omitted.' },
    },
  },
  description: 'Array of delivery targets. Each target needs userId (for users) or chatId (for groups). If omitted, owner is auto-added as target.',
},
```

- [ ] **Step 2: Add config reference for user validation**

The CronTool constructor needs access to config for user/channel validation. Add:

```typescript
private config?: JanusConfig;

constructor(cronService: CronService, config?: JanusConfig) {
  this.cronService = cronService;
  this.config = config;
}
```

Update where CronTool is instantiated (check tool-registry or bootstrap).

- [ ] **Step 3: Rewrite `add` action with targets support**

Replace the `add` case in `execute()`. Key logic:

1. Parse `targets` from args (JSON array or undefined)
2. Handle backward compat: if `target_user_id` is set, convert to `targets: [{ userId: value, status: 'pending' }]`
3. If no targets provided: auto-materialize owner: `targets: [{ userId: reqCtx.userId, status: 'pending' }]`
4. Validate each target:
   - `userId` must exist in `config.users` — error if not: "User 'bob' not found. Known users: wojtek, monika, zuzia"
   - Channel resolution: if target has explicit `channel`, verify user has identity on that channel. If no channel, use requester's channel (from `reqCtx`). If user doesn't have matching channel, error with available channels.
5. Set `status: 'pending'` on all targets
6. Owner = `reqCtx.userId`, never transfers
7. Add task annotation: `[Created by: {owner}. Targets: {list}]`
8. Pass targets to `cronService.addJob()`

- [ ] **Step 4: Update `update` action for targets**

Add handling for `targets` in the update patch. The agent sends updated targets array (with status changes):

```typescript
if (args.targets !== undefined) {
  patch.targets = (args.targets as CronTarget[]).map(t => ({
    ...t,
    status: t.status ?? 'pending',
  }));
}
```

- [ ] **Step 5: Update `remove` action for target self-reject**

When a target user (not the owner) calls remove: instead of deleting the job, set their status to `rejected`:

```typescript
case 'remove': {
  const id = String(args.id ?? '');
  if (!id) return 'Error: remove requires id.';
  const existing = this.cronService.getJob(id);
  if (!existing) return 'Error: Job not found.';

  // Target self-reject: if caller is a target but not the owner, reject self instead of deleting
  if (reqCtx?.userId && existing.userId !== reqCtx.userId) {
    const targets = existing.targets;
    const targetIdx = targets.findIndex(t => t.userId === reqCtx.userId);
    if (targetIdx >= 0) {
      targets[targetIdx].status = 'rejected';
      targets[targetIdx].statusAt = new Date().toISOString();
      this.cronService.updateJob(id, { targets });
      return `Your status set to "rejected" for job "${existing.name}". Owner will be notified.`;
    }
  }

  if (!this.canAccess(existing, reqCtx)) return 'Error: Access denied.';
  this.cronService.removeJob(id);
  return 'Job removed.';
}
```

- [ ] **Step 6: Update canAccess for target visibility**

Add target access check:

```typescript
private canAccess(job: { userId: string | null; chatId: string | null; targets?: CronTarget[] }, reqCtx?: RequestContext): boolean {
  // ... existing checks ...
  // Target can access their targeted jobs
  if (reqCtx?.userId && job.targets?.some(t => t.userId === reqCtx.userId)) return true;
  return false;
}
```

- [ ] **Step 7: Update list action for target privacy**

When listing jobs, if the user is a target but not the owner, show limited info (no task text):

```typescript
const compact = jobs.map(j => {
  const isOwner = j.userId === reqCtx?.userId;
  const isTarget = j.targets.some(t => t.userId === reqCtx?.userId);
  return {
    id: j.id,
    name: j.name,
    userId: j.userId,
    schedule: `${j.scheduleKind}:${j.scheduleValue}`,
    tz: j.scheduleTz,
    enabled: j.enabled,
    nextRunAt: j.nextRunAt,
    targets: j.targets,
    // Only show task preview to owner, not to targets (privacy)
    ...(isOwner || (!isTarget) ? { taskPreview: j.task.split('\n')[0].slice(0, 120) } : {}),
  };
});
```

- [ ] **Step 8: Run typecheck and tests**

Run: `npx tsc --noEmit && npm test`

---

### Task 5: Auto-disable on full response + stale nextRunAt recompute

**Files:**
- Modify: `src/services/cron-service.ts` (executeJob, start)

- [ ] **Step 1: Add auto-disable check in executeJob**

In `executeJob()`, BEFORE the `publishInbound` call, add:

```typescript
// Auto-disable when all user targets have responded
const targets = job.targets;
const userTargets = targets.filter(t => t.userId);
if (userTargets.length > 0 && userTargets.every(t => t.status !== 'pending')) {
  this.db.db.prepare('UPDATE cron_jobs SET enabled = 0 WHERE id = ?').run(job.id);
  log.info(`Cron: auto-disabled job "${job.name}" — all user targets responded`);
  // TODO: publish notification to owner (via bus)
  this.runningJobs.delete(job.id);
  return; // skip LLM call
}
```

- [ ] **Step 2: Add stale nextRunAt recompute on startup**

In `start()`, after `backfillHeartbeatUserIds()`, add:

```typescript
this.recomputeStaleNextRunAt();
```

Add the method:

```typescript
/** Recompute nextRunAt for recurring jobs where it's in the past (stale after restart/deploy). */
private recomputeStaleNextRunAt(): void {
  const now = new Date();
  const jobs = this.listJobs();
  let updated = 0;
  for (const job of jobs) {
    if (job.scheduleKind === 'at') continue;
    if (!job.nextRunAt) continue;
    if (new Date(job.nextRunAt) >= now) continue;
    const fresh = this.computeNextRun(job);
    if (fresh) {
      this.db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?').run(fresh, job.id);
      updated++;
    }
  }
  if (updated > 0) {
    log.info(`Cron: recomputed stale nextRunAt for ${updated} job(s)`);
  }
}
```

- [ ] **Step 3: Add startup migration for legacy target_user_id jobs**

In `start()`, after `recomputeStaleNextRunAt()`:

```typescript
this.migrateTargetUserIdJobs();
```

```typescript
/** Best-effort migration: convert old target_user_id-style jobs to new targets format. */
private migrateTargetUserIdJobs(): void {
  const jobs = this.listJobs(true); // include disabled
  let migrated = 0;
  for (const job of jobs) {
    if (job.targets.length > 0) continue; // already has targets
    const match = job.task.match(/\[Requested by user: (\w+)/);
    if (match) {
      const requesterId = match[1];
      const targets: CronTarget[] = [{ userId: job.userId!, status: 'pending' }];
      this.db.db.prepare('UPDATE cron_jobs SET user_id = ?, targets = ? WHERE id = ?')
        .run(requesterId, JSON.stringify(targets), job.id);
      migrated++;
    }
  }
  if (migrated > 0) {
    log.info(`Cron: migrated ${migrated} legacy target_user_id job(s) to targets format`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`

---

### Task 6: Multi-target context injection

**Files:**
- Modify: `src/agent/agent-loop.ts` (injectTargetSessionContext)
- Modify: `src/prompts/cron/cron-context-injection.md`
- Modify: `src/prompts/cron/param-target-user-id.md`

- [ ] **Step 1: Rewrite cron-context-injection.md**

```markdown
[Cron job: {{name}}] (id: {{jobId}})
Created by: {{owner}}

Target status:
{{targetStatus}}

{{recentMessages}}

INSTRUCTIONS:
- If a pending target confirmed the task (e.g. "done", "ok", "zrobione", "gotowe"),
  call cron update to set that target's status to "confirmed"
- If a pending target rejected (e.g. "cancel", "stop", "nie chcę", "nie"),
  call cron update to set that target's status to "rejected" and notify the owner
- Only send reminders to PENDING targets, never to confirmed or rejected ones
- Use the channel from <known_users> to reach each target
- The job ID for cron update is shown in parentheses above
- Job lifecycle (disable after all responded) is handled automatically — do NOT call cron remove
```

- [ ] **Step 2: Update param-target-user-id.md**

```markdown
DEPRECATED — use `targets` parameter instead. `target_user_id` is still accepted for backward compatibility and will be converted to targets: [{ userId: value }].

The `targets` parameter accepts an array of recipients: [{ userId: "wojtek" }, { userId: "zuzia" }]. Each target must be a known user from <known_users>. Channel defaults to the requester's channel.
```

- [ ] **Step 3: Rewrite injectTargetSessionContext for multi-target**

Replace the method to:
1. Read targets from the cron job (extract job ID from message content, look up in DB)
2. Build status summary line
3. For each pending user target (max 3): inject last 5 messages from their DM session
4. If >3 pending: summary only
5. Log warning instead of silent null on profile lookup failure

The job ID is in the message content as `(id: {uuid})`. Parse it to look up the job.

```typescript
private async injectTargetSessionContext(msg: InboundMessage, agentId: string): Promise<string | null> {
  // Extract job ID from message content
  const jobIdMatch = typeof msg.content === 'string' ? msg.content.match(/\(id: ([a-f0-9-]+)\)/) : null;
  if (!jobIdMatch) {
    // Fallback to old behavior for non-target jobs
    return this.injectOwnerSessionContext(msg, agentId);
  }

  const jobId = jobIdMatch[1];
  const job = this.deps.cronService?.getJob(jobId);
  if (!job || !job.targets.length) {
    return this.injectOwnerSessionContext(msg, agentId);
  }

  const targets = job.targets;
  const userTargets = targets.filter(t => t.userId);
  const pendingTargets = userTargets.filter(t => t.status === 'pending');

  // Build status summary
  const statusLines = targets.map(t => {
    const id = t.userId ?? t.chatId ?? 'unknown';
    return `- ${id}: ${t.status}${t.statusAt ? ` (${t.statusAt})` : ''}`;
  }).join('\n');

  // Inject recent messages from pending targets (max 3 targets, 5 msgs each)
  let recentMessages = '';
  const injectTargets = pendingTargets.slice(0, 3);
  for (const target of injectTargets) {
    if (!target.userId) continue;
    const profile = findUserProfile(target.userId, this.deps.config);
    const identity = profile?.identities.find(i => i.channelUserId);
    if (!identity) {
      recentMessages += `\n--- Cannot read session for ${target.userId} — profile or identity not found ---\n`;
      log.warn(`Cron context injection: cannot resolve session for user ${target.userId}`);
      continue;
    }
    const sessionKey = this.deps.agentResolver
      ? this.deps.agentResolver.resolveSessionKey(agentId, { ...msg, channel: identity.channel, chatId: identity.channelUserId })
      : `${agentId}:${identity.channel}:${identity.channelUserId}`;
    try {
      const history = await this.deps.sessions.getHistory(sessionKey);
      const textMsgs = history
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-5);
      if (textMsgs.length > 0) {
        recentMessages += `\n--- Recent messages from ${target.userId} ---\n`;
        recentMessages += textMsgs.map(m => `${m.role}: ${String(m.content).slice(0, 300)}`).join('\n');
        recentMessages += `\n--- End ---\n`;
      }
    } catch {
      recentMessages += `\n--- Cannot read session for ${target.userId} ---\n`;
    }
  }

  if (pendingTargets.length > 3) {
    recentMessages += `\n(${pendingTargets.length - 3} more pending targets — messages not shown)\n`;
  }

  return loadPrompt('cron/cron-context-injection', {
    name: job.name,
    jobId: job.id,
    owner: job.userId ?? 'system',
    targetStatus: statusLines,
    recentMessages,
  });
}
```

Also add a private helper `injectOwnerSessionContext` that contains the old logic (for self-reminder jobs without targets).

- [ ] **Step 4: Add cronService dependency to agent-loop**

The agent loop needs access to CronService to look up jobs. Check if `this.deps` already has it — if not, add:

```typescript
// In AgentLoopDeps interface:
cronService?: CronService;
```

And wire it in bootstrap.

- [ ] **Step 5: Run typecheck and tests**

Run: `npx tsc --noEmit && npm test`

---

### Task 7: Tests for targets model

**Files:**
- Modify: `tests/unit/cron-service.test.ts`
- Modify: `tests/unit/cron-tool.test.ts`

- [ ] **Step 1: Add cron-service tests**

```typescript
describe('targets', () => {
  it('stores and retrieves targets on job', () => {
    const job = svc.addJob({
      name: 'multi-target',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'remind',
      targets: [
        { userId: 'wojtek', status: 'pending' },
        { userId: 'zuzia', status: 'pending' },
      ],
    });
    expect(job.targets).toHaveLength(2);
    expect(job.targets[0].userId).toBe('wojtek');
    expect(job.targets[0].status).toBe('pending');
  });

  it('normalizes null targets to empty array', () => {
    const job = svc.addJob({
      name: 'no-targets',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'remind',
    });
    expect(job.targets).toEqual([]);
  });

  it('updates target status', () => {
    const job = svc.addJob({
      name: 'status-test',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'remind',
      targets: [{ userId: 'wojtek', status: 'pending' }],
    });
    const updated = svc.updateJob(job.id, {
      targets: [{ userId: 'wojtek', status: 'confirmed', statusAt: new Date().toISOString() }],
    });
    expect(updated.targets[0].status).toBe('confirmed');
  });

  it('auto-disables when all user targets responded', async () => {
    // Create job with targets all confirmed, verify executeJob auto-disables
  });

  it('excludes group chat targets from auto-disable check', async () => {
    // Job with user target confirmed + group target pending: should still auto-disable
  });

  it('recomputes stale nextRunAt on startup', () => {
    // Create job with nextRunAt in the past, call recomputeStaleNextRunAt, verify updated
  });
});
```

- [ ] **Step 2: Add cron-tool tests**

```typescript
describe('targets validation', () => {
  it('rejects unknown userId in targets', async () => {
    const result = await tool.execute({
      action: 'add', name: 'test', schedule_kind: 'every', schedule_value: '60000',
      task: 'remind', targets: [{ userId: 'nonexistent' }],
    }, reqCtx);
    expect(result).toContain('not found');
  });

  it('auto-materializes owner when no targets provided', async () => {
    const result = await tool.execute({
      action: 'add', name: 'self', schedule_kind: 'every', schedule_value: '60000',
      task: 'remind',
    }, reqCtx);
    const job = JSON.parse(result);
    expect(job.targets).toHaveLength(1);
    expect(job.targets[0].userId).toBe(reqCtx.userId);
  });

  it('converts legacy target_user_id to targets', async () => {
    const result = await tool.execute({
      action: 'add', name: 'legacy', schedule_kind: 'every', schedule_value: '60000',
      task: 'remind', target_user_id: 'wojtek',
    }, reqCtx);
    const job = JSON.parse(result);
    expect(job.targets[0].userId).toBe('wojtek');
  });

  it('target remove sets status to rejected, not delete', async () => {
    // Create job, then call remove as target user, verify job still exists with status=rejected
  });

  it('owner remove deletes entire job', async () => {
    // Create job, call remove as owner, verify job deleted
  });
});
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`

---

### Task 8: Final integration + typecheck

- [ ] **Step 1: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 2: Run full test suite**

Run: `npm test`

- [ ] **Step 3: Fix any issues**

- [ ] **Step 4: Verify backward compatibility**

Check that existing heartbeat jobs (no targets) still work. Check that existing exercise cron jobs still fire.
