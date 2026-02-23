import type { ExecutionRecord, LearnerStorage } from './types.js';
import * as log from '../utils/logger.js';

export interface Recommendation {
  avgDuration: number;
  avgIterations: number;
  avgToolCalls: number;
  successRate: number;
  sampleSize: number;
}

/**
 * SkillLearner — records execution metrics and recommends approaches based on history.
 *
 * Phase 2: JSONL storage, simple keyword matching.
 * Phase 3: SQLite + embedding-based similarity search.
 */
export class SkillLearner {
  private storage: LearnerStorage;

  constructor(storage: LearnerStorage) {
    this.storage = storage;
  }

  async recordExecution(record: ExecutionRecord): Promise<void> {
    await this.storage.append(record);
    log.debug(`Learner: recorded execution (${record.outcome}, ${record.iterations} iters, ${record.duration}ms)`);
  }

  /**
   * Find executions with similar task descriptions.
   * Uses simple keyword overlap for now.
   */
  async findSimilar(task: string, limit = 5): Promise<ExecutionRecord[]> {
    const records = await this.storage.getAll();
    const keywords = extractKeywords(task);

    if (keywords.length === 0) return records.slice(-limit);

    const scored = records.map(r => ({
      record: r,
      score: computeOverlap(keywords, extractKeywords(r.task)),
    }));

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.record);
  }

  /**
   * Get aggregate recommendations based on similar past executions.
   */
  async getRecommendations(task: string): Promise<Recommendation | null> {
    const similar = await this.findSimilar(task, 10);
    if (similar.length === 0) return null;

    const successes = similar.filter(r => r.outcome === 'success');
    const successRate = successes.length / similar.length;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      avgDuration: Math.round(avg(similar.map(r => r.duration))),
      avgIterations: Math.round(avg(similar.map(r => r.iterations)) * 10) / 10,
      avgToolCalls: Math.round(avg(similar.map(r => r.toolCalls)) * 10) / 10,
      successRate: Math.round(successRate * 100) / 100,
      sampleSize: similar.length,
    };
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function computeOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  let overlap = 0;
  for (const word of a) {
    if (setB.has(word)) overlap++;
  }
  return overlap;
}
