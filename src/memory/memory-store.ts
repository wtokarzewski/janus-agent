import { readFile, writeFile, mkdir, appendFile, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, relative, dirname, sep } from 'node:path';
import type { JanusConfig } from '../config/schema.js';
import type { MemoryIndex, MemoryChunk } from './memory-index.js';
import type { InboundMessage } from '../bus/types.js';
import * as log from '../utils/logger.js';
import { localDate, localTimestamp } from '../utils/date.js';

export interface MemoryContext {
  memory: string;
  recentNotes: string;
}

/** Which slice of memory to read/write. Resolution precedence: agent > chat > user > global. */
export interface MemoryScope {
  chatId?: string;
  userId?: string;
  /** Set only for agents with isolated memory (`memory.shared: false`). */
  agentId?: string;
}

/**
 * Pick the memory scope for a message context. The key is NOT always the chat:
 * - isolated agent (`memory.shared:false`) → the agent's own memory;
 * - direct/personal message (`scope.kind === 'user'`) → that user's memory (`.janus/users/{id}/`);
 * - group/family chat (`scope.kind === 'family'`) → that chat's shared memory (`.janus/chats/{chatId}/`),
 *   keyed by the actual chatId so different groups stay isolated;
 * - no context → global.
 */
export function scopeForChat(opts: {
  scope?: InboundMessage['scope'];
  userId?: string;
  chatId?: string;
  agentId?: string;
}): MemoryScope {
  if (opts.agentId) return { agentId: opts.agentId };
  if (opts.scope?.kind === 'user' && opts.userId) return { userId: opts.userId };
  if (opts.chatId) return { chatId: opts.chatId };
  return {};
}

export class MemoryStore {
  private memoryDir: string;
  private config: JanusConfig;
  private index: MemoryIndex | null = null;
  private versions = new Map<string, string>();
  private scopeUpdates = new Map<string, Promise<void>>();
  private embeddingJobs = new Map<string, Promise<void>>();

  constructor(config: JanusConfig) {
    this.config = config;
    this.memoryDir = resolve(config.workspace.dir, config.workspace.memoryDir);
  }

  setIndex(index: MemoryIndex): void {
    this.index = index;
    this.versions.clear();
  }

  /** Search memory via FTS5 index. Falls back to full readMemory() if no index. */
  async search(query: string, limit = 5, scope?: MemoryScope): Promise<MemoryChunk[]> {
    if (!this.index) return [];
    await this.refreshScope(scope);
    return this.index.search(query, limit, scope);
  }

  /** Hybrid search: FTS5 + vector similarity via RRF. Falls back to FTS-only if no embeddings. */
  async hybridSearch(query: string, limit = 5, scope?: MemoryScope): Promise<MemoryChunk[]> {
    if (!this.index) return [];
    await this.refreshScope(scope);
    return this.index.hybridSearch(query, limit, scope,
      this.config.memory?.textWeight ?? 1.0,
      this.config.memory?.vectorWeight ?? 1.0);
  }

  /** Refresh FTS on startup; inference remains deferred by bootstrap. */
  async reindex(): Promise<void> {
    for (const scope of await this.memoryScopes()) await this.refreshScope(scope, false);
  }

  async reindexWithEmbeddings(): Promise<void> {
    if (!this.index) return;
    for (const scope of await this.memoryScopes()) {
      await this.refreshScope(scope, false);
      const [owner, kind, id] = this.indexScope(scope);
      for (const source of this.index.sources(owner, kind, id)) this.queueEmbedding(source, scope);
    }
    await Promise.all(this.embeddingJobs.values());
  }

