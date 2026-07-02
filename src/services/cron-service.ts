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
import type { InboundMessage } from '../bus/types.js';
import type { JanusConfig } from '../config/schema.js';
import * as log from '../utils/logger.js';
import { localTimestamp, getTimezone } from '../utils/date.js';
import { findUserByDmChatId } from '../users/user-resolver.js';

export type ScheduleKind = 'at' | 'every' | 'cron';

export interface CronTarget {
  userId?: string;
  chatId?: string;
  channel?: string;
  status: 'pending' | 'confirmed' | 'rejected';
  statusAt?: string;
}

export interface CronJobInput {
  name: string;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  scheduleTz?: string;
  task: string;
  enabled?: boolean;
  userId?: string | null;
  /** Target chat ID for group chat jobs (e.g. Telegram group). */
  chatId?: string;
  /** Optional custom session ID — cron uses same session across runs instead of per-job UUID. */
  sessionId?: string;
  /** Agent ID — routes job execution through specific agent context. */
  agentId?: string;
  /** If true, each run gets a disposable session (no cross-run contamination). */
  isolatedSession?: boolean;
  /** ISO timestamp — job will not fire before this time even if schedule matches. */
  notBefore?: string;
  targets?: CronTarget[];
}

export interface CronJob {
  id: string;
  name: string;
  userId: string | null;
  chatId: string | null;
  sessionId: string | null;
  agentId: string | null;
  scheduleKind: ScheduleKind;
  scheduleValue: string;
  scheduleTz: string | null;
  task: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  notBefore: string | null;
  consecutiveErrors: number;
  createdAt: string;
  targets: CronTarget[];
}

