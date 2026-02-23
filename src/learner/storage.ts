import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExecutionRecord, LearnerStorage } from './types.js';
import * as log from '../utils/logger.js';

/**
 * JSONL-based learner storage.
 * Each line is a JSON-encoded ExecutionRecord.
 * No external dependencies — migrates to SQLite in Phase 3 via LearnerStorage interface.
 */
export class JSONLLearnerStorage implements LearnerStorage {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async append(record: ExecutionRecord): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (err) {
      log.error(`Learner storage write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getAll(): Promise<ExecutionRecord[]> {
    return this.readRecords();
  }

  async getRecent(limit: number): Promise<ExecutionRecord[]> {
    const records = await this.readRecords();
    return records.slice(-limit);
  }

  private async readRecords(): Promise<ExecutionRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const records: ExecutionRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as ExecutionRecord);
        } catch {
          log.debug(`Learner: skipping invalid JSONL line`);
        }
      }
      return records;
    } catch {
      return [];
    }
  }
}
