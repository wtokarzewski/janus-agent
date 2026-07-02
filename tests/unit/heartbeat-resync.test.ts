/**
 * HeartbeatService re-sync — HEARTBEAT.md edits must take effect without a
 * restart: new sections become cron jobs, removed sections disable their jobs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HeartbeatService } from '../../src/services/heartbeat-service.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { createTestConfig, createTempDir } from '../helpers/test-fixtures.js';
import type { CronService, CronJob, CronJobInput } from '../../src/services/cron-service.js';

interface FakeJob {
  id: string;
  name: string;
  enabled: boolean;
}

class FakeCronService {
  jobs = new Map<string, FakeJob>();
  upserts: string[] = [];
  disabled: string[] = [];
  private nextId = 1;

  upsertByName(input: CronJobInput): CronJob {
    this.upserts.push(input.name);
    const existing = [...this.jobs.values()].find(j => j.name === input.name);
    if (existing) {
      existing.enabled = input.enabled !== false;
      return existing as unknown as CronJob;
    }
    const job: FakeJob = { id: String(this.nextId++), name: input.name, enabled: true };
    this.jobs.set(job.id, job);
    return job as unknown as CronJob;
  }

  listJobs(includeDisabled = false): CronJob[] {
    return [...this.jobs.values()]
      .filter(j => includeDisabled || j.enabled) as unknown as CronJob[];
  }

  updateJob(id: string, patch: Partial<CronJobInput>): CronJob {
    const job = this.jobs.get(id)!;
    if (patch.enabled === false) {
      job.enabled = false;
      this.disabled.push(job.name);
    }
    return job as unknown as CronJob;
  }
}

describe('heartbeat re-sync', () => {
  let workspaceDir: string;
  let ctrl: AbortController;

  beforeEach(() => {
    workspaceDir = createTempDir();
    ctrl = new AbortController();
  });

  afterEach(() => {
    ctrl.abort();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function createService(cron: FakeCronService): HeartbeatService {
    const config = createTestConfig();
    return new HeartbeatService({
      bus: new MessageBus(),
      config,
      workspaceDir,
      cronService: cron as unknown as CronService,
    });
  }

  it('syncs tasks at startup and picks up a new section on resync', async () => {
    const hbPath = join(workspaceDir, 'HEARTBEAT.md');
    writeFileSync(hbPath, '## Task A\n- schedule: every 30m\n- task: Do A\n');

    const cron = new FakeCronService();
    const service = createService(cron);
    await service.start(ctrl.signal);

    expect(cron.upserts).toContain('heartbeat:Task A');

    // Add a section — resync must pick it up without a restart
    writeFileSync(hbPath, '## Task A\n- schedule: every 30m\n- task: Do A\n\n## Task B\n- schedule: every 1h\n- task: Do B\n');
    await service.resync();

    expect(cron.upserts).toContain('heartbeat:Task B');
    expect(cron.disabled).toHaveLength(0);
  });

  it('disables jobs whose section was removed from HEARTBEAT.md', async () => {
    const hbPath = join(workspaceDir, 'HEARTBEAT.md');
    writeFileSync(hbPath, '## Task A\n- schedule: every 30m\n- task: Do A\n\n## Task B\n- schedule: every 1h\n- task: Do B\n');

    const cron = new FakeCronService();
    const service = createService(cron);
    await service.start(ctrl.signal);

    expect(cron.upserts).toContain('heartbeat:Task A');
    expect(cron.upserts).toContain('heartbeat:Task B');

    writeFileSync(hbPath, '## Task A\n- schedule: every 30m\n- task: Do A\n');
    await service.resync();

    expect(cron.disabled).toContain('heartbeat:Task B');
    // Task A stays enabled
    const taskA = [...cron.jobs.values()].find(j => j.name === 'heartbeat:Task A');
    expect(taskA?.enabled).toBe(true);
  });

  it('does not touch non-heartbeat cron jobs on resync', async () => {
    const hbPath = join(workspaceDir, 'HEARTBEAT.md');
    writeFileSync(hbPath, '## Task A\n- schedule: every 30m\n- task: Do A\n');

    const cron = new FakeCronService();
    // Simulate an agent-created cron job (not heartbeat-derived)
    cron.upsertByName({ name: 'My reminder', scheduleKind: 'every', scheduleValue: '60000', task: 'remind', enabled: true } as CronJobInput);
    cron.upserts = [];

    const service = createService(cron);
    await service.start(ctrl.signal);

    writeFileSync(hbPath, '## Task C\n- schedule: every 1h\n- task: Do C\n');
    await service.resync();

    expect(cron.disabled).toContain('heartbeat:Task A');
    expect(cron.disabled).not.toContain('My reminder');
  });

  it('skips reload when files are unchanged', async () => {
    const hbPath = join(workspaceDir, 'HEARTBEAT.md');
    writeFileSync(hbPath, '## Task A\n- schedule: every 30m\n- task: Do A\n');

    const cron = new FakeCronService();
    const service = createService(cron);
    await service.start(ctrl.signal);
    const upsertsAfterStart = cron.upserts.length;

    await service.resync();
    expect(cron.upserts.length).toBe(upsertsAfterStart);
  });
});
