/**
 * Database migrations — numbered SQL statements applied in order.
 * Each migration runs once; applied version tracked in `schema_version` pragma.
 */

export const migrations: string[] = [
  // Migration 1: memory_chunks + FTS5
  `
  CREATE TABLE IF NOT EXISTS memory_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    heading TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
    heading, content, content=memory_chunks, content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
    INSERT INTO memory_chunks_fts(rowid, heading, content) VALUES (new.id, new.heading, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
    INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, heading, content) VALUES('delete', old.id, old.heading, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
    INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, heading, content) VALUES('delete', old.id, old.heading, old.content);
    INSERT INTO memory_chunks_fts(rowid, heading, content) VALUES (new.id, new.heading, new.content);
  END;
  `,

  // Migration 2: learner_records
  `
  CREATE TABLE IF NOT EXISTS learner_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    duration INTEGER NOT NULL,
    iterations INTEGER NOT NULL,
    tool_calls INTEGER NOT NULL,
    token_usage INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
  `,

  // Migration 3: cron_jobs + cron_runs
  `
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule_kind TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    schedule_tz TEXT,
    task TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    consecutive_errors INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cron_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    duration_ms INTEGER
  );
  `,

  // Migration 4: embedding column for vector search
  `
  ALTER TABLE memory_chunks ADD COLUMN embedding BLOB;
  `,

  // Migration 5: multi-user — owner, scope, scope_id columns
  `
  ALTER TABLE memory_chunks ADD COLUMN owner TEXT NOT NULL DEFAULT 'shared';
  ALTER TABLE memory_chunks ADD COLUMN scope TEXT NOT NULL DEFAULT 'global';
  ALTER TABLE memory_chunks ADD COLUMN scope_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_memory_chunks_owner ON memory_chunks(owner);
  CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope ON memory_chunks(scope);
  CREATE INDEX IF NOT EXISTS idx_memory_chunks_scope_id ON memory_chunks(scope_id);
  `,
];
