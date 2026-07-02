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
      userId: 'alice',
    });
    expect(job.userId).toBe('alice');
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
      name: 'heartbeat:alice:Morning',
      scheduleKind: 'cron',
      scheduleValue: '0 8 * * *',
      task: 'Morning briefing',
      userId: 'alice',
    });
    expect(job.userId).toBe('alice');

    // Update preserves userId
    const updated = service.upsertByName({
      name: 'heartbeat:alice:Morning',
      scheduleKind: 'cron',
      scheduleValue: '0 9 * * *',
      task: 'Morning briefing v2',
      userId: 'alice',
    });
    expect(updated.id).toBe(job.id);
    expect(updated.userId).toBe('alice');
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
    service.addJob({ name: 'alice-job', scheduleKind: 'every', scheduleValue: '1000', task: 'alice', userId: 'alice' });
    service.addJob({ name: 'bob-job', scheduleKind: 'every', scheduleValue: '1000', task: 'bob', userId: 'bob' });

    const aliceJobs = service.listJobsForUser('alice');
    expect(aliceJobs).toHaveLength(2);
    expect(aliceJobs.map(j => j.name).sort()).toEqual(['alice-job', 'system-job']);

    const bobJobs = service.listJobsForUser('bob');
    expect(bobJobs).toHaveLength(2);
    expect(bobJobs.map(j => j.name).sort()).toEqual(['bob-job', 'system-job']);
  });

  it('should include family members jobs when familyUserIds provided', () => {
    service.addJob({ name: 'system-job', scheduleKind: 'every', scheduleValue: '1000', task: 'system' });
    service.addJob({ name: 'alice-job', scheduleKind: 'every', scheduleValue: '1000', task: 'w', userId: 'alice' });
    service.addJob({ name: 'carol-job', scheduleKind: 'every', scheduleValue: '1000', task: 'm', userId: 'carol' });
    service.addJob({ name: 'bob-job', scheduleKind: 'every', scheduleValue: '1000', task: 'mac', userId: 'bob' });

    const familyJobs = service.listJobsForUser('alice', ['carol', 'dave']);
    expect(familyJobs).toHaveLength(3); // system + alice + carol (dave has no jobs)
    expect(familyJobs.map(j => j.name).sort()).toEqual(['alice-job', 'carol-job', 'system-job']);
  });

  it('should return only system jobs when no userId given', () => {
    service.addJob({ name: 'system', scheduleKind: 'every', scheduleValue: '1000', task: 'a' });
    service.addJob({ name: 'personal', scheduleKind: 'every', scheduleValue: '1000', task: 'b', userId: 'alice' });

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

describe('CronService execution context', () => {
  it('should include job ID in cron execution message', async () => {
    let publishedContent = '';
    bus.publishInbound = async (msg) => {
      publishedContent = msg.content;
    };

    const job = service.addJob({
      name: 'id-test',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'Check something',
    });

    // Force next_run_at to now so it fires
    db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    await (service as unknown as { onTimer(): Promise<void> }).onTimer();

    expect(publishedContent).toContain(`(id: ${job.id})`);
    expect(publishedContent).toContain('[Cron job: id-test]');
    expect(publishedContent).toContain('Check something');
  });
});

describe('CronService not_before', () => {
  it('computeNextRun skips cron matches before notBefore', () => {
    const notBefore = new Date(Date.now() + 2 * 3_600_000).toISOString(); // 2 hours from now
    const job = service.addJob({
      name: 'nb-cron',
      scheduleKind: 'cron',
      scheduleValue: '* * * * *', // every minute
      task: 'test',
      notBefore,
    });
    expect(job.nextRunAt).toBeTruthy();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThanOrEqual(new Date(notBefore).getTime());
  });

  it('computeNextRun clamps every-interval result to notBefore', () => {
    const notBefore = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
    const job = service.addJob({
      name: 'nb-every',
      scheduleKind: 'every',
      scheduleValue: '60000', // 1 minute
      task: 'test',
      notBefore,
    });
    expect(job.nextRunAt).toBeTruthy();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThanOrEqual(new Date(notBefore).getTime());
  });

  it('computeNextRun returns null for at-job before notBefore', () => {
    const notBefore = new Date(Date.now() + 2 * 3_600_000).toISOString(); // 2 hours from now
    const target = new Date(Date.now() + 1 * 3_600_000).toISOString(); // 1 hour from now (before notBefore)
    const job = service.addJob({
      name: 'nb-at',
      scheduleKind: 'at',
      scheduleValue: target,
      task: 'test',
      notBefore,
    });
    expect(job.nextRunAt).toBeNull();
  });

  it('stores notBefore on the job', () => {
    const notBefore = new Date(Date.now() + 3_600_000).toISOString();
    const job = service.addJob({
      name: 'nb-store',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'test',
      notBefore,
    });
    expect(job.notBefore).toBe(notBefore);
  });

  it('onTimer skips job when now < notBefore', async () => {
    const publishedIds: string[] = [];
    bus.publishInbound = async (msg) => {
      publishedIds.push(msg.id);
    };

    const notBefore = new Date(Date.now() + 3_600_000).toISOString(); // 1 hour from now
    const job = service.addJob({
      name: 'nb-skip',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'test',
      notBefore,
    });

    // Force next_run_at to now so it would normally fire
    db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    await (service as unknown as { onTimer(): Promise<void> }).onTimer();

    // Should not have fired because notBefore is in the future
    expect(publishedIds).toHaveLength(0);
  });
});

describe('targets', () => {
  it('stores and retrieves targets on job', () => {
    const job = service.addJob({
      name: 'multi-target',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'remind',
      targets: [
        { userId: 'alice', status: 'pending' },
        { userId: 'dave', status: 'pending' },
      ],
    });
    expect(job.targets).toHaveLength(2);
    expect(job.targets[0].userId).toBe('alice');
    expect(job.targets[0].status).toBe('pending');
  });

  it('normalizes null targets to empty array', () => {
    const job = service.addJob({
      name: 'no-targets',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'remind',
    });
    expect(job.targets).toEqual([]);
  });

  it('updates target status', () => {
    const job = service.addJob({
      name: 'status-test',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'remind',
      targets: [{ userId: 'alice', status: 'pending' }],
    });
    const updated = service.updateJob(job.id, {
      targets: [{ userId: 'alice', status: 'confirmed', statusAt: new Date().toISOString() }],
    });
    expect(updated.targets[0].status).toBe('confirmed');
  });

  it('auto-disables when all user targets responded', async () => {
    // Create job with all targets confirmed
    const job = service.addJob({
      name: 'auto-disable-test',
      scheduleKind: 'every',
      scheduleValue: '3600000',
      task: 'remind targets',
      targets: [
        { userId: 'alice', status: 'confirmed', statusAt: new Date().toISOString() },
        { userId: 'dave', status: 'rejected', statusAt: new Date().toISOString() },
      ],
    });

    // Force next_run_at to now
    db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    // Spy on publishInbound
    let published = false;
    bus.publishInbound = async () => { published = true; };

    await (service as unknown as { onTimer(): Promise<void> }).onTimer();

    // Should NOT have published (auto-disabled before LLM call)
    expect(published).toBe(false);

    // Job should be disabled
    const refreshed = service.getJob(job.id)!;
    expect(refreshed.enabled).toBe(false);
  });

  it('excludes group chat targets from auto-disable check', async () => {
    // Job with user confirmed + group chat still pending
    const job = service.addJob({
      name: 'mixed-target',
      scheduleKind: 'every',
      scheduleValue: '3600000',
      task: 'remind',
      targets: [
        { userId: 'alice', status: 'confirmed', statusAt: new Date().toISOString() },
        { chatId: '-100group', status: 'pending' },
      ],
    });

    db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), job.id);

    let published = false;
    bus.publishInbound = async () => { published = true; };

    await (service as unknown as { onTimer(): Promise<void> }).onTimer();

    // Should auto-disable because all USER targets responded (group chat excluded)
    expect(published).toBe(false);
    expect(service.getJob(job.id)!.enabled).toBe(false);
  });

  it('recomputes stale nextRunAt on startup', () => {
    // Create a recurring job
    const job = service.addJob({
      name: 'stale-test',
      scheduleKind: 'every',
      scheduleValue: '60000',
      task: 'test',
    });

    // Set nextRunAt to the past
    const pastTime = new Date(Date.now() - 300_000).toISOString();
    db.db.prepare('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?').run(pastTime, job.id);

    // Call recomputeStaleNextRunAt
    (service as unknown as { recomputeStaleNextRunAt(): void }).recomputeStaleNextRunAt();

    // nextRunAt should be in the future now
    const refreshed = service.getJob(job.id)!;
    expect(new Date(refreshed.nextRunAt!).getTime()).toBeGreaterThan(Date.now() - 5000);
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
    // Cron tasks should get system timezone
    expect(morningJob!.scheduleTz).toBeTruthy();

    // 'every' tasks don't need timezone (interval-based)
    expect(statusJob!.scheduleTz).toBeNull();

    ac.abort();
  });
});