export interface CronRunEntry {
  id: number;
  jobId: string;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export class CronService {
  private db: Database;
  private bus: MessageBus;
  private config?: JanusConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private runningJobs = new Set<string>();
  private lastCleanupAt = 0;

  constructor(db: Database, bus: MessageBus, config?: JanusConfig) {
    this.db = db;
    this.bus = bus;
    this.config = config;
  }

  start(signal: AbortSignal): void {
    this.backfillHeartbeatUserIds();
    this.recomputeStaleNextRunAt();
    this.migrateTargetUserIdJobs();
    this.purgeDisabledJobs();
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

  /** One-time backfill: extract userId from heartbeat job names (heartbeat:{userId}:{name}). */
  private backfillHeartbeatUserIds(): void {
    const rows = this.db.db.prepare(
      "SELECT id, name FROM cron_jobs WHERE user_id IS NULL AND name LIKE 'heartbeat:%:%'"
    ).all() as Array<{ id: string; name: string }>;

    for (const row of rows) {
      const parts = row.name.split(':');
      if (parts.length >= 3) {
        this.db.db.prepare('UPDATE cron_jobs SET user_id = ? WHERE id = ?').run(parts[1], row.id);
      }
    }

    if (rows.length > 0) {
      log.info(`Cron: backfilled user_id for ${rows.length} heartbeat job(s)`);
    }
  }

  /** Recompute nextRunAt for recurring jobs where it's in the past (stale after restart/deploy). */
  private recomputeStaleNextRunAt(): void {
    const now = new Date();
    const jobs = this.listJobs();
    let updated = 0;
    for (const job of jobs) {
      if (job.scheduleKind === 'at') continue; // one-shot, don't recompute
      if (!job.nextRunAt) continue;
      if (new Date(job.nextRunAt) >= now) continue; // still in future
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
      } else if (job.userId && !job.enabled && !job.name.startsWith('heartbeat:')) {
        // Disabled non-heartbeat job with owner but no annotation — may be a legacy cross-user
        // job with hardcoded chat_id in task text. Can't auto-migrate.
        log.warn(`Cron: cannot migrate job "${job.name}" (${job.id}) — no [Requested by user:] annotation found`);
      }
    }
    if (migrated > 0) {
      log.info(`Cron: migrated ${migrated} legacy target_user_id job(s) to targets format`);
    }
  }

  /** Purge old disabled jobs based on config thresholds. Runs at configured hour, every N days. */
  private purgeDisabledJobs(): void {
    const cleanup = this.config?.cron?.cleanup;
    if (!cleanup?.enabled) return;

    const intervalMs = cleanup.intervalDays * 86_400_000;
    if (Date.now() - this.lastCleanupAt < intervalMs) return;

    // Only run at the configured time (skip check on first startup to not delay boot)
    if (this.lastCleanupAt > 0) {
      const [h, m] = cleanup.time.split(':').map(Number);
      const now = new Date();
      if (now.getHours() !== h || now.getMinutes() !== m) return;
    }

    this.lastCleanupAt = Date.now();

    const now = Date.now();
    const maxOneShotMs = cleanup.maxAgeDaysOneShot * 86_400_000;
    const maxRecurringMs = cleanup.maxAgeDaysRecurring * 86_400_000;
    const jobs = this.listJobs(true); // include disabled
    let purged = 0;

    for (const job of jobs) {
      if (job.enabled) continue;
      const age = now - new Date(job.createdAt).getTime();
      if (job.scheduleKind === 'at' && age > maxOneShotMs) {
        this.db.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(job.id);
        purged++;
      } else if ((job.scheduleKind === 'every' || job.scheduleKind === 'cron') && age > maxRecurringMs) {
        this.db.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(job.id);
        purged++;
      }
    }

    if (purged > 0) {
      log.info(`Cron: purged ${purged} old disabled job(s)`);
    }
  }

  // --- CRUD ---

  addJob(input: CronJobInput): CronJob {
    const id = randomUUID();
    const nextRunAt = this.computeNextRun({
      scheduleKind: input.scheduleKind,
      scheduleValue: input.scheduleValue,
      scheduleTz: input.scheduleTz ?? null,
      lastRunAt: null,
      notBefore: input.notBefore ?? null,
    });

    const targetsJson = input.targets?.length ? JSON.stringify(input.targets) : null;

    this.db.db.prepare(`
      INSERT INTO cron_jobs (id, name, schedule_kind, schedule_value, schedule_tz, task, enabled, next_run_at, user_id, chat_id, session_id, agent_id, not_before, targets)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.scheduleKind, input.scheduleValue, input.scheduleTz ?? null, input.task, input.enabled !== false ? 1 : 0, nextRunAt, input.userId ?? null, input.chatId ?? null, input.sessionId ?? null, input.agentId ?? null, input.notBefore ?? null, targetsJson);

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
    if (patch.userId !== undefined) { updates.push('user_id = ?'); values.push(patch.userId); }
    if (patch.chatId !== undefined) { updates.push('chat_id = ?'); values.push(patch.chatId); }
    if (patch.notBefore !== undefined) { updates.push('not_before = ?'); values.push(patch.notBefore); }
    if (patch.targets !== undefined) {
      updates.push('targets = ?');
      values.push(patch.targets.length ? JSON.stringify(patch.targets) : null);
    }

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

  /**
   * List jobs visible to a specific user.
   * Returns: system jobs (no owner/chat) + user's own + group chat jobs.
   */
  listJobsForUser(userId?: string, familyUserIds?: string[], includeDisabled = false, chatId?: string): CronJob[] {
    const enabledClause = includeDisabled ? '' : ' AND enabled = 1';

    if (!userId) {
      const sql = `SELECT * FROM cron_jobs WHERE user_id IS NULL AND chat_id IS NULL${enabledClause} ORDER BY created_at`;
      return this.db.db.prepare(sql).all().map(rowToJob);
    }

    const visibleIds = [...new Set<string>([userId, ...(familyUserIds ?? [])])];
    const userPlaceholders = visibleIds.map(() => '?').join(', ');
    const params: unknown[] = [...visibleIds];

    const conditions = [
      `(user_id IS NULL AND chat_id IS NULL)`,
      `user_id IN (${userPlaceholders})`,
      `targets LIKE '%"userId":"' || ? || '"%'`,
    ];
    params.push(userId);
    if (chatId) {
      conditions.push(`chat_id = ?`);
      params.push(chatId);
    }

    const sql = `SELECT * FROM cron_jobs WHERE (${conditions.join(' OR ')})${enabledClause} ORDER BY created_at`;
    return this.db.db.prepare(sql).all(...params).map(rowToJob);
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

  /** Stagger interval for missed jobs (ms between each missed job execution). */
  private static STAGGER_INTERVAL_MS = 30_000;
  /** Threshold (ms) above which a late job is considered "missed" vs merely "due". */
  private static MISSED_THRESHOLD_MS = 60_000;

  private async onTimer(): Promise<void> {
    // Periodic cleanup check
    this.purgeDisabledJobs();

    const now = new Date();
    const jobs = this.listJobs();

    const dueJobs: CronJob[] = [];
    const missedJobs: CronJob[] = [];

    for (const job of jobs) {
      if (!job.nextRunAt) continue;
      if (this.runningJobs.has(job.id)) continue;
      if (job.notBefore && now < new Date(job.notBefore)) continue;
      if (this.isOutsideActiveHours(job, now)) continue;

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

        const lateMs = now.getTime() - nextRun.getTime();
        if (lateMs > CronService.MISSED_THRESHOLD_MS) {
          missedJobs.push(job);
        } else {
          dueJobs.push(job);
        }
      }
    }

    // Execute due jobs immediately
    for (const job of dueJobs) {
      await this.executeJob(job);
    }

    // Stagger missed jobs to prevent LLM overload after restart
    for (let i = 0; i < missedJobs.length; i++) {
      const job = missedJobs[i];
      const delayMs = CronService.STAGGER_INTERVAL_MS * i;
      if (delayMs === 0) {
        await this.executeJob(job);
      } else {
        log.info(`Cron: staggering missed job "${job.name}" — will fire in ${delayMs / 1000}s`);
        setTimeout(() => {
          if (this.running && !this.runningJobs.has(job.id)) {
            this.executeJob(job).catch(err => {
              log.warn(`Cron: staggered job "${job.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }, delayMs);
      }
    }
  }

