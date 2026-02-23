/**
 * SQLite-based learner storage — drop-in replacement for JSONLLearnerStorage.
 * Implements the same LearnerStorage interface.
 */

import type BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import type { ExecutionRecord, LearnerStorage } from './types.js';
import * as log from '../utils/logger.js';

export class SQLiteLearnerStorage implements LearnerStorage {
  private db: BetterSqlite3.Database;

  constructor(database: Database) {
    this.db = database.db;
  }

  async append(record: ExecutionRecord): Promise<void> {
    try {
      this.db.prepare(`
        INSERT INTO learner_records (task, duration, iterations, tool_calls, token_usage, outcome, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.task,
        record.duration,
        record.iterations,
        record.toolCalls,
        record.tokenUsage,
        record.outcome,
        record.timestamp,
      );
    } catch (err) {
      log.error(`SQLite learner write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getAll(): Promise<ExecutionRecord[]> {
    return this.mapRows(
      this.db.prepare('SELECT * FROM learner_records ORDER BY timestamp').all() as RawRow[],
    );
  }

  async getRecent(limit: number): Promise<ExecutionRecord[]> {
    return this.mapRows(
      this.db.prepare('SELECT * FROM learner_records ORDER BY timestamp DESC LIMIT ?').all(limit) as RawRow[],
    ).reverse();
  }

  private mapRows(rows: RawRow[]): ExecutionRecord[] {
    return rows.map(r => ({
      task: r.task,
      duration: r.duration,
      iterations: r.iterations,
      toolCalls: r.tool_calls,
      tokenUsage: r.token_usage,
      outcome: r.outcome as ExecutionRecord['outcome'],
      timestamp: r.timestamp,
    }));
  }
}

interface RawRow {
  id: number;
  task: string;
  duration: number;
  iterations: number;
  tool_calls: number;
  token_usage: number;
  outcome: string;
  timestamp: string;
}
