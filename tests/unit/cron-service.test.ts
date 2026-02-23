import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { CronService } from '../../src/services/cron-service.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    expect(job.id).toBeTruthy();
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

  it('should upsert by name', () => {
    const first = service.upsertByName({ name: 'upsert-test', scheduleKind: 'every', scheduleValue: '1000', task: 'first' });
    const second = service.upsertByName({ name: 'upsert-test', scheduleKind: 'every', scheduleValue: '2000', task: 'second' });

    expect(first.id).toBe(second.id);
    expect(second.task).toBe('second');
    expect(second.scheduleValue).toBe('2000');
    expect(service.listJobs(true)).toHaveLength(1);
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
