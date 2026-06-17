import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMMessage } from '../llm/types.js';
import type { JanusConfig } from '../config/schema.js';
import * as log from '../utils/logger.js';
import { stripJsonSurrogates, safeSlice } from '../utils/sanitize.js';
import { resolveBudget, CHARS_PER_TOKEN_ESTIMATE } from '../context/context-manager.js';

// Unified tool result cap: 50% of effective budget converted to chars.
// SAME cap applied in-loop (agent-loop.ts) and on-disk here — no more 100x mismatch
// where sessions reload 100x larger than they were "live".
const TOOL_RESULT_CAP_RATIO = 0.5;

export interface SessionMetadata {
  key: string;
  created: string;
  updated: string;
  messageCount: number;
  summary?: string;
  lastFlushed?: number;
}

export interface Session {
  metadata: SessionMetadata;
  messages: LLMMessage[];
}

/**
 * JSONL session manager with atomic writes.
 * Format: first line = metadata, remaining lines = messages.
 */
export class SessionManager {
  private sessionsDir: string;
  private contextWindow: number;
  private cache = new Map<string, Session>();
  private locks = new Map<string, Promise<void>>();

  constructor(config: JanusConfig) {
    this.sessionsDir = resolve(config.workspace.dir, config.workspace.sessionsDir);
    this.contextWindow = config.agent.contextWindow;
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let resolve!: (v: void) => void;
    const next = new Promise<void>(r => { resolve = r; });
    this.locks.set(key, next);
    return prev.then(fn).finally(() => resolve());
  }

  async getOrCreate(key: string): Promise<Session> {
    return this.withLock(key, () => this.getOrCreateInner(key));
  }

  private async getOrCreateInner(key: string): Promise<Session> {
    // Check cache
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Try load from disk
    const path = this.sessionPath(key);
    try {
      const content = await readFile(path, 'utf-8');
      const session = this.parseJSONL(content, key);
      this.cache.set(key, session);
      return session;
    } catch {
      // Legacy session migration: if agent-prefixed key not found, try without agent prefix
      const colonCount = key.split(':').length - 1;
      if (colonCount >= 2) {
        const legacyKey = key.slice(key.indexOf(':') + 1);
        const legacyPath = this.sessionPath(legacyKey);
        try {
          const content = await readFile(legacyPath, 'utf-8');
          const session = this.parseJSONL(content, key); // Use new key for session metadata
          this.cache.set(key, session);
          // Rename file to new location (fire and forget)
          await rename(legacyPath, path).catch(() => {});
          log.info(`Migrated session ${legacyKey} → ${key}`);
          return session;
        } catch {
          // Legacy not found either — create new
        }
      }
      // Create new session
      const session: Session = {
        metadata: {
          key,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          messageCount: 0,
        },
        messages: [],
      };
      this.cache.set(key, session);
      return session;
    }
  }