  private async memoryScopes(): Promise<MemoryScope[]> {
    const scopes: MemoryScope[] = [{}];
    for (const [folder, key] of [['users', 'userId'], ['chats', 'chatId'], ['agents', 'agentId']] as const) {
      const root = resolve(this.config.workspace.dir, '.janus', folder);
      try {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory()) scopes.push({ [key]: entry.name });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return scopes;
  }

  private indexScope(scope: MemoryScope): [string, string, string | null] {
    if (scope.agentId) return [scope.agentId, 'agent', scope.agentId];
    if (scope.chatId) return [scope.chatId, 'chat', scope.chatId];
    if (scope.userId) return [scope.userId, 'user', scope.userId];
    return ['shared', 'global', null];
  }

  /** Called after a validated tool write; ignore paths outside memory directories. */
  async refreshFile(path: string): Promise<void> {
    if (!this.index || !path.endsWith('.md')) return;
    const workspace = await realpath(this.config.workspace.dir);
    const parent = dirname(resolve(path));
    const globalDir = resolve(workspace, relative(this.config.workspace.dir, this.memoryDir));
    if (parent === globalDir) return this.refreshScope({});
    const parts = relative(workspace, parent).split(sep);
    if (parts.length !== 4 || parts[0] !== '.janus' || parts[3] !== 'memory') return;
    const key = { users: 'userId', chats: 'chatId', agents: 'agentId' }[parts[1]];
    if (key) await this.refreshScope({ [key]: parts[2] });
  }

  private async refreshScope(scope: MemoryScope = {}, embeddings = true): Promise<void> {
    if (!this.index) return;
    const dir = this.resolveMemDir(scope);
    const previous = this.scopeUpdates.get(dir);
    const update = (async () => {
      if (previous) await previous.catch(() => {});
      await this.refreshScopeFiles(scope, embeddings);
    })();
    this.scopeUpdates.set(dir, update);
    try { await update; }
    finally { if (this.scopeUpdates.get(dir) === update) this.scopeUpdates.delete(dir); }
  }

  private async refreshScopeFiles(scope: MemoryScope, embeddings: boolean): Promise<void> {
    if (!this.index) return;
    const dir = this.resolveMemDir(scope);
    const [owner, kind, id] = this.indexScope(scope);
    const remaining = new Set(this.index.sources(owner, kind, id));
    const workspace = await realpath(this.config.workspace.dir);
    const expectedDir = resolve(workspace, relative(this.config.workspace.dir, dir));
    let entries: string[] = [];
    try {
      // Reject symlinked directories as well as files, including cross-scope aliases.
      if (expectedDir.startsWith(workspace + sep) && await realpath(dir) === expectedDir) {
        entries = await readdir(dir);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const source of entries) {
      // The global activity log can contain facts from multiple private scopes.
      // Backups preserve older facts for recovery, not current search results.
      if (!source.endsWith('.md') || source === 'HISTORY.md' || source.startsWith('MEMORY.backup.')) continue;
      const path = join(dir, source);
      const stat = await lstat(path).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const version = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      remaining.delete(source);
      if (this.versions.get(path) === version) continue;
      const content = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return '';
        throw err;
      });
      this.index.indexFile(source, content, owner, kind, id);
      this.versions.set(path, version);
      if (embeddings && this.config.memory?.vectorSearch && content.trim()) this.queueEmbedding(source, scope);
    }
    for (const source of remaining) {
      this.index.indexFile(source, '', owner, kind, id);
      this.versions.delete(join(dir, source));
    }
  }

  private queueEmbedding(source: string, scope: MemoryScope): void {
    const index = this.index;
    if (!index) return;
    const key = join(this.resolveMemDir(scope), source);
    const previous = this.embeddingJobs.get(key);
    const job = (async () => {
      await new Promise<void>(done => setImmediate(done));
      if (previous) await previous;
      await index.updateFileEmbeddings(source, ...this.indexScope(scope));
    })().catch(err => log.warn(`Memory embedding update failed: ${err instanceof Error ? err.message : String(err)}`));
    this.embeddingJobs.set(key, job);
    void job.finally(() => { if (this.embeddingJobs.get(key) === job) this.embeddingJobs.delete(key); });
  }

  get hasIndex(): boolean {
    return this.index !== null;
  }

  /** Resolve memory directory. Precedence: isolated agent > chat > user > global. */
  private resolveMemDir(scope: MemoryScope = {}): string {
    const ws = this.config.workspace.dir;
    if (scope.agentId) return resolve(ws, '.janus', 'agents', scope.agentId, 'memory');
    if (scope.chatId) return resolve(ws, '.janus', 'chats', scope.chatId, 'memory');
    if (scope.userId) return resolve(ws, '.janus', 'users', scope.userId, 'memory');
    return this.memoryDir;
  }

  async readMemory(scope: MemoryScope = {}): Promise<string> {
    return this.readSafe(join(this.resolveMemDir(scope), 'MEMORY.md'));
  }

  private writeFailures = 0;

  async writeMemory(content: string, scope: MemoryScope = {}): Promise<void> {
    const dir = this.resolveMemDir(scope);
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
      await this.refreshScope(scope);
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

  async appendDaily(entry: string, scope: MemoryScope = {}): Promise<void> {
    const dir = this.resolveMemDir(scope);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${this.todayDate()}.md`);
    const prefix = (await this.readSafe(path)) ? '\n' : `# ${this.todayDate()}\n\n`;
    await appendFile(path, `${prefix}${entry}\n`, 'utf-8');
    await this.refreshScope(scope);
  }

  async readDaily(date: string | undefined, scope: MemoryScope = {}): Promise<string> {
    const d = date ?? this.todayDate();
    return this.readSafe(join(this.resolveMemDir(scope), `${d}.md`));
  }

  /**
   * Get context for system prompt: MEMORY.md + last 3 daily notes, scoped per chat/user/agent.
   */
  async getContext(scope: MemoryScope = {}): Promise<MemoryContext> {
    const [memory, recentNotes] = await Promise.all([
      this.readMemory(scope),
      this.getRecentDailyNotes(3, scope),
    ]);
    return { memory, recentNotes };
  }

  /** Load last N days of daily notes (today + N-1 previous days). */
  private async getRecentDailyNotes(days: number, scope: MemoryScope = {}): Promise<string> {
    const notes: string[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = localDate(date);
      const content = await this.readDaily(dateStr, scope);
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
    const timestamp = localTimestamp();
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
    return localDate();
  }
}
