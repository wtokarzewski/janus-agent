import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { CronService } from '../../src/services/cron-service.js';
import { HeartbeatService } from '../../src/services/heartbeat-service.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestConfig } from '../helpers/test-fixtures.js';

let db: Database;
let bus: MessageBus;
let service: CronService;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'janus-cron-test-'));
  db = new Database(join(tempDir, 'test.db'));
  bus = new MessageBus();
  service = new CronService(db, bus);
});

afterEach(() => {
  service.stop();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CronService CRUD', () => {
  it('should add and retrieve a job', () => {
    const job = service.addJob({
      name: 'test-job',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'Do something',
    });

    expect(job.name).toBe('test-job');
    expect(job.scheduleKind).toBe('every');
    expect(job.scheduleValue).toBe('60000');
    expect(job.task).toBe('Do something');
    expect(job.enabled).toBe(true);
    expect(job.userId).toBeNull();
    expect(job.id).toBeTruthy();
  });

  it('should store userId on a job', () => {
    const job = service.addJob({
      name: 'user-job',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'Personal task',
      userId: 'wojtek',
    });
    expect(job.userId).toBe('wojtek');
  });

  it('should list jobs', () => {
    service.addJob({ name: 'a', scheduleKind: 'every', scheduleValue: '1000', task: 'ta' });
    service.addJob({ name: 'b', scheduleKind: 'every', scheduleValue: '2000', task: 'tb' });

    const jobs = service.listJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0].name).toBe('a');
    expect(jobs[1].name).toBe('b');
  });

  it('should update a job', () => {
    const job = service.addJob({ name: 'orig', scheduleKind: 'every', scheduleValue: '1000', task: 'original' });
    const updated = service.updateJob(job.id, { name: 'renamed', task: 'changed' });

    expect(updated.name).toBe('renamed');
    expect(updated.task).toBe('changed');
    expect(updated.scheduleValue).toBe('1000');
  });

  it('should remove a job', () => {
    const job = service.addJob({ name: 'del', scheduleKind: 'every', scheduleValue: '1000', task: 'bye' });
    expect(service.listJobs(true)).toHaveLength(1);

    service.removeJob(job.id);
    expect(service.listJobs(true)).toHaveLength(0);
  });

  it('should throw on update of non-existent job', () => {
    expect(() => service.updateJob('nonexistent', { name: 'x' })).toThrow('not found');
  });

  it('should filter disabled jobs from default list', () => {
    service.addJob({ name: 'enabled', scheduleKind: 'every', scheduleValue: '1000', task: 't', enabled: true });
    service.addJob({ name: 'disabled', scheduleKind: 'every', scheduleValue: '1000', task: 't', enabled: false });

    expect(service.listJobs(false)).toHaveLength(1);
    expect(service.listJobs(true)).toHaveLength(2);
  });

  it('should upsert by name and set userId', () => {
    const job = service.upsertByName({
      name: 'heartbeat:wojtek:Morning',
      scheduleKind: 'cron',
      scheduleValue: '0 8 * * *',
      task: 'Morning briefing',
      userId: 'wojtek',
    });
    expect(job.userId).toBe('wojtek');

    // Update preserves userId
    const updated = service.upsertByName({
      name: 'heartbeat:wojtek:Morning',
      scheduleKind: 'cron',
      scheduleValue: '0 9 * * *',
      task: 'Morning briefing v2',
      userId: 'wojtek',
    });
    expect(updated.id).toBe(job.id);
    expect(updated.userId).toBe('wojtek');
  });

  it('should upsert by name', () => {
    const first = service.upsertByName({ name: 'upsert-test', scheduleKind: 'every', scheduleValue: '1000', task: 'first' });
    const second = service.upsertByName({ name: 'upsert-test', scheduleKind: 'every', scheduleValue: '2000', task: 'second' });

    expect(first.id).toBe(second.id);
    expect(second.task).toBe('second');
    expect(second.scheduleValue).toBe('2000');
    expect(service.listJobs(true)).toHaveLength(1);
  });
});

