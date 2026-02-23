/**
 * CronService — persistent cron scheduler with SQLite storage.
 *
 * Supports 3 schedule kinds:
 * - 'at': one-shot at a specific ISO timestamp
 * - 'every': recurring interval in milliseconds
 * - 'cron': cron expression (5-field) with optional timezone
 *
 * Jobs persist across restarts. Execution publishes to MessageBus.
 */

import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { MessageBus } from '../bus/message-bus.js';
import * as log from '../utils/logger.js';

export type ScheduleKind = 'at' | 'every' | 'cron';

export interface CronJobInput {
  name: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  scheduleTz?: string;
  task: string;
  enabled?: boolean;
}

export interface CronJob {
  id: string;
  name: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  scheduleTz: string | null;
  task: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  createdAt: string;
}

export interface CronRunEntry {
  id: number;
  jobId: string;
  status: string;
  error: string | null;
  startedAt: string;
  durationMs: number | null;
}

const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export class CronService {
  private db: Database;
  private bus: MessageBus;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(db: Database, bus: MessageBus) {
    this.db = db;
    this.bus = bus;
  }

  start(signal: AbortSignal): void {
    this.running = true;
    this.armTimer();

    signal.addEventListener('abort', () => {
      this.stop();
    }, { once: true });

    log.info(`Cron service started (${this.listJobs().length} jobs)`);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info('Cron service stopped');
  }

  // --- CRUD ---

  addJob(input: CronJobInput): CronJob {
    const id = randomUUID();
    const nextRunAt = this.computeNextRun({
      scheduleKind: input.scheduleKind,
      scheduleValue: input.scheduleValue,
      scheduleTz: input.scheduleTz ?? null,
      lastRunAt: null,
    });

    this.db.db.prepare(`
      INSERT INTO cron_jobs (id, name, schedule_kind, schedule_value, schedule_tz, task, enabled, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.scheduleKind, input.scheduleValue, input.scheduleTz ?? null, input.task, input.enabled !== false ? 1 : 0, nextRunAt);

    return this.getJob(id)!;
  }

  updateJob(id: string, patch: Partial<CronJobInput>): CronJob {
    const existing = this.getJob(id);
    if (!existing) throw new Error(`Cron job not found: ${id}`);

    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.name !== undefined) { updates.push('name = ?'); values.push(patch.name); }
    if (patch.scheduleKind !== undefined) { updates.push('schedule_kind = ?'); values.push(patch.scheduleKind); }
    if (patch.scheduleValue !== undefined) { updates.push('schedule_value = ?'); values.push(patch.scheduleValue); }
    if (patch.scheduleTz !== undefined) { updates.push('schedule_tz = ?'); values.push(patch.scheduleTz); }
    if (patch.task !== undefined) { updates.push('task = ?'); values.push(patch.task); }
    if (patch.enabled !== undefined) { updates.push('enabled = ?'); values.push(patch.enabled ? 1 : 0); }

    if (updates.length > 0) {
      values.push(id);
      this.db.db.prepare(`UPDATE cron_jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    // Recompute next_run_at
    const updated = this.getJob(id)!;
    const nextRunAt = this.computeNextRun(updated);
    this.db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?').run(nextRunAt, id);

    return this.getJob(id)!;
  }

  removeJob(id: string): void {
    this.db.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id);
  }

  listJobs(includeDisabled = false): CronJob[] {
    const sql = includeDisabled
      ? 'SELECT * FROM cron_jobs ORDER BY created_at'
      : 'SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY created_at';
    return this.db.db.prepare(sql).all().map(rowToJob);
  }

  getJob(id: string): CronJob | null {
    const row = this.db.db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id);
    return row ? rowToJob(row) : null;
  }

  getRunHistory(jobId: string, limit = 20): CronRunEntry[] {
    return this.db.db.prepare(
      'SELECT * FROM cron_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?'
    ).all(jobId, limit).map(rowToRun);
  }

  /** Upsert a job by name — used by HeartbeatService to sync from HEARTBEAT.md. */
  upsertByName(input: CronJobInput): CronJob {
    const existing = this.db.db.prepare('SELECT id FROM cron_jobs WHERE name = ?').get(input.name) as { id: string } | undefined;
    if (existing) {
      return this.updateJob(existing.id, input);
    }
    return this.addJob(input);
  }

  // --- Timer ---

  private armTimer(): void {
    if (!this.running) return;

    this.timer = setTimeout(() => {
      this.onTimer().catch(err => {
        log.warn(`Cron timer error: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        this.armTimer();
      });
    }, 60_000); // check every 60s
  }

  private async onTimer(): Promise<void> {
    const now = new Date();
    const jobs = this.listJobs();

    for (const job of jobs) {
      if (!job.nextRunAt) continue;
      const nextRun = new Date(job.nextRunAt);
      if (now >= nextRun) {
        // Check backoff for consecutive errors
        if (job.consecutiveErrors > 0) {
          const backoffMs = BACKOFF_MS[Math.min(job.consecutiveErrors - 1, BACKOFF_MS.length - 1)];
          if (job.lastRunAt) {
            const lastRun = new Date(job.lastRunAt).getTime();
            if (now.getTime() - lastRun < backoffMs) continue;
          }
        }

        await this.executeJob(job);
      }
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    const startedAt = new Date();
    log.info(`Cron: firing job "${job.name}" (${job.id})`);

    try {
      await this.bus.publishInbound({
        id: `cron-${job.id}-${Date.now()}`,
        channel: 'system',
        chatId: `cron:${job.id}`,
        content: `[Cron job: ${job.name}]\n\n${job.task}`,
        author: 'system',
        timestamp: startedAt,
      });

      const durationMs = Date.now() - startedAt.getTime();
      const nextRunAt = this.computeNextRun(job);

      // Update job state
      this.db.db.prepare(`
        UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = 'ok', last_error = NULL, consecutive_errors = 0
        WHERE id = ?
      `).run(startedAt.toISOString(), nextRunAt, job.id);

      // Record run
      this.db.db.prepare(`
        INSERT INTO cron_runs (job_id, status, started_at, duration_ms) VALUES (?, 'ok', ?, ?)
      `).run(job.id, startedAt.toISOString(), durationMs);

    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt.getTime();
      const nextRunAt = this.computeNextRun(job);

      this.db.db.prepare(`
        UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = 'error', last_error = ?, consecutive_errors = consecutive_errors + 1
        WHERE id = ?
      `).run(startedAt.toISOString(), nextRunAt, errorText, job.id);

      this.db.db.prepare(`
        INSERT INTO cron_runs (job_id, status, error, started_at, duration_ms) VALUES (?, 'error', ?, ?, ?)
      `).run(job.id, errorText, startedAt.toISOString(), durationMs);

      log.warn(`Cron job "${job.name}" failed: ${errorText}`);
    }
  }

  private computeNextRun(job: Pick<CronJob, 'scheduleKind' | 'scheduleValue' | 'scheduleTz' | 'lastRunAt'>): string | null {
    const now = new Date();

    switch (job.scheduleKind) {
      case 'at': {
        const target = new Date(job.scheduleValue);
        return target > now ? target.toISOString() : null;
      }

      case 'every': {
        const intervalMs = parseInt(job.scheduleValue, 10);
        if (isNaN(intervalMs) || intervalMs <= 0) return null;
        const base = job.lastRunAt ? new Date(job.lastRunAt) : now;
        return new Date(base.getTime() + intervalMs).toISOString();
      }

      case 'cron': {
        try {
          const opts = job.scheduleTz ? { timezone: job.scheduleTz } : undefined;
          const cron = new Cron(job.scheduleValue, opts);
          const next = cron.nextRun();
          return next ? next.toISOString() : null;
        } catch {
          log.warn(`Invalid cron expression: ${job.scheduleValue}`);
          return null;
        }
      }

      default:
        return null;
    }
  }
}

// --- Row mappers ---

function rowToJob(row: unknown): CronJob {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    name: String(r.name),
    scheduleKind: String(r.schedule_kind) as ScheduleKind,
    scheduleValue: String(r.schedule_value),
    scheduleTz: r.schedule_tz ? String(r.schedule_tz) : null,
    task: String(r.task),
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : null,
    lastStatus: r.last_status ? String(r.last_status) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    consecutiveErrors: Number(r.consecutive_errors ?? 0),
    createdAt: String(r.created_at),
  };
}

function rowToRun(row: unknown): CronRunEntry {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    jobId: String(r.job_id),
    status: String(r.status),
    error: r.error ? String(r.error) : null,
    startedAt: String(r.started_at),
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
  };
}
