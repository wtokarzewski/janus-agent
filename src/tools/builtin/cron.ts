import type { ContextualTool, ToolContext, RequestContext } from '../types.js';
import type { CronService, ScheduleKind, CronTarget } from '../../services/cron-service.js';
import type { JanusConfig } from '../../config/schema.js';
import { loadPrompt } from '../../prompts/loader.js';

/**
 * cron tool — allows the agent to manage scheduled tasks.
 * Filters jobs by userId — users see their own + system + family members' jobs.
 * Cross-user reminders via targets array (owner = requester, targets tracked separately).
 * Backward compat: target_user_id converted to targets[].
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
        enum: ['at', 'delay', 'every', 'cron'],
        description: loadPrompt('cron/param-schedule-kind'),
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
        description: 'Owner user ID. For update: reassign job ownership. For add: override auto-detected userId. Use "system" for system-wide jobs (no owner).',
      },
      target_user_id: {
        type: 'string',
        description: loadPrompt('cron/param-target-user-id'),
      },
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
      chat_id: {
        type: 'string',
        description: 'Target group chat ID for group-scoped jobs. Response will be sent to this chat instead of a specific user.',
      },
      not_before: {
        type: 'string',
        description: 'ISO timestamp — job will not fire before this time even if schedule matches. Use for "start from X" patterns (e.g. user says "every hour 8-20 but today from 12:00").',
      },
      limit: {
        type: 'number',
        description: 'Limit for run history (default: 20).',
      },
    },
    required: ['action'],
  };

  private cronService: CronService;
  private config?: JanusConfig;

  constructor(cronService: CronService, config?: JanusConfig) {
    this.cronService = cronService;
    this.config = config;
  }

  setContext(_ctx: ToolContext): void {
    // No-op — cronDepth recursion guard removed in favor of targets model
  }

  /** Check if the requesting user can access a specific job. */
  private canAccess(job: { userId: string | null; chatId: string | null; targets?: CronTarget[] }, reqCtx?: RequestContext): boolean {
    // System jobs (no userId, no chatId) are visible to all
    if (!job.userId && !job.chatId) return true;
    // Group chat jobs — accessible if user is in the same chat
    if (job.chatId && reqCtx?.chatId === job.chatId) return true;
    // No user context — deny access to user-owned jobs
    if (!reqCtx?.userId) return false;
    // Own job
    if (job.userId === reqCtx.userId) return true;
    // Family member's job (in family group chat)
    if (job.userId && reqCtx.familyUserIds?.includes(job.userId)) return true;
    // Target can access their targeted jobs
    if (reqCtx.userId && job.targets?.some(t => t.userId === reqCtx.userId)) return true;
    return false;
  }

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const action = String(args.action ?? '');

    switch (action) {
      case 'list': {
        const includeDisabled = args.include_disabled === true;
        // Family members see each other's reminders (cross-user reminders, heartbeats).
        // Privacy: job task is truncated to preview — full task requires 'status' action.
        const jobs = this.cronService.listJobsForUser(
          reqCtx?.userId,
          reqCtx?.familyUserIds,
          includeDisabled,
          reqCtx?.chatId,
        );
        // Target jobs included via SQL LIKE in listJobsForUser
        // Compact format to avoid truncation with many jobs
        const compact = jobs.map(j => {
          const isOwner = j.userId === reqCtx?.userId;
          const isTarget = j.targets.some(t => t.userId === reqCtx?.userId);
          // Targets only see their own entry, not other targets
          const visibleTargets = isOwner || (!isTarget)
            ? j.targets
            : j.targets.filter(t => t.userId === reqCtx?.userId);
          return {
            id: j.id,
            name: j.name,
            userId: j.userId,
            chatId: j.chatId,
            schedule: `${j.scheduleKind}:${j.scheduleValue}`,
            tz: j.scheduleTz,
            enabled: j.enabled,
            nextRunAt: j.nextRunAt,
            targets: visibleTargets,
            // Only show task preview to owner, not to targets (privacy)
            ...(isOwner || (!isTarget) ? { taskPreview: j.task.split('\n')[0].slice(0, 120) } : {}),
          };
        });
        return JSON.stringify(compact, null, 2);
      }

      case 'add': {
        const name = String(args.name ?? '');
        let scheduleKind = String(args.schedule_kind ?? '') as ScheduleKind | 'delay';
        let scheduleValue = String(args.schedule_value ?? '');
        let task = String(args.task ?? '');
        if (!name || !scheduleKind || !scheduleValue || !task) {
          return 'Error: add requires name, schedule_kind, schedule_value, and task.';
        }
        // Convert delay (ms from now) → at (ISO timestamp) — no timezone confusion
        if (scheduleKind === 'delay') {
          const delayMs = parseInt(scheduleValue, 10);
          if (isNaN(delayMs) || delayMs <= 0) {
            return 'Error: delay schedule_value must be a positive number of milliseconds.';
          }
          scheduleKind = 'at';
          scheduleValue = new Date(Date.now() + delayMs).toISOString();
        }

        // Build targets array
        let targets: CronTarget[] = [];
        const rawTargets = args.targets as Array<{ userId?: string; chatId?: string; channel?: string }> | undefined;
        const targetUserId = args.target_user_id ? String(args.target_user_id) : undefined;

        if (rawTargets?.length) {
          targets = rawTargets.map(t => ({
            ...t,
            status: 'pending' as const,
          }));
        } else if (targetUserId) {
          // Backward compat: convert target_user_id to targets
          targets = [{ userId: targetUserId, status: 'pending' as const }];
        } else if (reqCtx?.userId) {
          // Auto-materialize owner as target (self-reminder)
          targets = [{ userId: reqCtx.userId, status: 'pending' as const }];
        }

        // Default channel for targets without explicit channel
        if (this.config?.users && reqCtx?.userId) {
          const requesterProfile = this.config.users.find(u => u.id === reqCtx.userId);
          const defaultChannel = requesterProfile?.identities?.[0]?.channel;
          if (defaultChannel) {
            for (const t of targets) {
              if (t.userId && !t.channel) {
                t.channel = defaultChannel;
              }
            }
          }
        }

        // Validate user targets
        if (this.config?.users && targets.length > 0) {
          const knownUserIds = this.config.users.map(u => u.id);
          for (const t of targets) {
            if (t.userId && !knownUserIds.includes(t.userId)) {
              return `Error: User '${t.userId}' not found. Known users: ${knownUserIds.join(', ')}`;
            }
          }
          // Channel validation: if explicit channel set, verify target has identity on that channel
          for (const t of targets) {
            if (t.userId && t.channel) {
              const userProfile = this.config.users.find(u => u.id === t.userId);
              if (userProfile && !userProfile.identities?.some(i => i.channel === t.channel)) {
                const available = userProfile.identities?.map(i => i.channel).join(', ') || 'none';
                return `Error: User '${t.userId}' is not on ${t.channel}. Available channels: ${available}`;
              }
            }
          }
        }

        // Owner is always the requester
        const owner = args.user_id === 'system' ? undefined : (args.user_id ? String(args.user_id) : reqCtx?.userId);

        // Task annotation for cross-user jobs (targets != just owner)
        const isCrossUser = targets.some(t => t.userId && t.userId !== owner);
        if (isCrossUser && owner) {
          const targetList = targets.map(t => t.userId ?? t.chatId ?? 'unknown').join(', ');
          task += `\n\n[Created by: ${owner}. Targets: ${targetList}]`;
        }

        // Inject recent conversation context so cron job knows what the user was talking about
        if (reqCtx?.recentMessages?.length) {
          const context = reqCtx.recentMessages.join('\n');
          task += `\n\n[Conversation context when this job was created:\n${context}\n]`;
        }

        const job = this.cronService.addJob({
          name,
          scheduleKind,
          scheduleValue,
          scheduleTz: args.schedule_tz ? String(args.schedule_tz) : undefined,
          task,
          enabled: args.enabled !== false,
          userId: owner,
          chatId: args.chat_id ? String(args.chat_id) : undefined,
          notBefore: args.not_before ? String(args.not_before) : undefined,
          targets,
        });

        // Cross-user notification (backward compat _action_required)
        if (isCrossUser && reqCtx?.userId) {
          const result = JSON.parse(JSON.stringify(job));
          result._action_required = loadPrompt('cron/cross-user-action-required', {
            targetUserId: targets.map(t => t.userId).filter(Boolean).join(', '),
            name,
            requesterId: reqCtx.userId,
          });
          return JSON.stringify(result, null, 2);
        }

        return JSON.stringify(job, null, 2);
      }

      case 'update': {
        const id = String(args.id ?? '');
        if (!id) return 'Error: update requires id.';
        const existing = this.cronService.getJob(id);
        if (!existing) return 'Error: Job not found.';
        // Targets can view but NOT update — only owner and system (cron agent) can update
        if (reqCtx?.userId && existing.userId !== reqCtx.userId && existing.userId !== null) {
          return 'Error: Access denied — only the job owner can update.';
        }
        if (!this.canAccess(existing, reqCtx)) return 'Error: Access denied — this job belongs to another user.';
        try {
          const patch: Record<string, unknown> = {};
          if (args.name !== undefined) patch.name = String(args.name);
          if (args.schedule_kind !== undefined) patch.scheduleKind = String(args.schedule_kind);
          if (args.schedule_value !== undefined) patch.scheduleValue = String(args.schedule_value);
          if (args.schedule_tz !== undefined) patch.scheduleTz = String(args.schedule_tz);
          if (args.task !== undefined) patch.task = String(args.task);
          if (args.enabled !== undefined) patch.enabled = Boolean(args.enabled);
          if (args.user_id !== undefined) patch.userId = args.user_id === 'system' ? null : String(args.user_id);
          if (args.chat_id !== undefined) patch.chatId = String(args.chat_id);
          if (args.not_before !== undefined) patch.notBefore = args.not_before ? String(args.not_before) : null;
          if (args.targets !== undefined) {
            patch.targets = (args.targets as CronTarget[]).map(t => ({
              ...t,
              status: t.status ?? 'pending',
            }));
          }
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

        // Target self-reject: if caller is a target but not the owner, reject self
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

        // Privacy: targets see limited info (no task text, only own target entry)
        const isOwner = job.userId === reqCtx?.userId;
        const isTarget = !isOwner && job.targets.some(t => t.userId === reqCtx?.userId);
        if (isTarget) {
          return JSON.stringify({
            id: job.id,
            name: job.name,
            userId: job.userId,
            schedule: `${job.scheduleKind}:${job.scheduleValue}`,
            scheduleTz: job.scheduleTz,
            enabled: job.enabled,
            nextRunAt: job.nextRunAt,
            targets: job.targets.filter(t => t.userId === reqCtx?.userId),
          }, null, 2);
        }

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