describe('CronService per-user filtering', () => {
  it('should list only system + own jobs for a user', () => {
    service.addJob({ name: 'system-job', scheduleKind: 'every', scheduleValue: '1000', task: 'system' });
    service.addJob({ name: 'wojtek-job', scheduleKind: 'every', scheduleValue: '1000', task: 'wojtek', userId: 'wojtek' });
    service.addJob({ name: 'maciek-job', scheduleKind: 'every', scheduleValue: '1000', task: 'maciek', userId: 'maciek' });

    const wojtekJobs = service.listJobsForUser('wojtek');
    expect(wojtekJobs).toHaveLength(2);
    expect(wojtekJobs.map(j => j.name).sort()).toEqual(['system-job', 'wojtek-job']);

    const maciekJobs = service.listJobsForUser('maciek');
    expect(maciekJobs).toHaveLength(2);
    expect(maciekJobs.map(j => j.name).sort()).toEqual(['maciek-job', 'system-job']);
  });

  it('should include family members jobs when familyUserIds provided', () => {
    service.addJob({ name: 'system-job', scheduleKind: 'every', scheduleValue: '1000', task: 'system' });
    service.addJob({ name: 'wojtek-job', scheduleKind: 'every', scheduleValue: '1000', task: 'w', userId: 'wojtek' });
    service.addJob({ name: 'monika-job', scheduleKind: 'every', scheduleValue: '1000', task: 'm', userId: 'monika' });
    service.addJob({ name: 'maciek-job', scheduleKind: 'every', scheduleValue: '1000', task: 'mac', userId: 'maciek' });

    const familyJobs = service.listJobsForUser('wojtek', ['monika', 'zuzia']);
    expect(familyJobs).toHaveLength(3); // system + wojtek + monika (zuzia has no jobs)
    expect(familyJobs.map(j => j.name).sort()).toEqual(['monika-job', 'system-job', 'wojtek-job']);
  });

  it('should return only system jobs when no userId given', () => {
    service.addJob({ name: 'system', scheduleKind: 'every', scheduleValue: '1000', task: 'a' });
    service.addJob({ name: 'personal', scheduleKind: 'every', scheduleValue: '1000', task: 'b', userId: 'wojtek' });

    const jobs = service.listJobsForUser(undefined);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('system');
  });
});

describe('CronService schedule computation', () => {
  it('should compute next_run_at for "every" jobs', () => {
    const job = service.addJob({ name: 'interval', scheduleKind: 'every', scheduleValue: '60000', task: 't' });
    expect(job.nextRunAt).toBeTruthy();
    const nextRun = new Date(job.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('should compute next_run_at for "at" jobs in the future', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const job = service.addJob({ name: 'at-job', scheduleKind: 'at', scheduleValue: future, task: 't' });
    expect(job.nextRunAt).toBe(future);
  });

  it('should return null next_run_at for "at" jobs in the past', () => {
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const job = service.addJob({ name: 'past-at', scheduleKind: 'at', scheduleValue: past, task: 't' });
    expect(job.nextRunAt).toBeNull();
  });

  it('should compute next_run_at for "cron" jobs', () => {
    const job = service.addJob({ name: 'cron-job', scheduleKind: 'cron', scheduleValue: '0 9 * * *', task: 't' });
    expect(job.nextRunAt).toBeTruthy();
    const nextRun = new Date(job.nextRunAt!);
    expect(nextRun.getTime()).toBeGreaterThan(Date.now() - 1000);
  });
});

describe('CronService run history', () => {
  it('should return empty run history initially', () => {
    const job = service.addJob({ name: 'hist', scheduleKind: 'every', scheduleValue: '1000', task: 't' });
    expect(service.getRunHistory(job.id)).toEqual([]);
  });
});

describe('CronService start/stop', () => {
  it('should start and stop without errors', () => {
    const ac = new AbortController();
    service.start(ac.signal);
    ac.abort();
  });
});

describe('CronService missed job staggering', () => {
  it('should stagger missed jobs instead of firing all at once', async () => {
    // Track executeJob calls via spy on bus.publishInbound
    const publishedIds: string[] = [];
    bus.publishInbound = async (msg) => {
      publishedIds.push(msg.id);
    };

    // Create 3 jobs with nextRunAt well in the past (missed)
    const pastTime = new Date(Date.now() - 300_000).toISOString(); // 5 min ago
    for (let i = 0; i < 3; i++) {
      service.addJob({ name: `missed-${i}`, scheduleKind: 'every', scheduleValue: '3600000', task: `Task ${i}` });
      const job = service.listJobs().find(j => j.name === `missed-${i}`)!;
      db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?').run(pastTime, job.id);
    }

    // Call onTimer directly
    await (service as unknown as { onTimer(): Promise<void> }).onTimer();

    // First missed job fires immediately, rest are staggered via setTimeout
    // Only 1 should have fired synchronously
    expect(publishedIds.length).toBe(1);
  });
});

describe('HeartbeatService → CronService sync', () => {
  it('should sync HEARTBEAT.md tasks to cron_jobs', async () => {
    const heartbeatContent = `# Heartbeat

## Status Check
- schedule: every 30m
- task: Check system status

## Morning Report
- schedule: at 09:00
- task: Generate morning report
`;
    writeFileSync(join(tempDir, 'HEARTBEAT.md'), heartbeatContent);

    const config = createTestConfig({
      workspace: { dir: tempDir },
      heartbeat: { enabled: true },
    });

    const heartbeat = new HeartbeatService({
      bus,
      config,
      workspaceDir: tempDir,
      cronService: service,
    });

    const ac = new AbortController();
    await heartbeat.start(ac.signal);

    const jobs = service.listJobs();
    expect(jobs).toHaveLength(2);

    const statusJob = jobs.find(j => j.name === 'heartbeat:Status Check');
    expect(statusJob).toBeTruthy();
    expect(statusJob!.scheduleKind).toBe('every');
    expect(statusJob!.task).toBe('Check system status');

    const morningJob = jobs.find(j => j.name === 'heartbeat:Morning Report');
    expect(morningJob).toBeTruthy();
    expect(morningJob!.scheduleKind).toBe('cron');
    expect(morningJob!.scheduleValue).toBe('0 9 * * *');

    ac.abort();
  });
});
