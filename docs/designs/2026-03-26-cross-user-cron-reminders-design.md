# Cross-User Cron Reminders

## Problem

When User A asks Janus to remind User B about something, the system fails in multiple ways:

1. **Session isolation** — Cron jobs run in isolated sessions (`cron:{jobId}`). User B's replies go to their main session (`main:telegram:{chatId}`). The cron agent never sees confirmations like "done".
2. **No cross-user visibility** — Cron jobs are owned by the creator. The target user can't see, manage, or cancel reminders aimed at them.
3. **No job ID in cron context** — The cron agent doesn't know its own job ID, so it can't self-remove even if it detects completion.
4. **No feedback loop** — The requester doesn't know when the task is confirmed or rejected by the target.

The result: infinite reminder spam that the target user cannot stop, and the requester must manually intervene.

## Design

### Core Principle

Any user can create a reminder targeting another user. The target is notified immediately and has full control (can view, cancel). The cron agent sees the target's responses and can self-remove on confirmation. The requester is notified of the outcome.

### Flow

```
User A: "Remind User B about X every 5 min until confirmed"
    |
    v
Janus (A's session): cron add with target_user_id=B
    |
    +---> Cron created with userId=B, task includes [Requested by: A]
    +---> Agent notifies B: "A set up a reminder for you: X, every 5 min"
    +---> Agent notifies A: "Reminder set for B. I'll let you know when confirmed."
    |
    v
Cron fires (every 5 min):
    |
    +---> Context injection: last N messages from B's primary session
    +---> Agent checks: did B confirm?
    |       |
    |       +-- No  --> Send reminder to B
    |       +-- Yes --> cron remove (self) + message A: "B confirmed"
    |
    v
B can also manually cancel --> message A: "B cancelled the reminder"
```

### Scenarios

| Scenario | `target_user_id` | `chat_id` | Delivery | Context source |
|---|---|---|---|---|
| A reminds B in DM | B | — | B's DM | B's DM session |
| A reminds B in group | B | group | Group chat | Group session |
| Reminder for group | — | group | Group chat | Group session |
| Self-reminder | — | — | Own DM | Own DM session |

All four scenarios benefit from context injection. Session isolation is a general problem, not specific to cross-user reminders.

### Access Control

When listing cron jobs, a user sees:
- Their own jobs (`userId` matches)
- System jobs (no `userId`, no `chatId`)
- Group chat jobs (if in the same group)
- Family members' jobs (if `familyUserIds` context is available)

When a cron is created with `target_user_id`, `userId` is set to the target. The target sees it as their own job and has full control.

## Technical Changes

### 1. Cron tool: `target_user_id` parameter

**File:** `src/tools/builtin/cron.ts`

Add optional `target_user_id` parameter to the cron tool schema. When provided on `add`:

- Set `userId` to `target_user_id` instead of `reqCtx.userId`
- Append `[Requested by: {reqCtx.userId}]` to the task text
- Include instruction in tool response: notify target user and requester

```typescript
// In 'add' action:
const effectiveUserId = args.target_user_id
  ? String(args.target_user_id)
  : (args.user_id === 'system' ? undefined : (args.user_id ? String(args.user_id) : reqCtx?.userId));

if (args.target_user_id && reqCtx?.userId) {
  task += `\n\n[Requested by user: ${reqCtx.userId}. Notify them when the task is confirmed or cancelled.]`;
}
```

Update tool description to guide the LLM:
- When asked to remind another user, use `target_user_id`
- After creating, notify the target and requester via `message` tool

### 2. Job ID in cron execution context

**File:** `src/services/cron-service.ts`

Include the job ID in the cron execution message so the agent can call `cron remove`:

```typescript
// Line ~324, change:
content: `[Cron job: ${job.name}] (${localTimestamp()})\n\n${job.task}`,
// To:
content: `[Cron job: ${job.name}] (id: ${job.id}) (${localTimestamp()})\n\n${job.task}`,
```

The recursion guard blocks `cron add`/`update` from within cron jobs, but `remove` is allowed. The agent can self-remove when the task is complete.

### 3. Context injection for cron sessions

**File:** `src/agent/agent-loop.ts` (in `processMessage`)

When processing a cron job message (`cronDepth > 0`), inject recent messages from the target user's primary session:

**Resolution logic:**
1. If the cron message has `chatId` that doesn't start with `cron:` or `heartbeat` (i.e. a real group chat ID) → source session = `{agentId}:{registeredChannel}:{chatId}`
2. Else if the cron message has `user.userId` → look up user profile → find primary identity → source session = `{agentId}:{channel}:{channelUserId}`
3. Otherwise → no injection

**Injection:**
- Fetch last 10 messages from the source session via `SessionManager.getHistory()`
- Format as a context block prepended to the cron task content:

```
[Recent messages from target user's conversation:]
user: zrobione
assistant: Super, dywanik ogarnięty!
[End of recent messages]

[Cron job: Reminder] (id: abc-123) (2026-03-26 12:00)

Remind about the rug...
```

**Boundaries:**
- Only inject if source session exists and has messages
- Limit to last 10 messages to avoid token bloat
- Strip tool_use/tool_result messages (only user/assistant content)

### 4. Fix: `familyUserIds` in cron list

**File:** `src/tools/builtin/cron.ts`

Pass `familyUserIds` from request context to `listJobsForUser`:

```typescript
// Line ~103, change:
const jobs = this.cronService.listJobsForUser(
  reqCtx?.userId,
  undefined,          // <-- bug: always undefined
  includeDisabled,
  reqCtx?.chatId,
);
// To:
const jobs = this.cronService.listJobsForUser(
  reqCtx?.userId,
  reqCtx?.familyUserIds,
  includeDisabled,
  reqCtx?.chatId,
);
```

This is a separate fix for family group chat visibility, independent of the `target_user_id` mechanism.

## Testing

- Unit test: cron tool with `target_user_id` sets correct `userId` and appends `[Requested by]`
- Unit test: cron execution message includes job ID
- Unit test: context injection resolves correct source session for DM, group, and self-reminder scenarios
- Unit test: `listJobsForUser` with `familyUserIds` returns family members' jobs
- Integration test: full cross-user reminder flow (create → fire → context injection → self-remove)

## Out of Scope

- Rate limiting on cross-user reminders (can be added later if abuse is a concern)
- UI for managing reminders (current text-based interaction is sufficient)
- Approval flow (rejected in favor of immediate creation + notification + user control)