  private async executeJob(job: CronJob): Promise<void> {
    const startedAt = new Date();
    this.runningJobs.add(job.id);
    log.info(`Cron: firing job "${job.name}" (${job.id})`);

    try {
      // Determine chatId: group chat > session > job ID
      // isolatedSession: disposable key per run (no cross-run contamination)
      const isIsolated = job.name.startsWith('heartbeat:') && this.isIsolatedSession(job);
      const chatId = job.chatId
        ?? (isIsolated ? `cron:${job.id}:${Date.now()}` : (job.sessionId ? `cron:${job.sessionId}` : `cron:${job.id}`));

      // Memory scope for this run. Without it, scopeForChat falls back to
      // per-chat scope and a DM-delivered job writes its memory to
      // chats/{chatId}/ instead of the user's own memory dir.
      // - chat is a user's DM (chatId matches a channel identity) → that user
      // - pseudo chat (cron:*) owned by a user → the owning user
      // - real group chat → undefined (per-chat scope is correct there)
      const dmUser = this.config ? findUserByDmChatId(job.chatId ?? undefined, this.config) : undefined;
      const scope: InboundMessage['scope'] = dmUser
        ? { kind: 'user', id: dmUser.id }
        : (!job.chatId && job.userId ? { kind: 'user', id: job.userId } : undefined);

      // Auto-disable when all user targets have responded
      const targets = job.targets;
      const userTargets = targets.filter(t => t.userId);
      if (userTargets.length > 0 && userTargets.every(t => t.status !== 'pending')) {
        this.db.db.prepare('UPDATE cron_jobs SET enabled = 0 WHERE id = ?').run(job.id);
        log.info(`Cron: auto-disabled job "${job.name}" — all user targets responded`);

        // Notify owner about auto-disable
        if (job.userId) {
          const statusSummary = targets.map(t => {
            const id = t.userId ?? t.chatId ?? 'unknown';
            return `${id}: ${t.status}`;
          }).join(', ');
          await this.bus.publishInbound({
            id: `cron-complete-${job.id}-${Date.now()}`,
            channel: 'system',
            chatId: job.chatId ?? `cron:${job.id}`,
            content: `[Cron job completed: "${job.name}"] All targets responded. Status: ${statusSummary}. Job auto-disabled.`,
            author: 'system',
            timestamp: new Date(),
            lane: 'cron',
            user: { userId: job.userId },
            scope,
            agentId: job.agentId ?? undefined,
          });
        }

        this.runningJobs.delete(job.id);
        return; // skip LLM call
      }

      await this.bus.publishInbound({
        id: `cron-${job.id}-${Date.now()}`,
        channel: 'system',
        chatId,
        content: `[Cron job: ${job.name}] (id: ${job.id}) (${localTimestamp()})\n\n${job.task}`,
        author: 'system',
        timestamp: startedAt,
        cronDepth: 1,
        contextMode: 'background',
        lane: job.name.startsWith('heartbeat:') ? 'heartbeat' : 'cron',
        user: job.userId ? { userId: job.userId } : undefined,
        scope,
        agentId: job.agentId ?? undefined,
      });

      const durationMs = Date.now() - startedAt.getTime();
      const nextRunAt = this.computeNextRun(job);

      // Update job state
      this.db.db.prepare(`
        UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = 'ok', last_error = NULL, consecutive_errors = 0
        WHERE id = ?
      `).run(startedAt.toISOString(), nextRunAt, job.id);

      // Record run
      const finishedAt = new Date().toISOString();
      this.db.db.prepare(`
        INSERT INTO cron_runs (job_id, status, started_at, finished_at, duration_ms) VALUES (?, 'ok', ?, ?, ?)
      `).run(job.id, startedAt.toISOString(), finishedAt, durationMs);

      // Auto-disable completed one-shot jobs
      if (job.scheduleKind === 'at' && !nextRunAt) {
        this.db.db.prepare('UPDATE cron_jobs SET enabled = 0 WHERE id = ?').run(job.id);
        log.info(`Cron: one-shot job "${job.name}" completed, disabled`);
      }

    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt.getTime();
      const nextRunAt = this.computeNextRun(job);

      this.db.db.prepare(`
        UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = 'error', last_error = ?, consecutive_errors = consecutive_errors + 1
        WHERE id = ?
      `).run(startedAt.toISOString(), nextRunAt, errorText, job.id);

      const finishedAt = new Date().toISOString();
      this.db.db.prepare(`
        INSERT INTO cron_runs (job_id, status, error, started_at, finished_at, duration_ms) VALUES (?, 'error', ?, ?, ?, ?)
      `).run(job.id, errorText, startedAt.toISOString(), finishedAt, durationMs);

      log.warn(`Cron job "${job.name}" failed: ${errorText}`);
    } finally {
      this.runningJobs.delete(job.id);
    }
  }

