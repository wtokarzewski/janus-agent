import type { ContextualTool, ToolContext, RequestContext } from '../types.js';
import type { CronService, ScheduleKind } from '../../services/cron-service.js';

/**
 * cron tool — allows the agent to manage scheduled tasks.
 * Blocks add/update when called from within a cron job (cronDepth > 0).
 * Filters jobs by userId — users only see their own + system jobs (+ family in group chats).
 */
export class CronTool implements ContextualTool {
  name = 'cron';
  description = 'Manage scheduled tasks. Actions: list, add, update, remove, status, runs.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'update', 'remove', 'status', 'runs'],
        description: 'The action to perform.',
      },
      id: {
        type: 'string',
        description: 'Job ID (required for update, remove, status, runs).',
      },
      name: {
        type: 'string',
        description: 'Job name (required for add).',
      },
      schedule_kind: {
        type: 'string',
        enum: ['at', 'every', 'cron'],
        description: 'Schedule type: "at" (one-shot ISO timestamp), "every" (interval in ms), "cron" (5-field cron expression).',
      },
      schedule_value: {
        type: 'string',
        description: 'Schedule value matching the kind.',
      },
      schedule_tz: {
        type: 'string',
        description: 'IANA timezone for cron expressions (e.g. "Europe/Warsaw").',
      },
      task: {
        type: 'string',
        description: 'The task description/prompt for the agent to execute.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the job is enabled.',
      },
      user_id: {
        type: 'string',
        description: 'Owner user ID. For update: reassign job ownership. For add: override auto-detected userId.',
      },
      limit: {
        type: 'number',
        description: 'Limit for run history (default: 20).',
      },
    },
    required: ['action'],
  };

  private cronService: CronService;
  private cronDepth = 0;

  constructor(cronService: CronService) {
    this.cronService = cronService;
  }

  setContext(ctx: ToolContext): void {
    this.cronDepth = ctx.cronDepth ?? 0;
  }

  /** Check if the requesting user can access a specific job. */
  private canAccess(job: { userId: string | null }, reqCtx?: RequestContext): boolean {
    // System jobs (no userId) are visible to all
    if (!job.userId) return true;
    // No user context — deny access to user-owned jobs
    if (!reqCtx?.userId) return false;
    // Own job
    if (job.userId === reqCtx.userId) return true;
    // Family member's job (in family group chat)
    if (reqCtx.familyUserIds?.includes(job.userId)) return true;
    return false;
  }

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const action = String(args.action ?? '');

    // Recursion guard: block scheduling from within cron jobs
    if (this.cronDepth > 0 && (action === 'add' || action === 'update')) {
      return 'Error: Cannot schedule or modify cron jobs from within a cron job (recursion guard).';
    }

    switch (action) {
      case 'list': {
        const includeDisabled = args.include_disabled === true;
        // Listing is always scoped to own + system — no family exposure
        const jobs = this.cronService.listJobsForUser(
          reqCtx?.userId,
          undefined,
          includeDisabled,
        );
        // Compact format to avoid truncation with many jobs
        const compact = jobs.map(j => ({
          id: j.id,
          name: j.name,
          userId: j.userId,
          schedule: `${j.scheduleKind}:${j.scheduleValue}`,
          tz: j.scheduleTz,
          enabled: j.enabled,
          nextRunAt: j.nextRunAt,
        }));
        return JSON.stringify(compact, null, 2);
      }

      case 'add': {
        const name = String(args.name ?? '');
        const scheduleKind = String(args.schedule_kind ?? '') as ScheduleKind;
        const scheduleValue = String(args.schedule_value ?? '');
        const task = String(args.task ?? '');
        if (!name || !scheduleKind || !scheduleValue || !task) {
          return 'Error: add requires name, schedule_kind, schedule_value, and task.';
        }
        const job = this.cronService.addJob({
          name,
          scheduleKind,
          scheduleValue,
          scheduleTz: args.schedule_tz ? String(args.schedule_tz) : undefined,
          task,
          enabled: args.enabled !== false,
          userId: args.user_id ? String(args.user_id) : reqCtx?.userId,
        });
        return JSON.stringify(job, null, 2);
      }

      case 'update': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: update requires id.';
        const existing = this.cronService.getJob(id);
        if (!existing) return 'Error: Job not found.';
        if (!this.canAccess(existing, reqCtx)) return 'Error: Access denied — this job belongs to another user.';
        try {
          const patch: Record<string, unknown> = {};
          if (args.name !== undefined) patch.name = String(args.name);
          if (args.schedule_kind !== undefined) patch.scheduleKind = String(args.schedule_kind);
          if (args.schedule_value !== undefined) patch.scheduleValue = String(args.schedule_value);
          if (args.schedule_tz !== undefined) patch.scheduleTz = String(args.schedule_tz);
          if (args.task !== undefined) patch.task = String(args.task);
          if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
          if (args.user_id !== undefined) patch.userId = String(args.user_id);
          const job = this.cronService.updateJob(id, patch);
          return JSON.stringify(job, null, 2);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'remove': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: remove requires id.';
        const existing = this.cronService.getJob(id);
        if (!existing) return 'Error: Job not found.';
        if (!this.canAccess(existing, reqCtx)) return 'Error: Access denied — this job belongs to another user.';
        this.cronService.removeJob(id);
        return 'Job removed.';
      }

      case 'status': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: status requires id.';
        const job = this.cronService.getJob(id);
        if (!job) return 'Error: Job not found.';
        if (!this.canAccess(job, reqCtx)) return 'Error: Access denied — this job belongs to another user.';
        return JSON.stringify(job, null, 2);
      }

      case 'runs': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: runs requires id.';
        const job = this.cronService.getJob(id);
        if (!job) return 'Error: Job not found.';
        if (!this.canAccess(job, reqCtx)) return 'Error: Access denied — this job belongs to another user.';
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const runs = this.cronService.getRunHistory(id, limit);
        return JSON.stringify(runs, null, 2);
      }

      default:
        return `Error: Unknown action "${action}". Use: list, add, update, remove, status, runs.`;
    }
  }
}
