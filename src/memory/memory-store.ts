import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { JanusConfig } from '../config/schema.js';
import type { MemoryIndex, MemoryChunk } from './memory-index.js';
import type { InboundMessage } from '../bus/types.js';

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
    return this.index.hybridSearch(query, limit, userId, scope);
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

    // Per-user files: scan ~/.janus/users/{userId}/memory/
    if (this.config.users.length > 0) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      if (home) {
        for (const user of this.config.users) {
          const userMemDir = resolve(home, '.janus', 'users', user.id, 'memory');
          const userFiles = await this.collectDirMemoryFiles(userMemDir);
          for (const f of userFiles) {
            files.push({ ...f, owner: user.id, scope: 'user', scopeId: user.id });
          }
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

  async readMemory(): Promise<string> {
    return this.readSafe(join(this.memoryDir, 'MEMORY.md'));
  }

  async writeMemory(content: string): Promise<void> {
    await mkdir(this.memoryDir, { recursive: true });
    await writeFile(join(this.memoryDir, 'MEMORY.md'), content, 'utf-8');
  }

  async appendDaily(entry: string, userId?: string, scope?: InboundMessage['scope']): Promise<void> {
    let dir = this.memoryDir;

    // Per-user private memory goes to ~/.janus/users/{userId}/memory/
    if (scope?.kind === 'user' && userId) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      if (home) {
        dir = resolve(home, '.janus', 'users', userId, 'memory');
      }
    }
    // Family scope stays in workspace memory (owner='shared', scope='family')
    // No scope / global: workspace memory (existing behavior)

    await mkdir(dir, { recursive: true });
    const path = join(dir, `${this.todayDate()}.md`);
    const prefix = (await this.readSafe(path)) ? '\n' : `# ${this.todayDate()}\n\n`;
    await appendFile(path, `${prefix}${entry}\n`, 'utf-8');
  }

  async readDaily(date?: string): Promise<string> {
    const d = date ?? this.todayDate();
    return this.readSafe(join(this.memoryDir, `${d}.md`));
  }

  /**
   * Get context for system prompt.
   * Loads MEMORY.md + last 3 daily notes for system prompt context.
   */
  async getContext(): Promise<MemoryContext> {
    const [memory, recentNotes] = await Promise.all([
      this.readMemory(),
      this.getRecentDailyNotes(3),
    ]);
    return { memory, recentNotes };
  }

  /** Load last N days of daily notes (today + N-1 previous days). */
  private async getRecentDailyNotes(days: number): Promise<string> {
    const notes: string[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().slice(0, 10);
      const content = await this.readDaily(dateStr);
      if (content.trim()) {
        notes.push(`<!-- ${dateStr} -->\n${content.trim()}`);
      }
    }

    return notes.join('\n\n');
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