  async append(key: string, messages: LLMMessage[]): Promise<void> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);
      const isNew = session.messages.length === 0;

      // Truncate oversized tool results at persist time
      const processed = messages.map(m => {
        if (m.role === 'tool' && typeof m.content === 'string') {
          return { ...m, content: this.truncateToolResult(m.content) };
        }
        return m;
      });

      session.messages.push(...processed);
      session.metadata.messageCount = session.messages.length;
      session.metadata.updated = new Date().toISOString();

      if (isNew) {
        // First append — write full file (metadata + messages)
        await this.save(key, session);
      } else {
        // Incremental — append new lines + rewrite metadata header
        await this.appendIncremental(key, session, processed);
      }
    });
  }

  async getHistory(key: string): Promise<LLMMessage[]> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);
      return session.messages;
    });
  }

  /**
   * Compact session by archiving the current JSONL and writing a new one starting
   * with a compaction entry + the tail messages. Replaces the older "in-place
   * truncate" approach so on-disk session size is BOUNDED (~keepRecentTokens).
   *
   * After rotation:
   *   - {key}.jsonl       — new file: metadata + compaction entry + tail messages
   *   - {key}.{ts}.jsonl  — archive: previous file (kept for forensics, never reloaded)
   */
  async summarize(key: string, summaryText: string, keepRecentTokens: number): Promise<void> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);
      const cutIndex = this.findTailCutIndex(session.messages, keepRecentTokens);

      // If cut would remove fewer than 4 messages, skip (not worth summarizing)
      if (cutIndex < 4) return;

      const path = this.sessionPath(key);
      const archivePath = `${path}.${Date.now()}.jsonl`;

      // Archive current file (best-effort — if rename fails, we still write the new one)
      try {
        await rename(path, archivePath);
      } catch (err) {
        log.warn(`[session ${key}] Archive rename failed (proceeding without): ${err instanceof Error ? err.message : String(err)}`);
      }

      const tailMessages = session.messages.slice(cutIndex);
      const newMetadata: SessionMetadata = {
        ...session.metadata,
        summary: summaryText,
        messageCount: tailMessages.length,
        lastFlushed: tailMessages.length, // post-compaction tail is considered already flushed
        updated: new Date().toISOString(),
      };

      // Write new file: metadata + compaction entry + tail messages
      try {
        await mkdir(dirname(path), { recursive: true });
        const lines: string[] = [
          JSON.stringify({ _type: 'metadata', ...newMetadata }),
          JSON.stringify({ _type: 'compaction', summary: summaryText, archivedAt: new Date().toISOString(), archivePath }),
          ...tailMessages.map(m => JSON.stringify(m)),
        ];
        const tempPath = `${path}.${randomUUID().slice(0, 8)}.tmp`;
        await writeFile(tempPath, lines.join('\n') + '\n', 'utf-8');
        await rename(tempPath, path);
      } catch (err) {
        log.error(`[session ${key}] Rotation write failed: ${err instanceof Error ? err.message : err}`);
        // We've already archived; cache stays in old state until next successful save
        return;
      }

      // Update cache atomically
      session.messages = tailMessages;
      session.metadata = newMetadata;
      this.cache.set(key, session);

      log.info(`[session ${key}] rotated: ${session.messages.length + cutIndex} → ${tailMessages.length} messages; archive: ${archivePath}`);
    });
  }

  /**
   * Walk backwards from the end of messages accumulating tokens. Return the
   * index of the cut point — messages[0..cutIndex) go into the summary,
   * messages[cutIndex..) are kept as the tail.
   *
   * Snaps the cut forward to the next user message boundary to keep
   * assistant+tool groups intact in the tail.
   */
  private findTailCutIndex(messages: LLMMessage[], keepRecentTokens: number): number {
    let tokens = 0;
    let cutIndex = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const content = 'content' in msg ? msg.content : '';
      let msgTokens: number;
      if (typeof content === 'string') {
        msgTokens = Math.ceil(content.length / CHARS_PER_TOKEN_ESTIMATE);
      } else if (Array.isArray(content)) {
        const textLen = content.reduce((sum: number, b: { type: string; text?: string }) => sum + (b.type === 'text' && b.text ? b.text.length : 0), 0);
        const imageCount = content.filter((b: { type: string }) => b.type === 'image').length;
        msgTokens = Math.ceil(textLen / CHARS_PER_TOKEN_ESTIMATE) + imageCount * 1000;
      } else {
        msgTokens = 100;
      }
      if (tokens + msgTokens > keepRecentTokens) {
        cutIndex = i + 1;
        // Snap forward to next user message boundary
        for (let j = cutIndex; j < messages.length; j++) {
          if (messages[j].role === 'user') { cutIndex = j; break; }
        }
        break;
      }
      tokens += msgTokens;
    }
    return cutIndex;
  }

  /**
   * Last-resort fallback when compaction fails (e.g. LLM timeout). Drops the
   * oldest `ratio` fraction of messages WITHOUT a summary. Loud log entry —
   * this should be rare. Better than infinite cascade.
   */
  async forceDropOldest(key: string, ratio: number): Promise<void> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);
      let dropCount = Math.floor(session.messages.length * ratio);
      if (dropCount < 4) return;

      // Snap to next user message boundary so we don't orphan tool messages
      for (let j = dropCount; j < session.messages.length; j++) {
        if (session.messages[j].role === 'user') { dropCount = j; break; }
      }

      const droppedCount = dropCount;
      session.messages = session.messages.slice(dropCount);
      session.metadata.summary = `[compaction failed; force-dropped oldest ${droppedCount} messages at ${new Date().toISOString()}]`;
      session.metadata.messageCount = session.messages.length;
      session.metadata.lastFlushed = session.messages.length;
      session.metadata.updated = new Date().toISOString();

      await this.save(key, session);
      log.warn(`[session ${key}] force-dropped ${droppedCount} oldest messages (compaction fallback)`);
    });
  }

  /** Clear all messages from a session, preserving the session file. */
  async clear(key: string): Promise<void> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);
      session.messages = [];
      session.metadata.summary = undefined;
      session.metadata.messageCount = 0;
      session.metadata.lastFlushed = 0;
      session.metadata.updated = new Date().toISOString();
      await this.save(key, session);
    });
  }

  /**
   * Unified tool-result cap. Derived from effective budget (contextWindow minus
   * reserved output). Same cap used in-loop by the agent loop — no disk/memory
   * mismatch on session reload.
   */
  toolResultCap(): number {
    const budget = resolveBudget({ modelContextWindow: this.contextWindow });
    return Math.floor(budget.effective * CHARS_PER_TOKEN_ESTIMATE * TOOL_RESULT_CAP_RATIO);
  }

  truncateToolResult(content: string): string {
    const cap = this.toolResultCap();
    if (content.length <= cap) return content;

    // Head+tail truncation: 70% head + marker + 30% tail
    const headLen = Math.floor(cap * 0.7);
    const tailLen = cap - headLen;
    const removed = content.length - headLen - tailLen;
    const marker = `\n\n[truncated: ${removed} chars removed to fit context budget]\n\n`;
    // safeSlice so a split surrogate pair never lands in the archived JSONL
    return safeSlice(content, 0, headLen) + marker + safeSlice(content, content.length - tailLen);
  }

  private async appendIncremental(key: string, session: Session, newMessages: LLMMessage[]): Promise<void> {
    try {
      const path = this.sessionPath(key);
      const newLines = newMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
      await appendFile(path, newLines, 'utf-8');
    } catch {
      // Fallback to full rewrite on append failure
      await this.save(key, session);
    }
  }

  private async save(key: string, session: Session): Promise<void> {
    try {
      const path = this.sessionPath(key);
      await mkdir(dirname(path), { recursive: true });

      const lines: string[] = [
        JSON.stringify({ _type: 'metadata', ...session.metadata }),
        ...session.messages.map(m => JSON.stringify(m)),
      ];

      // Atomic write: temp → write → rename
      const tempPath = `${path}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(tempPath, lines.join('\n') + '\n', 'utf-8');
      await rename(tempPath, path);
    } catch (err) {
      log.error(`Session save failed for ${key}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private parseJSONL(content: string, key: string): Session {
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) {
      return {
        metadata: { key, created: new Date().toISOString(), updated: new Date().toISOString(), messageCount: 0 },
        messages: [],
      };
    }

    let first: Record<string, unknown>;
    try {
      first = JSON.parse(lines[0]) as Record<string, unknown>;
    } catch {
      log.warn(`Corrupted metadata in session ${key}, starting fresh`);
      return {
        metadata: { key, created: new Date().toISOString(), updated: new Date().toISOString(), messageCount: 0 },
        messages: [],
      };
    }
    const metadata: SessionMetadata = first._type === 'metadata'
      ? { key: String(first.key ?? key), created: String(first.created), updated: String(first.updated), messageCount: Number(first.messageCount ?? 0), summary: first.summary as string | undefined, lastFlushed: first.lastFlushed as number | undefined }
      : { key, created: new Date().toISOString(), updated: new Date().toISOString(), messageCount: 0 };

    const startIdx = first._type === 'metadata' ? 1 : 0;
    const messages: LLMMessage[] = [];
    for (let i = startIdx; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(stripJsonSurrogates(lines[i])) as Record<string, unknown> & LLMMessage;
        // Skip control entries (compaction markers, future _type extensions) — they
        // belong to session metadata, not the message stream sent to the LLM.
        if ('_type' in parsed) continue;
        messages.push(parsed as LLMMessage);
      } catch {
        log.warn(`Skipping invalid JSONL line ${i} in session ${key}`);
      }
    }

    metadata.messageCount = messages.length;
    return { metadata, messages };
  }

  private sessionPath(key: string): string {
    // Sanitize key for filesystem: replace colons with underscores
    const safeKey = key.replace(/[:/\\]/g, '_');
    return join(this.sessionsDir, `${safeKey}.jsonl`);
  }
}
