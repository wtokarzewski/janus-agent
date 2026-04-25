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

  // Migration 6: per-user cron jobs — user_id column
  `
  ALTER TABLE cron_jobs ADD COLUMN user_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_cron_jobs_user_id ON cron_jobs(user_id);
  `,

  // Migration 7: custom session IDs for cron jobs (K1)
  `
  ALTER TABLE cron_jobs ADD COLUMN session_id TEXT;
  `,

  // Migration 8: chat_id for group chat cron jobs
  `
  ALTER TABLE cron_jobs ADD COLUMN chat_id TEXT;
  `,

  // Migration 9: finished_at for cron run history (CR-AC)
  `
  ALTER TABLE cron_runs ADD COLUMN finished_at TEXT;
  `,

  // Migration 10: agent_id for multi-agent cron jobs
  `
  ALTER TABLE cron_jobs ADD COLUMN agent_id TEXT;
  CREATE INDEX IF NOT EXISTS idx_cron_jobs_agent_id ON cron_jobs(agent_id);
  `,

  // Migration 11: gate audit log — track tool confirmation approvals/denials
  `
  CREATE TABLE IF NOT EXISTS gate_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool TEXT NOT NULL,
    action TEXT NOT NULL,
    approved INTEGER NOT NULL,
    user_id TEXT,
    chat_id TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_gate_audit_timestamp ON gate_audit_log(timestamp);
  `,

  // Migration 12: not_before on cron jobs — prevent jobs from firing before intended start
  `
  ALTER TABLE cron_jobs ADD COLUMN not_before TEXT;
  `,

  // Migration 13: targets array for multi-user cron delivery
  `
ALTER TABLE cron_jobs ADD COLUMN targets TEXT;
`,

  // Migration 14: user_known_chats — per-user channel/chat discovery for skill routing
  `
CREATE TABLE IF NOT EXISTS user_known_chats (
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_name TEXT,
  chat_type TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, channel, chat_id)
);
`,
];
