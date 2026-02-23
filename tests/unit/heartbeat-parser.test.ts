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
});
