/**
 * Gate audit log — records tool confirmation approvals/denials to SQLite.
 * Provides accountability for who approved what destructive operations.
 */

import type BetterSqlite3Type from 'better-sqlite3';
import type { GateAuditEntry } from './types.js';
import * as log from '../utils/logger.js';

let db: BetterSqlite3Type.Database | null = null;
let insertStmt: BetterSqlite3Type.Statement | null = null;

export function initGateAudit(database: BetterSqlite3Type.Database): void {
  db = database;
  insertStmt = db.prepare(
    'INSERT INTO gate_audit_log (tool, action, approved, user_id, chat_id) VALUES (?, ?, ?, ?, ?)',
  );
}

export function logGateDecision(entry: GateAuditEntry): void {
  if (!insertStmt) return;
  try {
    insertStmt.run(entry.tool, entry.action, entry.approved ? 1 : 0, entry.userId ?? null, entry.chatId ?? null);
  } catch (err) {
    log.warn(`Gate audit log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
