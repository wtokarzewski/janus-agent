import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { CronService } from '../../src/services/cron-service.js';
import { CronTool } from '../../src/tools/builtin/cron.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let db: Database;
let bus: MessageBus;
let service: CronService;
let tool: CronTool;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'janus-cron-tool-test-'));
  db = new Database(join(tempDir, 'test.db'));
  bus = new MessageBus();
  service = new CronService(db, bus);
  tool = new CronTool(service);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('CronTool', () => {
  it('should list jobs (empty)', async () => {
    const result = await tool.execute({ action: 'list' });
    expect(JSON.parse(result)).toEqual([]);
  });

  it('should add a job', async () => {
    const result = await tool.execute({
      action: 'add',
      name: 'test',
      schedule_kind: 'every',
      schedule_value: '60000',
      task: 'Do something',
    });
    const job = JSON.parse(result);
    expect(job.name).toBe('test');
    expect(job.id).toBeTruthy();
  });

  it('should associate job with userId from reqCtx', async () => {
    const result = await tool.execute(
      { action: 'add', name: 'personal', schedule_kind: 'every', schedule_value: '60000', task: 'My task' },
      { userId: 'wojtek' },
    );
    const job = JSON.parse(result);
    expect(job.userId).toBe('wojtek');
  });

  it('should reassign userId via update', async () => {
    const addResult = await tool.execute(
      { action: 'add', name: 'reassign-test', schedule_kind: 'every', schedule_value: '1000', task: 't' },
    );
    const { id } = JSON.parse(addResult);
    expect(JSON.parse(addResult).userId).toBeNull();

    const updateResult = await tool.execute({ action: 'update', id, user_id: 'wojtek' });
    expect(JSON.parse(updateResult).userId).toBe('wojtek');
  });

  it('should override reqCtx userId with explicit user_id in add', async () => {
    const result = await tool.execute(
      { action: 'add', name: 'override-test', schedule_kind: 'every', schedule_value: '1000', task: 't', user_id: 'maciek' },
      { userId: 'wojtek' },
    );
    expect(JSON.parse(result).userId).toBe('maciek');
  });

  it('should create system job with user_id "system"', async () => {
    const result = await tool.execute(
      { action: 'add', name: 'sys-task', schedule_kind: 'every', schedule_value: '1000', task: 't', user_id: 'system' },
      { userId: 'wojtek' },
    );
    expect(JSON.parse(result).userId).toBeNull();
  });

  it('should reset userId to null via update with "system"', async () => {
    const addResult = await tool.execute(
      { action: 'add', name: 'reset-test', schedule_kind: 'every', schedule_value: '1000', task: 't' },
      { userId: 'wojtek' },
    );
    const { id } = JSON.parse(addResult);
    expect(JSON.parse(addResult).userId).toBe('wojtek');

    const updateResult = await tool.execute({ action: 'update', id, user_id: 'system' }, { userId: 'wojtek' });
    expect(JSON.parse(updateResult).userId).toBeNull();
  });

  it('should filter list by userId', async () => {
    // Add system job (no user)
    await tool.execute({ action: 'add', name: 'system', schedule_kind: 'every', schedule_value: '1000', task: 's' });
    // Add user jobs
    await tool.execute(
      { action: 'add', name: 'wojtek-task', schedule_kind: 'every', schedule_value: '1000', task: 'w' },
      { userId: 'wojtek' },
    );
    await tool.execute(
      { action: 'add', name: 'maciek-task', schedule_kind: 'every', schedule_value: '1000', task: 'm' },
      { userId: 'maciek' },
    );

    // Wojtek should see system + own, not maciek's
    const wojtekResult = await tool.execute({ action: 'list' }, { userId: 'wojtek' });
    const wojtekJobs = JSON.parse(wojtekResult);
    expect(wojtekJobs).toHaveLength(2);
    expect(wojtekJobs.map((j: { name: string }) => j.name).sort()).toEqual(['system', 'wojtek-task']);
  });

  it('should expose family members jobs in list (cross-user visibility)', async () => {
    await tool.execute(
      { action: 'add', name: 'wojtek-task', schedule_kind: 'every', schedule_value: '1000', task: 'w' },
      { userId: 'wojtek' },
    );
    await tool.execute(
      { action: 'add', name: 'monika-task', schedule_kind: 'every', schedule_value: '1000', task: 'm' },
      { userId: 'monika' },
    );
    await tool.execute(
      { action: 'add', name: 'maciek-task', schedule_kind: 'every', schedule_value: '1000', task: 'mac' },
      { userId: 'maciek' },
    );

    // Family chat: listing shows own + family members' jobs
    const result = await tool.execute(
      { action: 'list' },
      { userId: 'wojtek', familyUserIds: ['wojtek', 'monika', 'zuzia'] },
    );
    const jobs = JSON.parse(result);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j: { name: string }) => j.name).sort()).toEqual(['monika-task', 'wojtek-task']);
  });

  it('should allow family member access via status (targeted query)', async () => {
    const addResult = await tool.execute(
      { action: 'add', name: 'monika-task', schedule_kind: 'every', schedule_value: '1000', task: 'm' },
      { userId: 'monika' },
    );
    const { id } = JSON.parse(addResult);

    // Wojtek can access monika's job via status in family chat
    const statusResult = await tool.execute(
      { action: 'status', id },
      { userId: 'wojtek', familyUserIds: ['wojtek', 'monika', 'zuzia'] },
    );
    expect(statusResult).not.toContain('Access denied');
    const job = JSON.parse(statusResult);
    expect(job.name).toBe('monika-task');
  });

  it('should deny access to another users job', async () => {
    const addResult = await tool.execute(
      { action: 'add', name: 'secret', schedule_kind: 'every', schedule_value: '1000', task: 'private' },
      { userId: 'maciek' },
    );
    const { id } = JSON.parse(addResult);

    const statusResult = await tool.execute({ action: 'status', id }, { userId: 'wojtek' });
    expect(statusResult).toContain('Access denied');

    const removeResult = await tool.execute({ action: 'remove', id }, { userId: 'wojtek' });
    expect(removeResult).toContain('Access denied');

    const updateResult = await tool.execute({ action: 'update', id, task: 'hacked' }, { userId: 'wojtek' });
    expect(updateResult).toContain('Access denied');

    const runsResult = await tool.execute({ action: 'runs', id }, { userId: 'wojtek' });
    expect(runsResult).toContain('Access denied');
  });

  it('should deny access to user-owned jobs when no userId in context', async () => {
    const addResult = await tool.execute(
      { action: 'add', name: 'private', schedule_kind: 'every', schedule_value: '1000', task: 'secret' },
      { userId: 'wojtek' },
    );
    const { id } = JSON.parse(addResult);

    // No reqCtx → deny access to user-owned jobs
    const statusResult = await tool.execute({ action: 'status', id });
    expect(statusResult).toContain('Access denied');

    // System jobs still accessible without userId
    const sysResult = await tool.execute(
      { action: 'add', name: 'system', schedule_kind: 'every', schedule_value: '1000', task: 'sys' },
    );
    const sysJob = JSON.parse(sysResult);
    const sysStatus = await tool.execute({ action: 'status', id: sysJob.id });
    expect(sysStatus).not.toContain('Access denied');
  });

  it('should return error for add with missing fields', async () => {
    const result = await tool.execute({ action: 'add', name: 'x' });
    expect(result).toContain('Error');
  });

  it('should get status of a job', async () => {
    const addResult = await tool.execute({
      action: 'add',
      name: 'status-test',
      schedule_kind: 'every',
      schedule_value: '1000',
      task: 'check',
    });
    const { id } = JSON.parse(addResult);

    const status = await tool.execute({ action: 'status', id });
    const job = JSON.parse(status);
    expect(job.name).toBe('status-test');
  });

  it('should remove a job', async () => {
    const addResult = await tool.execute({
      action: 'add',
      name: 'remove-test',
      schedule_kind: 'every',
      schedule_value: '1000',
      task: 'bye',
    });
    const { id } = JSON.parse(addResult);

    const removeResult = await tool.execute({ action: 'remove', id });
    expect(removeResult).toContain('removed');

    const listResult = await tool.execute({ action: 'list' });
    expect(JSON.parse(listResult)).toEqual([]);
  });

  it('should handle unknown action', async () => {
    const result = await tool.execute({ action: 'bogus' });
    expect(result).toContain('Unknown action');
  });

  it('should get runs for a job', async () => {
    const addResult = await tool.execute({
      action: 'add',
      name: 'runs-test',
      schedule_kind: 'every',
      schedule_value: '1000',
      task: 't',
    });
    const { id } = JSON.parse(addResult);

    const result = await tool.execute({ action: 'runs', id });
    expect(JSON.parse(result)).toEqual([]);
  });

  describe('target_user_id (cross-user reminders)', () => {
    it('should create job owned by target user', async () => {
      const result = await tool.execute(
        {
          action: 'add',
          name: 'laundry-reminder',
          schedule_kind: 'every',
          schedule_value: '300000',
          task: 'Remind about laundry',
          target_user_id: 'wojtek',
        },
        { userId: 'monika' },
      );
      const job = JSON.parse(result);
      expect(job.userId).toBe('wojtek');
      expect(job._action_required).toContain('wojtek');
      expect(job._action_required).toContain('monika');
    });

    it('should append [Requested by] to task for cross-user jobs', async () => {
      const result = await tool.execute(
        {
          action: 'add',
          name: 'cross-user-test',
          schedule_kind: 'every',
          schedule_value: '60000',
          task: 'Do something',
          target_user_id: 'wojtek',
        },
        { userId: 'monika' },
      );
      const job = JSON.parse(result);
      expect(job.task).toContain('[Requested by user: monika');
      expect(job.task).toContain('notify them via the message tool');
    });

    it('should NOT append [Requested by] when target equals requester', async () => {
      const result = await tool.execute(
        {
          action: 'add',
          name: 'self-reminder',
          schedule_kind: 'every',
          schedule_value: '60000',
          task: 'My own reminder',
          target_user_id: 'wojtek',
        },
        { userId: 'wojtek' },
      );
      const job = JSON.parse(result);
      expect(job.task).not.toContain('[Requested by');
      expect(job._action_required).toBeUndefined();
    });

    it('should make cross-user job visible to target in list', async () => {
      // Monika creates a reminder for Wojtek
      await tool.execute(
        {
          action: 'add',
          name: 'for-wojtek',
          schedule_kind: 'every',
          schedule_value: '300000',
          task: 'Laundry',
          target_user_id: 'wojtek',
        },
        { userId: 'monika' },
      );
      // Monika's own job
      await tool.execute(
        { action: 'add', name: 'monika-private', schedule_kind: 'every', schedule_value: '60000', task: 'Private' },
        { userId: 'monika' },
      );

      // Wojtek sees the job targeted at him
      const wojtekResult = await tool.execute({ action: 'list' }, { userId: 'wojtek' });
      const wojtekJobs = JSON.parse(wojtekResult);
      expect(wojtekJobs).toHaveLength(1);
      expect(wojtekJobs[0].name).toBe('for-wojtek');

      // Monika does NOT see it (it belongs to Wojtek now)
      const monikaResult = await tool.execute({ action: 'list' }, { userId: 'monika' });
      const monikaJobs = JSON.parse(monikaResult);
      expect(monikaJobs).toHaveLength(1);
      expect(monikaJobs[0].name).toBe('monika-private');
    });

    it('should allow target user to remove cross-user job', async () => {
      const addResult = await tool.execute(
        {
          action: 'add',
          name: 'removable',
          schedule_kind: 'every',
          schedule_value: '60000',
          task: 'Test',
          target_user_id: 'wojtek',
        },
        { userId: 'monika' },
      );
      const { id } = JSON.parse(addResult);

      // Wojtek can remove it (he's the owner now)
      const removeResult = await tool.execute({ action: 'remove', id }, { userId: 'wojtek' });
      expect(removeResult).toContain('removed');
    });

    it('should take precedence over user_id', async () => {
      const result = await tool.execute(
        {
          action: 'add',
          name: 'precedence-test',
          schedule_kind: 'every',
          schedule_value: '60000',
          task: 'Test',
          target_user_id: 'wojtek',
          user_id: 'maciek',
        },
        { userId: 'monika' },
      );
      const job = JSON.parse(result);
      // target_user_id wins over user_id
      expect(job.userId).toBe('wojtek');
    });
  });
});
