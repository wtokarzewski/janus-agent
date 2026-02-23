import type { Tool } from '../types.js';
import type { CronService, ScheduleKind } from '../../services/cron-service.js';

/**
 * cron tool — allows the agent to manage scheduled tasks.
 */
export class CronTool implements Tool {
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
      limit: {
        type: 'number',
        description: 'Limit for run history (default: 20).',
      },
    },
    required: ['action'],
  };

  private cronService: CronService;

  constructor(cronService: CronService) {
    this.cronService = cronService;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '');

    switch (action) {
      case 'list': {
        const jobs = this.cronService.listJobs(true);
        return JSON.stringify(jobs, null, 2);
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
        });
        return JSON.stringify(job, null, 2);
      }

      case 'update': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: update requires id.';
        try {
          const patch: Record<string, unknown> = {};
          if (args.name !== undefined) patch.name = String(args.name);
          if (args.schedule_kind !== undefined) patch.scheduleKind = String(args.schedule_kind);
          if (args.schedule_value !== undefined) patch.scheduleValue = String(args.schedule_value);
          if (args.schedule_tz !== undefined) patch.scheduleTz = String(args.schedule_tz);
          if (args.task !== undefined) patch.task = String(args.task);
          if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
          const job = this.cronService.updateJob(id, patch);
          return JSON.stringify(job, null, 2);
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      case 'remove': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: remove requires id.';
        this.cronService.removeJob(id);
        return 'Job removed.';
      }

      case 'status': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: status requires id.';
        const job = this.cronService.getJob(id);
        return job ? JSON.stringify(job, null, 2) : 'Error: Job not found.';
      }

      case 'runs': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: runs requires id.';
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        const runs = this.cronService.getRunHistory(id, limit);
        return JSON.stringify(runs, null, 2);
      }

      default:
        return `Error: Unknown action "${action}". Use: list, add, update, remove, status, runs.`;
    }
  }
}
