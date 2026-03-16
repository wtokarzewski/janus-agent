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

  it('should NOT expose family members jobs in list (privacy)', async () => {
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

    // Family chat: listing still only shows own jobs, not family members
    const result = await tool.execute(
      { action: 'list' },
      { userId: 'wojtek', familyUserIds: ['wojtek', 'monika', 'zuzia'] },
    );
    const jobs = JSON.parse(result);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('wojtek-task');
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
});
