/**
 * Database singleton — opens SQLite with WAL mode, applies numbered migrations.
 * Graceful: if SQLite fails to init, callers should fall back to file-based storage.
 */

import BetterSqlite3 from 'better-sqlite3';
import type BetterSqlite3Type from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.js';
import * as log from '../utils/logger.js';

export class Database {
  readonly db: BetterSqlite3Type.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.applyMigrations();
    log.info(`Database opened: ${dbPath}`);
  }

  private applyMigrations(): void {
    const currentVersion = this.db.pragma('user_version', { simple: true }) as number;

    for (let i = currentVersion; i < migrations.length; i++) {
      log.info(`Applying migration ${i + 1}/${migrations.length}...`);
      this.db.exec(migrations[i]);
    }

    if (currentVersion < migrations.length) {
      this.db.pragma(`user_version = ${migrations.length}`);
      log.info(`Database migrated to version ${migrations.length}`);
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Try to create a Database instance. Returns null on failure (caller should fallback).
 */
export function tryCreateDatabase(dbPath: string): Database | null {
  try {
    return new Database(dbPath);
  } catch (err) {
    log.warn(`Database init failed (falling back to file-based storage): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
