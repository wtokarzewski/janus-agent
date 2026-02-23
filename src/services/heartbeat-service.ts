import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MessageBus } from '../bus/message-bus.js';
import type { JanusConfig } from '../config/schema.js';
import type { CronService } from './cron-service.js';
import * as log from '../utils/logger.js';

export interface HeartbeatTask {
  name: string;
  description: string;
  intervalMs: number;
  lastRun: number;
  scheduleKind: 'every' | 'cron';
  scheduleValue: string;
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * HeartbeatService — reads HEARTBEAT.md, sends periodic system messages to the bus.
 *
 * If a CronService is provided, tasks are synced to cron_jobs table and
 * CronService handles scheduling. Otherwise falls back to in-memory timers.
 *
 * Format:
 * ## Task Name
 * - schedule: every 30m
 * - task: Description of what to do
 *
 * Also supports cron expressions:
 * - schedule: 0 9 * * 1-5
 */
export class HeartbeatService {
  private bus: MessageBus;
  private config: JanusConfig;
  private heartbeatPath: string;
  private tasks: HeartbeatTask[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private cronService: CronService | null;

  constructor(opts: { bus: MessageBus; config: JanusConfig; workspaceDir: string; cronService?: CronService }) {
    this.bus = opts.bus;
    this.config = opts.config;
    this.heartbeatPath = resolve(opts.workspaceDir, 'HEARTBEAT.md');
    this.cronService = opts.cronService ?? null;
  }

  async start(signal: AbortSignal): Promise<void> {
    await this.loadTasks();

    if (this.tasks.length === 0) {
      log.info('Heartbeat: no tasks found in HEARTBEAT.md');
      return;
    }

    // If CronService is available, sync tasks there and let it handle scheduling
    if (this.cronService) {
      for (const task of this.tasks) {
        this.cronService.upsertByName({
          name: `heartbeat:${task.name}`,
          scheduleKind: task.scheduleKind,
          scheduleValue: task.scheduleValue,
          task: task.description,
          enabled: true,
        });
      }
      log.info(`Heartbeat: synced ${this.tasks.length} task(s) to CronService`);
      return;
    }

    // Fallback: in-memory timer-based scheduling
    log.info(`Heartbeat: loaded ${this.tasks.length} task(s), checking every ${this.config.heartbeat.checkIntervalMs}ms`);

    const check = () => {
      if (signal.aborted) return;
      this.checkDueTasks(signal).catch(err => {
        log.warn(`Heartbeat check error: ${err instanceof Error ? err.message : String(err)}`);
      });
    };

    // Initial check
    check();

    this.timer = setInterval(check, this.config.heartbeat.checkIntervalMs);

    // Cleanup on abort
    signal.addEventListener('abort', () => {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      log.info('Heartbeat: stopped');
    }, { once: true });
  }

  private async loadTasks(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.heartbeatPath, 'utf-8');
    } catch {
      log.debug('Heartbeat: HEARTBEAT.md not found');
      return;
    }

    this.tasks = parseHeartbeatMd(content);
  }

  private async checkDueTasks(signal: AbortSignal): Promise<void> {
    const now = Date.now();

    for (const task of this.tasks) {
      if (signal.aborted) break;
      // Only 'every' tasks work with in-memory fallback; cron tasks require CronService
      if (task.scheduleKind !== 'every') continue;

      const elapsed = now - task.lastRun;
      if (elapsed >= task.intervalMs) {
        task.lastRun = now;
        log.info(`Heartbeat: firing task "${task.name}"`);

        await this.bus.publishInbound({
          id: `heartbeat-${Date.now()}`,
          channel: 'system',
          chatId: 'heartbeat',
          content: `[Heartbeat task: ${task.name}]\n\n${task.description}`,
          author: 'system',
          timestamp: new Date(),
        }, signal).catch(err => {
          log.warn(`Heartbeat: failed to publish task "${task.name}": ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }
}

const CRON_EXPR_RE = /^[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+$/;

export function parseHeartbeatMd(content: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const name = lines[0].trim();
    if (!name) continue;

    let scheduleRaw = '';
    let description = '';

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      const scheduleMatch = trimmed.match(/^-?\s*schedule:\s*(.+)$/i);
      const taskMatch = trimmed.match(/^-?\s*task:\s*(.+)$/i);

      if (scheduleMatch) {
        scheduleRaw = scheduleMatch[1].trim();
      }
      if (taskMatch) {
        description = taskMatch[1].trim();
      }
    }

    if (!scheduleRaw || !description) {
      log.debug(`Heartbeat: skipping task "${name}" — missing schedule or task`);
      continue;
    }

    // Parse 'every Xm/h/d' or cron expression
    const everyMatch = scheduleRaw.match(/^every\s+(\d+)([mhd])$/i);
    if (everyMatch) {
      const amount = parseInt(everyMatch[1], 10);
      const unit = everyMatch[2].toLowerCase();
      const intervalMs = amount * (UNIT_MS[unit] ?? 60_000);

      tasks.push({
        name,
        description,
        intervalMs,
        lastRun: 0,
        scheduleKind: 'every',
        scheduleValue: String(intervalMs),
      });
    } else if (CRON_EXPR_RE.test(scheduleRaw)) {
      tasks.push({
        name,
        description,
        intervalMs: 0,
        lastRun: 0,
        scheduleKind: 'cron',
        scheduleValue: scheduleRaw,
      });
    } else {
      log.debug(`Heartbeat: unrecognized schedule format for "${name}": ${scheduleRaw}`);
    }
  }

  return tasks;
}
