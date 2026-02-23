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
