import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { createTestConfig, createTempDir } from '../helpers/test-fixtures.js';

describe('MemoryStore per-chat scoping', () => {
  let tempDir: string;
  let memory: MemoryStore;

  beforeEach(() => {
    tempDir = createTempDir();
    memory = new MemoryStore(createTestConfig({ workspace: { dir: tempDir } }));
  });

  it('writes MEMORY.md under chats/{chatId}/memory when chatId is given', async () => {
    await memory.writeMemory('chat-A facts', { chatId: 'A' });
    const path = join(tempDir, '.janus', 'chats', 'A', 'memory', 'MEMORY.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('chat-A facts');
  });

  it('isolates MEMORY.md between chats', async () => {
    await memory.writeMemory('secret from A', { chatId: 'A' });
    expect(await memory.readMemory({ chatId: 'B' })).toBe('');
    expect(await memory.readMemory({ chatId: 'A' })).toContain('secret from A');
  });

  it('routes and isolates daily notes per chat', async () => {
    await memory.appendDaily('A daily entry', { chatId: 'A' });
    const ctxA = await memory.getContext({ chatId: 'A' });
    const ctxB = await memory.getContext({ chatId: 'B' });
    expect(ctxA.recentNotes).toContain('A daily entry');
    expect(ctxB.recentNotes).not.toContain('A daily entry');
  });

  it('isolated agent memory (agentId) takes precedence over chatId', async () => {
    await memory.writeMemory('agent mem', { chatId: 'A', agentId: 'diet' });
    const agentPath = join(tempDir, '.janus', 'agents', 'diet', 'memory', 'MEMORY.md');
    expect(existsSync(agentPath)).toBe(true);
  });

  it('falls back to the global memory dir when scope is empty', async () => {
    await memory.writeMemory('global fact', {});
    const path = join(tempDir, 'memory', 'MEMORY.md');
    expect(readFileSync(path, 'utf-8')).toContain('global fact');
  });
});
