import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { CronService } from '../../src/services/cron-service.js';
import { CronTool } from '../../src/tools/builtin/cron.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestConfig } from '../helpers/test-fixtures.js';

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

  describe('target_user_id (cross-user reminders — backward compat)', () => {
    it('should keep ownership with requester, target in targets array', async () => {
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
      // Owner = requester (monika), NOT the target
      expect(job.userId).toBe('monika');
      // Target is in targets array
      expect(job.targets).toEqual([{ userId: 'wojtek', status: 'pending' }]);
      // _action_required still emitted for cross-user
      expect(job._action_required).toContain('wojtek');
      expect(job._action_required).toContain('monika');
    });

    it('should append [Created by] annotation to task for cross-user jobs', async () => {
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
      expect(job.task).toContain('[Created by: monika. Targets: wojtek]');
    });

    it('should NOT append [Created by] when target equals requester', async () => {
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
      expect(job.task).not.toContain('[Created by');
      expect(job._action_required).toBeUndefined();
    });

    it('should make cross-user job visible to both owner and target in list', async () => {
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
      // Monika's own job (self-reminder)
      await tool.execute(
        { action: 'add', name: 'monika-private', schedule_kind: 'every', schedule_value: '60000', task: 'Private' },
        { userId: 'monika' },
      );

      // Wojtek sees the job targeted at him (via targets array)
      const wojtekResult = await tool.execute({ action: 'list' }, { userId: 'wojtek' });
      const wojtekJobs = JSON.parse(wojtekResult);
      expect(wojtekJobs.some((j: { name: string }) => j.name === 'for-wojtek')).toBe(true);

      // Monika sees BOTH — she's the owner of for-wojtek and monika-private
      const monikaResult = await tool.execute({ action: 'list' }, { userId: 'monika' });
      const monikaJobs = JSON.parse(monikaResult);
      expect(monikaJobs).toHaveLength(2);
      expect(monikaJobs.map((j: { name: string }) => j.name).sort()).toEqual(['for-wojtek', 'monika-private']);
    });

    it('should self-reject when target user calls remove', async () => {
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

      // Wojtek is a target, not the owner — self-reject instead of delete
      const removeResult = await tool.execute({ action: 'remove', id }, { userId: 'wojtek' });
      expect(removeResult).toContain('rejected');

      // Job still exists, target status is rejected
      const statusResult = await tool.execute({ action: 'status', id }, { userId: 'wojtek' });
      const job = JSON.parse(statusResult);
      expect(job.targets[0].status).toBe('rejected');
      expect(job.targets[0].statusAt).toBeTruthy();
    });

    it('should allow owner to remove cross-user job', async () => {
      const addResult = await tool.execute(
        {
          action: 'add',
          name: 'owner-removable',
          schedule_kind: 'every',
          schedule_value: '60000',
          task: 'Test',
          target_user_id: 'wojtek',
        },
        { userId: 'monika' },
      );
      const { id } = JSON.parse(addResult);

      // Monika is the owner — can remove
      const removeResult = await tool.execute({ action: 'remove', id }, { userId: 'monika' });
      expect(removeResult).toContain('removed');
    });

    it('should use user_id as owner when both user_id and target_user_id are set', async () => {
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
      // user_id determines owner, target_user_id goes to targets
      expect(job.userId).toBe('maciek');
      expect(job.targets).toEqual([{ userId: 'wojtek', status: 'pending' }]);
    });
  });

  describe('targets validation', () => {
    it('rejects unknown userId in targets', async () => {
      const config = createTestConfig({
        users: [
          { id: 'wojtek', name: 'Wojtek', identities: [{ channel: 'telegram', channelUserId: '123' }] },
        ],
      });
      const toolWithConfig = new CronTool(service, config);
      const result = await toolWithConfig.execute({
        action: 'add', name: 'test', schedule_kind: 'every', schedule_value: '60000',
        task: 'remind', targets: [{ userId: 'nonexistent' }],
      }, { userId: 'wojtek' });
      expect(result).toContain('not found');
    });

    it('auto-materializes owner when no targets provided', async () => {
      const result = await tool.execute({
        action: 'add', name: 'self', schedule_kind: 'every', schedule_value: '60000',
        task: 'remind',
      }, { userId: 'wojtek' });
      const job = JSON.parse(result);
      expect(job.targets).toHaveLength(1);
      expect(job.targets[0].userId).toBe('wojtek');
      expect(job.targets[0].status).toBe('pending');
    });

    it('converts legacy target_user_id to targets', async () => {
      const result = await tool.execute({
        action: 'add', name: 'legacy', schedule_kind: 'every', schedule_value: '60000',
        task: 'remind', target_user_id: 'wojtek',
      }, { userId: 'monika' });
      const job = JSON.parse(result);
      expect(job.targets[0].userId).toBe('wojtek');
      expect(job.targets[0].status).toBe('pending');
    });

    it('target remove sets status to rejected, not delete', async () => {
      // Create job owned by monika with wojtek as target
      const addResult = await tool.execute({
        action: 'add', name: 'target-reject', schedule_kind: 'every', schedule_value: '60000',
        task: 'Test', targets: [{ userId: 'wojtek' }],
      }, { userId: 'monika' });
      const { id } = JSON.parse(addResult);

      // Wojtek (target) calls remove — should reject self, not delete
      const removeResult = await tool.execute({ action: 'remove', id }, { userId: 'wojtek' });
      expect(removeResult).toContain('rejected');

      // Job should still exist
      const job = service.getJob(id)!;
      expect(job).toBeTruthy();
      expect(job.targets[0].status).toBe('rejected');
    });

    it('owner remove deletes entire job', async () => {
      const addResult = await tool.execute({
        action: 'add', name: 'owner-delete', schedule_kind: 'every', schedule_value: '60000',
        task: 'Test', targets: [{ userId: 'wojtek' }],
      }, { userId: 'monika' });
      const { id } = JSON.parse(addResult);

      // Monika (owner) calls remove — should delete
      const removeResult = await tool.execute({ action: 'remove', id }, { userId: 'monika' });
      expect(removeResult).toContain('removed');
      expect(service.getJob(id)).toBeNull();
    });

    it('target cannot update job', async () => {
      const addResult = await tool.execute({
        action: 'add', name: 'no-update', schedule_kind: 'every', schedule_value: '60000',
        task: 'Test', targets: [{ userId: 'wojtek' }],
      }, { userId: 'monika' });
      const { id } = JSON.parse(addResult);

      // Wojtek (target) tries to update — should be denied
      const updateResult = await tool.execute({ action: 'update', id, task: 'hacked' }, { userId: 'wojtek' });
      expect(updateResult).toContain('Access denied');
    });
  });
});
