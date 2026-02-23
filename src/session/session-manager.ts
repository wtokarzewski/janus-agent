import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
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
  private cache = new Map<string, Session>();

  constructor(config: JanusConfig) {
    this.sessionsDir = resolve(config.workspace.dir, config.workspace.sessionsDir);
  }

  async getOrCreate(key: string): Promise<Session> {
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
    const session = await this.getOrCreate(key);
    session.messages.push(...messages);
    session.metadata.messageCount = session.messages.length;
    session.metadata.updated = new Date().toISOString();

    await this.save(key, session);
  }

  async getHistory(key: string, maxMessages = 50): Promise<LLMMessage[]> {
    const session = await this.getOrCreate(key);
    if (session.messages.length <= maxMessages) return session.messages;
    return session.messages.slice(-maxMessages);
  }

  /**
   * Summarize old messages when conversation gets too long.
   * Strategy: split-half-merge — summarize first half, keep last 4 messages.
   */
  async summarize(key: string, summaryText: string): Promise<void> {
    const session = await this.getOrCreate(key);

    if (session.messages.length <= 8) return; // nothing to summarize

    // Keep last 4 messages
    const keepCount = 4;
    session.messages = session.messages.slice(-keepCount);
    session.metadata.summary = summaryText;
    session.metadata.messageCount = session.messages.length;

    await this.save(key, session);
    log.debug(`Summarized session ${key}, kept ${keepCount} messages`);
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
      ? { key: String(first.key ?? key), created: String(first.created), updated: String(first.updated), messageCount: Number(first.messageCount ?? 0), summary: first.summary as string | undefined }
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
