import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MessageBus } from '../bus/message-bus.js';
import type { JanusConfig } from '../config/schema.js';
import type { CronService } from './cron-service.js';
import * as log from '../utils/logger.js';
import { localTimestamp, getTimezone } from '../utils/date.js';

export interface HeartbeatTask {
  name: string;
  description: string;
  intervalMs: number;
  lastRun: number;
  scheduleKind: 'every' | 'cron';
  scheduleValue: string;
  scheduleTz?: string;
  userId?: string;
  agentId?: string;
  chatId?: string;
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
  private workspaceDir: string;
  private heartbeatPath: string;
  private tasks: HeartbeatTask[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private cronService: CronService | null;
  private lastSignature = '';

  constructor(opts: { bus: MessageBus; config: JanusConfig; workspaceDir: string; cronService?: CronService }) {
    this.bus = opts.bus;
    this.config = opts.config;
    this.workspaceDir = opts.workspaceDir;
    this.heartbeatPath = resolve(opts.workspaceDir, 'HEARTBEAT.md');
    this.cronService = opts.cronService ?? null;
  }

  async start(signal: AbortSignal): Promise<void> {
    // If CronService is available, sync tasks there and let it handle scheduling.
    // Re-sync on HEARTBEAT.md edits via mtime polling (fs.watch is unreliable
    // cross-platform) — previously edits required a full restart to take effect.
    if (this.cronService) {
      this.lastSignature = await this.filesSignature();
      const complete = await this.loadTasks();
      this.syncToCron(complete);

      const resyncMs = this.config.heartbeat.resyncIntervalMs;
      if (resyncMs > 0) {
        this.resyncTimer = setInterval(() => {
          this.resync().catch(err => {
            log.warn(`Heartbeat resync error: ${err instanceof Error ? err.message : String(err)}`);
          });
        }, resyncMs);
        signal.addEventListener('abort', () => {
          if (this.resyncTimer) {
            clearInterval(this.resyncTimer);
            this.resyncTimer = null;
          }
        }, { once: true });
      }
      return;
    }

    await this.loadTasks();

    if (this.tasks.length === 0) {
      log.info('Heartbeat: no tasks found');
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

  /** All HEARTBEAT.md paths this service watches: global + per-user + per-agent. */
  private heartbeatPaths(): Array<{ path: string; userId?: string; agentId?: string }> {
    const paths: Array<{ path: string; userId?: string; agentId?: string }> = [
      { path: this.heartbeatPath },
    ];
    for (const user of this.config.users) {
      paths.push({ path: resolve(this.workspaceDir, '.janus', 'users', user.id, 'HEARTBEAT.md'), userId: user.id });
    }
    for (const agent of this.config.agents) {
      const agentHbPath = agent.heartbeatFile
        ? resolve(this.workspaceDir, agent.heartbeatFile)
        : resolve(this.workspaceDir, '.janus', 'agents', agent.id, 'HEARTBEAT.md');
      paths.push({ path: agentHbPath, agentId: agent.id });
    }
    return paths;
  }

  /** Combined mtime signature of all HEARTBEAT.md files — cheap change detection. */
  private async filesSignature(): Promise<string> {
    const parts: string[] = [];
    for (const entry of this.heartbeatPaths()) {
      try {
        const s = await stat(entry.path);
        parts.push(`${entry.path}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${entry.path}:absent`);
      }
    }
    return parts.join('|');
  }

  /** Reload HEARTBEAT.md files and re-sync to CronService if any file changed. */
  async resync(): Promise<void> {
    if (!this.cronService) return;
    const sig = await this.filesSignature();
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    log.info('Heartbeat: HEARTBEAT.md change detected, re-syncing');
    const complete = await this.loadTasks();
    this.syncToCron(complete);
  }

  /**
   * Upsert all loaded tasks as cron jobs. When the load was complete (no
   * unexpected read errors), also disable heartbeat-derived jobs whose section
   * was removed from HEARTBEAT.md — so deleting a task takes effect without
   * touching the cron table by hand.
   */
  private syncToCron(complete: boolean): void {
    if (!this.cronService) return;
    const currentNames = new Set<string>();
    for (const task of this.tasks) {
      const parts = ['heartbeat'];
      if (task.agentId) parts.push(task.agentId);
      if (task.userId) parts.push(task.userId);
      parts.push(task.name);
      const jobName = parts.join(':');
      currentNames.add(jobName);
      this.cronService.upsertByName({
        name: jobName,
        scheduleKind: task.scheduleKind,
        scheduleValue: task.scheduleValue,
        scheduleTz: task.scheduleTz,
        task: task.description,
        enabled: true,
        userId: task.userId,
        agentId: task.agentId,
        chatId: task.chatId,
      });
    }

    if (complete) {
      for (const job of this.cronService.listJobs()) {
        if (job.name.startsWith('heartbeat:') && !currentNames.has(job.name)) {
          this.cronService.updateJob(job.id, { enabled: false });
          log.info(`Heartbeat: disabled stale job "${job.name}" (removed from HEARTBEAT.md)`);
        }
      }
    }

    const perUser = this.tasks.filter(t => t.userId).length;
    const perAgent = this.tasks.filter(t => t.agentId).length;
    log.info(`Heartbeat: synced ${this.tasks.length} task(s) to CronService (${perUser} per-user, ${perAgent} per-agent)`);
  }

  /** Read a HEARTBEAT.md; ENOENT is fine (null content), other errors mark the load incomplete. */
  private async readOptional(path: string): Promise<{ content: string | null; ok: boolean }> {
    try {
      return { content: await readFile(path, 'utf-8'), ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { content: null, ok: true };
      log.warn(`Heartbeat: failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return { content: null, ok: false };
    }
  }

  /** Load tasks from all HEARTBEAT.md files. Returns true if no unexpected read errors. */
  private async loadTasks(): Promise<boolean> {
    this.tasks = [];
    let complete = true;

    for (const entry of this.heartbeatPaths()) {
      const { content, ok } = await this.readOptional(entry.path);
      if (!ok) complete = false;
      if (!content) continue;
      const parsed = parseHeartbeatMd(content);
      for (const task of parsed) {
        if (entry.userId) task.userId = entry.userId;
        if (entry.agentId) task.agentId = entry.agentId;
      }
      this.tasks.push(...parsed);
      const scope = entry.userId ? `user ${entry.userId}` : entry.agentId ? `agent ${entry.agentId}` : 'global';
      log.debug(`Heartbeat: loaded ${parsed.length} task(s) (${scope})`);
    }

    return complete;
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

        const inbound: Parameters<typeof this.bus.publishInbound>[0] = {
          id: `heartbeat-${Date.now()}`,
          channel: 'system',
          chatId: task.chatId ?? (task.userId ? `heartbeat:${task.userId}` : 'heartbeat'),
          content: `[Heartbeat task: ${task.name}] (${localTimestamp()})\n\n${task.description}`,
          author: 'system',
          timestamp: new Date(),
          lane: 'heartbeat',
        };
        if (task.userId) {
          inbound.user = { userId: task.userId };
        }
        await this.bus.publishInbound(inbound, signal).catch(err => {
          log.warn(`Heartbeat: failed to publish task "${task.name}": ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }
}

const CRON_EXPR_RE = /^[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+\s+[\d*,\-/]+$/;

export function parseHeartbeatMd(content: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const systemTz = getTimezone();
  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const name = lines[0].trim();
    if (!name) continue;

    let scheduleRaw = '';
    let description = '';
    let chatId: string | undefined;

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      const scheduleMatch = trimmed.match(/^-?\s*schedule:\s*(.+)$/i);
      const taskMatch = trimmed.match(/^-?\s*task:\s*(.+)$/i);
      const chatMatch = trimmed.match(/^-?\s*chat:\s*(.+)$/i);

      if (scheduleMatch) {
        scheduleRaw = scheduleMatch[1].trim();
      }
      if (taskMatch) {
        description = taskMatch[1].trim();
      }
      if (chatMatch) {
        chatId = chatMatch[1].trim();
      }
    }

    if (!scheduleRaw || !description) {
      log.debug(`Heartbeat: skipping task "${name}" — missing schedule or task`);
      continue;
    }

    // Parse 'every Xm/h/d', 'at HH:MM', or cron expression
    const atMatch = scheduleRaw.match(/^at\s+(\d{1,2}):(\d{2})$/i);
    if (atMatch) {
      const hour = parseInt(atMatch[1], 10);
      const minute = parseInt(atMatch[2], 10);
      tasks.push({
        name,
        description,
        intervalMs: 0,
        lastRun: 0,
        scheduleKind: 'cron',
        scheduleValue: `${minute} ${hour} * * *`,
        scheduleTz: systemTz,
        ...(chatId ? { chatId } : {}),
      });
      continue;
    }

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
        ...(chatId ? { chatId } : {}),
      });
    } else if (CRON_EXPR_RE.test(scheduleRaw)) {
      tasks.push({
        name,
        description,
        intervalMs: 0,
        lastRun: 0,
        scheduleKind: 'cron',
        scheduleValue: scheduleRaw,
        scheduleTz: systemTz,
        ...(chatId ? { chatId } : {}),
      });
    } else {
      log.debug(`Heartbeat: unrecognized schedule format for "${name}": ${scheduleRaw}`);
    }
  }

  return tasks;
}
