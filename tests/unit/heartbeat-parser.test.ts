import { describe, it, expect } from 'vitest';
import { parseHeartbeatMd } from '../../src/services/heartbeat-service.js';

describe('parseHeartbeatMd', () => {
  it('should parse standard heartbeat tasks', () => {
    const content = `# Heartbeat

## Daily Sync
- schedule: every 1d
- task: Sync notes and check status

## Quick Check
- schedule: every 30m
- task: Check for new messages
`;

    const tasks = parseHeartbeatMd(content);
    expect(tasks).toHaveLength(2);

    expect(tasks[0].name).toBe('Daily Sync');
    expect(tasks[0].description).toBe('Sync notes and check status');
    expect(tasks[0].intervalMs).toBe(86_400_000);

    expect(tasks[1].name).toBe('Quick Check');
    expect(tasks[1].description).toBe('Check for new messages');
    expect(tasks[1].intervalMs).toBe(30 * 60_000);
  });

  it('should handle hourly schedule', () => {
    const tasks = parseHeartbeatMd(`## Hourly Task\n- schedule: every 2h\n- task: Do something`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].intervalMs).toBe(2 * 3_600_000);
  });

  it('should skip tasks with missing schedule', () => {
    const tasks = parseHeartbeatMd(`## No Schedule\n- task: Do something`);
    expect(tasks).toHaveLength(0);
  });

  it('should skip tasks with missing task description', () => {
    const tasks = parseHeartbeatMd(`## No Task\n- schedule: every 1m`);
    expect(tasks).toHaveLength(0);
  });

  it('should return empty array for empty content', () => {
    expect(parseHeartbeatMd('')).toEqual([]);
  });

  it('should initialize lastRun to 0', () => {
    const tasks = parseHeartbeatMd(`## Test\n- schedule: every 5m\n- task: Something`);
    expect(tasks[0].lastRun).toBe(0);
  });

  it('should parse chat field for channel routing', () => {
    const tasks = parseHeartbeatMd(`## Food check-in\n- schedule: at 13:00\n- task: Ask about meals\n- chat: -5267677750`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('Food check-in');
    expect(tasks[0].chatId).toBe('-5267677750');
  });

  it('should leave chatId undefined when chat field is absent', () => {
    const tasks = parseHeartbeatMd(`## Morning ping\n- schedule: at 07:00\n- task: Good morning`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].chatId).toBeUndefined();
  });

  it('should parse chat field with every schedule', () => {
    const tasks = parseHeartbeatMd(`## Reminder\n- schedule: every 2h\n- task: Check water\n- chat: -1234567`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].chatId).toBe('-1234567');
  });

  it('should parse chat field with cron expression', () => {
    const tasks = parseHeartbeatMd(`## Weekly\n- schedule: 0 9 * * 1\n- task: Weekly review\n- chat: -9876543`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].chatId).toBe('-9876543');
  });
});