describe('CronService memory scope', () => {
  function createServiceWithUsers(): CronService {
    const config = createTestConfig({
      users: [
        {
          id: 'wojtek',
          name: 'Wojtek',
          identities: [{ channel: 'telegram', channelUserId: '111222333' }],
        },
      ],
    });
    return new CronService(db, bus, config);
  }

  async function fire(svc: CronService, jobId: string): Promise<void> {
    const job = svc.getJob(jobId)!;
    await (svc as unknown as { executeJob(job: unknown): Promise<void> }).executeJob(job);
  }

  it('scopes a DM-delivered job to the user memory', async () => {
    const svc = createServiceWithUsers();
    const published: Array<{ scope?: { kind: string; id: string } }> = [];
    bus.publishInbound = async (msg) => { published.push(msg); };

    const job = svc.addJob({
      name: 'dm-job', scheduleKind: 'every', scheduleValue: '60000',
      task: 'remind', userId: 'wojtek', chatId: '111222333',
    });
    await fire(svc, job.id);

    expect(published).toHaveLength(1);
    expect(published[0].scope).toEqual({ kind: 'user', id: 'wojtek' });
  });

  it('scopes a user-owned pseudo-chat job (no chatId) to the user memory', async () => {
    const svc = createServiceWithUsers();
    const published: Array<{ scope?: { kind: string; id: string } }> = [];
    bus.publishInbound = async (msg) => { published.push(msg); };

    const job = svc.addJob({
      name: 'pseudo-job', scheduleKind: 'every', scheduleValue: '60000',
      task: 'remind', userId: 'wojtek',
    });
    await fire(svc, job.id);

    expect(published).toHaveLength(1);
    expect(published[0].scope).toEqual({ kind: 'user', id: 'wojtek' });
  });

  it('leaves group-chat jobs unscoped (per-chat memory)', async () => {
    const svc = createServiceWithUsers();
    const published: Array<{ scope?: { kind: string; id: string } }> = [];
    bus.publishInbound = async (msg) => { published.push(msg); };

    const job = svc.addJob({
      name: 'group-job', scheduleKind: 'every', scheduleValue: '60000',
      task: 'remind', userId: 'wojtek', chatId: '-100999888777',
    });
    await fire(svc, job.id);

    expect(published).toHaveLength(1);
    expect(published[0].scope).toBeUndefined();
  });
});
