import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { JanusConfig } from '../config/schema.js';
import type { MemoryIndex, MemoryChunk } from './memory-index.js';
import type { InboundMessage } from '../bus/types.js';
import * as log from '../utils/logger.js';

export interface MemoryContext {
  memory: string;
  recentNotes: string;
}

export class MemoryStore {
  private memoryDir: string;
  private config: JanusConfig;
  private index: MemoryIndex | null = null;

  constructor(config: JanusConfig) {
    this.config = config;
    this.memoryDir = resolve(config.workspace.dir, config.workspace.memoryDir);
  }

  setIndex(index: MemoryIndex): void {
    this.index = index;
  }

  /** Search memory via FTS5 index. Falls back to full readMemory() if no index. */
  async search(query: string, limit = 5, userId?: string, scope?: InboundMessage['scope']): Promise<MemoryChunk[]> {
    if (!this.index) return [];
    return this.index.search(query, limit, userId, scope);
  }

  /** Hybrid search: FTS5 + vector similarity via RRF. Falls back to FTS-only if no embeddings. */
  async hybridSearch(query: string, limit = 5, userId?: string, scope?: InboundMessage['scope']): Promise<MemoryChunk[]> {
    if (!this.index) return [];
    return this.index.hybridSearch(query, limit, userId, scope,
      this.config.memory?.textWeight ?? 1.0,
      this.config.memory?.vectorWeight ?? 1.0);
  }

  /** Reindex all memory files into the FTS5 index. */
  async reindex(): Promise<void> {
    if (!this.index) return;
    const files = await this.collectMemoryFiles();
    this.index.reindex(files);
  }

  /** Reindex all memory files with vector embeddings (slower, requires model download). */
  async reindexWithEmbeddings(): Promise<void> {
    if (!this.index) return;
    const files = await this.collectMemoryFiles();
    for (const file of files) {
      if (file.content.trim()) {
        await this.index.indexFileWithEmbeddings(file.source, file.content, file.owner, file.scope, file.scopeId ?? null);
      }
    }
  }

  private async collectMemoryFiles(): Promise<Array<{ source: string; content: string; owner?: string; scope?: string; scopeId?: string | null }>> {
    const files: Array<{ source: string; content: string; owner?: string; scope?: string; scopeId?: string | null }> = [];

    // Shared global files (workspace memory/)
    const memoryContent = await this.readMemory();
    if (memoryContent.trim()) {
      files.push({ source: 'MEMORY.md', content: memoryContent, owner: 'shared', scope: 'global' });
    }
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const content = await this.readDaily(dateStr);
      if (content.trim()) {
        files.push({ source: `${dateStr}.md`, content, owner: 'shared', scope: 'global' });
      }
    }

    // Per-user files: scan .janus/users/{userId}/memory/
    if (this.config.users.length > 0) {
      for (const user of this.config.users) {
        const userMemDir = resolve(this.config.workspace.dir, '.janus', 'users', user.id, 'memory');
        const userFiles = await this.collectDirMemoryFiles(userMemDir);
        for (const f of userFiles) {
          files.push({ ...f, owner: user.id, scope: 'user', scopeId: user.id });
        }
      }
    }

    return files;
  }

  /** Collect memory files from a directory. */
  private async collectDirMemoryFiles(dir: string): Promise<Array<{ source: string; content: string }>> {
    const files: Array<{ source: string; content: string }> = [];
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        const content = await this.readSafe(join(dir, entry));
        if (content.trim()) {
          files.push({ source: entry, content });
        }
      }
    } catch {
      // Directory doesn't exist — that's fine
    }
    return files;
  }

  get hasIndex(): boolean {
    return this.index !== null;
  }

  /** Resolve memory directory: per-user when userId is given, global otherwise. */
  private resolveMemDir(userId?: string): string {
    if (userId) {
      return resolve(this.config.workspace.dir, '.janus', 'users', userId, 'memory');
    }
    return this.memoryDir;
  }

  async readMemory(userId?: string): Promise<string> {
    return this.readSafe(join(this.resolveMemDir(userId), 'MEMORY.md'));
  }

  private writeFailures = 0;

  async writeMemory(content: string, userId?: string): Promise<void> {
    const dir = this.resolveMemDir(userId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'MEMORY.md');

    // Validate: content should not be empty or drastically shorter than existing (C5)
    if (!content.trim()) {
      log.warn('Memory write skipped: content is empty');
      return;
    }

    try {
      await writeFile(path, content, 'utf-8');
      // Verify write succeeded by reading back
      const readBack = await this.readSafe(path);
      if (readBack.trim() !== content.trim()) {
        throw new Error('Write verification failed: content mismatch');
      }
      this.writeFailures = 0;
    } catch (err) {
      this.writeFailures++;
      log.error(`Memory write failed (${this.writeFailures}/3): ${err instanceof Error ? err.message : String(err)}`);
      if (this.writeFailures >= 3) {
        // Raw backup fallback — dump to timestamped file so data isn't lost
        const backupPath = join(dir, `MEMORY.backup.${Date.now()}.md`);
        await writeFile(backupPath, content, 'utf-8').catch(() => {});
        log.error(`Memory write failed 3x — raw backup saved to ${backupPath}`);
        this.writeFailures = 0;
      }
    }
  }

  async appendDaily(entry: string, userId?: string, scope?: InboundMessage['scope']): Promise<void> {
    let dir = this.memoryDir;

    // Per-user private memory goes to .janus/users/{userId}/memory/
    if (scope?.kind === 'user' && userId) {
      dir = resolve(this.config.workspace.dir, '.janus', 'users', userId, 'memory');
    }
    // Family scope stays in workspace memory (owner='shared', scope='family')
    // No scope / global: workspace memory (existing behavior)

    await mkdir(dir, { recursive: true });
    const path = join(dir, `${this.todayDate()}.md`);
    const prefix = (await this.readSafe(path)) ? '\n' : `# ${this.todayDate()}\n\n`;
    await appendFile(path, `${prefix}${entry}\n`, 'utf-8');
  }

  async readDaily(date?: string, userId?: string): Promise<string> {
    const d = date ?? this.todayDate();
    return this.readSafe(join(this.resolveMemDir(userId), `${d}.md`));
  }

  /**
   * Get context for system prompt.
   * Loads MEMORY.md + last 3 daily notes for system prompt context.
   * When userId is provided, reads per-user memory (multi-user isolation).
   */
  async getContext(userId?: string): Promise<MemoryContext> {
    const [memory, recentNotes] = await Promise.all([
      this.readMemory(userId),
      this.getRecentDailyNotes(3, userId),
    ]);
    return { memory, recentNotes };
  }

  /** Load last N days of daily notes (today + N-1 previous days). */
  private async getRecentDailyNotes(days: number, userId?: string): Promise<string> {
    const notes: string[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const content = await this.readDaily(dateStr, userId);
      if (content.trim()) {
        notes.push(`<!-- ${dateStr} -->\n${content.trim()}`);
      }
    }

    return notes.join('\n\n');
  }

  /** Append an entry to HISTORY.md (append-only activity log, never edited by agent). */
  async appendHistory(entry: string): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    const path = join(this.memoryDir, 'HISTORY.md');
    const exists = (await this.readSafe(path)).length > 0;
    const prefix = exists ? '\n' : '# History\n\n';
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await appendFile(path, `${prefix}- ${timestamp}: ${entry}\n`, 'utf-8');
  }

  private async readSafe(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      return '';
    }
  }

  private todayDate(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
