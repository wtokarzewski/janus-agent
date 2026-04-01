import { readFile, writeFile, appendFile, mkdir, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMMessage } from '../llm/types.js';
import type { JanusConfig } from '../config/schema.js';
import * as log from '../utils/logger.js';

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
  private toolResultMaxShare: number;
  private toolResultHardMax: number;
  private cache = new Map<string, Session>();
  private locks = new Map<string, Promise<void>>();

  constructor(config: JanusConfig) {
    this.sessionsDir = resolve(config.workspace.dir, config.workspace.sessionsDir);
    this.contextWindow = config.agent.contextWindow;
    this.toolResultMaxShare = config.agent.context.toolResultMaxShare;
    this.toolResultHardMax = config.agent.context.toolResultHardMax;
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
   * Summarize old messages when conversation gets too long.
   * Token-based retention: walk backwards keeping keepRecentTokens worth of messages,
   * snapping the cut point forward to the nearest user message boundary.
   */
  async summarize(key: string, summaryText: string, keepRecentTokens: number): Promise<void> {
    return this.withLock(key, async () => {
      const session = await this.getOrCreateInner(key);

      // Token-based cut point: walk backwards counting tokens
      let tokens = 0;
      let cutIndex = 0; // default: keep everything (cut at start)
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const msg = session.messages[i];
        const content = 'content' in msg ? msg.content : '';
        const msgTokens = typeof content === 'string' ? Math.ceil(content.length / 2.5) : 100;
        if (tokens + msgTokens > keepRecentTokens) {
          cutIndex = i + 1;
          // Snap forward to nearest user message boundary
          for (let j = cutIndex; j < session.messages.length; j++) {
            if (session.messages[j].role === 'user') { cutIndex = j; break; }
          }
          break;
        }
        tokens += msgTokens;
      }

      // If cut would remove fewer than 4 messages, skip (not worth summarizing)
      if (cutIndex < 4) return;

      session.messages = session.messages.slice(cutIndex);
      session.metadata.summary = summaryText;
      session.metadata.messageCount = session.messages.length;
      session.metadata.lastFlushed = 0; // Reset pointer — remaining messages may need re-flush

      // Full rewrite — truncates JSONL to only post-compaction messages
      await this.save(key, session);
      log.debug(`Summarized session ${key}, kept ${session.messages.length} messages from index ${cutIndex} (JSONL truncated)`);
    });
  }

  private truncateToolResult(content: string): string {
    // Dynamic cap: contextWindow tokens × 2.5 chars/token × share fraction
    const dynamicCap = Math.floor(this.contextWindow * 2.5 * this.toolResultMaxShare);
    const cap = Math.min(dynamicCap, this.toolResultHardMax);
    if (content.length <= cap) return content;

    // Head+tail truncation: 70% head + marker + 30% tail
    const headLen = Math.floor(cap * 0.7);
    const tailLen = cap - headLen;
    const removed = content.length - headLen - tailLen;
    const marker = `\n\n[truncated: ${removed} chars removed to fit context budget]\n\n`;
    return content.slice(0, headLen) + marker + content.slice(-tailLen);
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
        messages.push(JSON.parse(lines[i]) as LLMMessage);
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
