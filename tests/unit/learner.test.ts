import { describe, it, expect } from 'vitest';
import { SkillLearner } from '../../src/learner/learner.js';
import type { ExecutionRecord, LearnerStorage } from '../../src/learner/types.js';

class MockStorage implements LearnerStorage {
  records: ExecutionRecord[] = [];

  async append(record: ExecutionRecord): Promise<void> {
    this.records.push(record);
  }

  async getAll(): Promise<ExecutionRecord[]> {
    return [...this.records];
  }

  async getRecent(limit: number): Promise<ExecutionRecord[]> {
    return this.records.slice(-limit);
  }
}

function makeRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    task: 'test task',
    duration: 1000,
    iterations: 3,
    toolCalls: 5,
    tokenUsage: 500,
    outcome: 'success',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('SkillLearner', () => {
  it('should record and retrieve executions', async () => {
    const storage = new MockStorage();
    const learner = new SkillLearner(storage);

    await learner.recordExecution(makeRecord({ task: 'write unit test' }));
    expect(storage.records).toHaveLength(1);
    expect(storage.records[0].task).toBe('write unit test');
  });

  it('should find similar tasks by keyword overlap', async () => {
    const storage = new MockStorage();
    storage.records = [
      makeRecord({ task: 'write unit test for authentication' }),
      makeRecord({ task: 'deploy application to production' }),
      makeRecord({ task: 'write integration test for login' }),
    ];

    const learner = new SkillLearner(storage);
    const similar = await learner.findSimilar('write test', 5);

    expect(similar.length).toBe(2);
    expect(similar[0].task).toContain('write');
    expect(similar[1].task).toContain('write');
  });

  it('should return recent records when no keywords match', async () => {
    const storage = new MockStorage();
    storage.records = [
      makeRecord({ task: 'alpha' }),
      makeRecord({ task: 'beta' }),
    ];

    const learner = new SkillLearner(storage);
    // Query with very short words that get filtered out
    const similar = await learner.findSimilar('xy', 5);
    expect(similar.length).toBe(2);
  });

  it('should compute recommendations from similar tasks', async () => {
    const storage = new MockStorage();
    storage.records = [
      makeRecord({ task: 'fix login bug', duration: 2000, iterations: 4, toolCalls: 6, outcome: 'success' }),
      makeRecord({ task: 'fix signup bug', duration: 3000, iterations: 5, toolCalls: 8, outcome: 'success' }),
      makeRecord({ task: 'fix logout bug', duration: 4000, iterations: 6, toolCalls: 10, outcome: 'error' }),
    ];

    const learner = new SkillLearner(storage);
    const rec = await learner.getRecommendations('fix bug');

    expect(rec).not.toBeNull();
    expect(rec!.sampleSize).toBe(3);
    expect(rec!.successRate).toBeCloseTo(0.67, 1);
    expect(rec!.avgDuration).toBeGreaterThan(0);
  });

  it('should return null recommendations when no records', async () => {
    const storage = new MockStorage();
    const learner = new SkillLearner(storage);
    const rec = await learner.getRecommendations('anything');
    expect(rec).toBeNull();
  });
});