  /** Check if a heartbeat job has isolatedSession enabled via its agent config. */
  private isIsolatedSession(job: CronJob): boolean {
    // isolatedSession is stored on the agent definition, not the job itself.
    // Convention: heartbeat jobs named "heartbeat:{agentId}:..." carry the agentId.
    if (!job.agentId) return false;
    // Look up agent config — we don't have AgentResolver here, so check job metadata.
    // For now, all heartbeat jobs with agentId are considered isolated if the job name pattern matches.
    // Full wiring: HeartbeatService sets isolatedSession flag when syncing.
    return true; // Heartbeat jobs with agentId default to isolated
  }

  /** Check if current time is outside agent's activeHours window. */
  private isOutsideActiveHours(job: CronJob, now: Date): boolean {
    if (!job.agentId) return false;
    // Find agent definition in config
    const agentDef = this.config?.agents?.find(a => a.id === job.agentId);
    const activeHours = agentDef?.heartbeat?.activeHours;
    if (!activeHours) return false;

    // Convert to minutes since midnight for comparison
    const [startH, startM] = activeHours.start.split(':').map(Number);
    const [endH, endM] = activeHours.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Get current time in agent's timezone, falling back to configured/system timezone
    const tz = activeHours.tz ?? getTimezone();
    let currentMinutes: number;
    if (tz) {
      const parts = now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false }).split(':');
      currentMinutes = Number(parts[0]) * 60 + Number(parts[1]);
    } else {
      currentMinutes = now.getHours() * 60 + now.getMinutes();
    }

    // Handle overnight ranges (e.g., 22:00-06:00)
    if (startMinutes <= endMinutes) {
      return currentMinutes < startMinutes || currentMinutes >= endMinutes;
    } else {
      return currentMinutes < startMinutes && currentMinutes >= endMinutes;
    }
  }

  private computeNextRun(job: Pick<CronJob, 'scheduleKind' | 'scheduleValue' | 'scheduleTz' | 'lastRunAt' | 'notBefore'>): string | null {
    const now = new Date();
    const notBefore = job.notBefore ? new Date(job.notBefore) : null;

    switch (job.scheduleKind) {
      case 'at': {
        const target = new Date(job.scheduleValue);
        if (target <= now) return null;
        if (notBefore && target < notBefore) return null;
        return target.toISOString();
      }

      case 'every': {
        const intervalMs = parseInt(job.scheduleValue, 10);
        if (isNaN(intervalMs) || intervalMs <= 0) return null;
        const base = job.lastRunAt ? new Date(job.lastRunAt) : now;
        let result = new Date(base.getTime() + intervalMs);
        if (notBefore && result < notBefore) result = notBefore;
        return result.toISOString();
      }

      case 'cron': {
        try {
          const opts = job.scheduleTz ? { timezone: job.scheduleTz } : undefined;
          const cron = new Cron(job.scheduleValue, opts);
          let next = cron.nextRun();
          if (notBefore && next) {
            let iterations = 0;
            while (next && next < notBefore && iterations < 1000) {
              next = cron.nextRun(next);
              iterations++;
            }
          }
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
    userId: r.user_id ? String(r.user_id) : null,
    chatId: r.chat_id ? String(r.chat_id) : null,
    sessionId: r.session_id ? String(r.session_id) : null,
    agentId: r.agent_id ? String(r.agent_id) : null,
    scheduleKind: String(r.schedule_kind) as ScheduleKind,
    scheduleValue: String(r.schedule_value),
    scheduleTz: r.schedule_tz ? String(r.schedule_tz) : null,
    task: String(r.task),
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : null,
    lastStatus: r.last_status ? String(r.last_status) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    notBefore: r.not_before ? String(r.not_before) : null,
    consecutiveErrors: Number(r.consecutive_errors ?? 0),
    createdAt: String(r.created_at),
    targets: r.targets ? JSON.parse(String(r.targets)) as CronTarget[] : [],
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
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
  };
}
