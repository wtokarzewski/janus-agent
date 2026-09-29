import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/session/session-manager.js';
import type { LLMMessage } from '../../src/llm/types.js';
import type { JanusConfig } from '../../src/config/schema.js';

function createTestConfig(workDir: string): JanusConfig {
  return {
    workspace: { dir: workDir, sessionsDir: 'sessions', skillsDir: 'skills', skillBaseDirs: [] },
    agent: {
      contextWindow: 200_000,
      tokenBudget: 750_000,
      maxIterations: 50,
      toolRetries: 2,
      onToolError: 'continue',
      onLLMError: 'fail',
      summarizationThreshold: 40,
      memoryFlushInterval: 5,
      memoryFlushTokenThreshold: 50_000,
      memoryIdleFlushMs: 0,
      streaming: true,
      streamingFlushMs: 500,
      temperature: 0.3,
      toolTemperature: 0.3,
      thinking: { enabled: false, budgetTokens: 0 },
      reasoningEffort: 'medium',
      skillLimits: { maxSkills: 100, maxSkillsInPrompt: 30, maxSkillsPromptChars: 30_000 },
      lanes: { user: 6, cron: 3, heartbeat: 2 },
      context: {
        keepRecentTokens: 20_000,
        reserveTokens: 8_000,
        toolResultMaxShare: 0.3,
        toolResultHardMax: 400_000,
        softTrimChars: 4_000,
        compactionThresholds: [0.75, 0.80, 0.85] as [number, number, number],
        emergencyThreshold: 0.95,
        protectedTailTurns: 3,
      },
    },
  } as unknown as JanusConfig;
}

const userMsg = (content: string): LLMMessage => ({ role: 'user', content });
const assistantMsg = (content: string): LLMMessage => ({ role: 'assistant', content });

describe('SessionManager rotation', () => {
  let workDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sess-rot-'));
    sm = new SessionManager(createTestConfig(workDir));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('rotates JSONL on summarize: archive file + new file with compaction entry', async () => {
    const key = 'test:chat:1';

    // Build a session with 50 messages, each ~1k chars (~400 tokens), total ~20k tokens
    const msgs: LLMMessage[] = [];
    for (let i = 0; i < 25; i++) {
      msgs.push(userMsg('u'.repeat(1000) + ` msg ${i}`));
      msgs.push(assistantMsg('a'.repeat(1000) + ` reply ${i}`));
    }
    await sm.append(key, msgs);

    // Rotate keeping last ~5k tokens
    await sm.summarize(key, 'SUMMARY_OF_OLD_MESSAGES', 5_000);

    const sessDir = join(workDir, 'sessions');
    const files = readdirSync(sessDir);

    // Should have BOTH the live file and an archive
    const archives = files.filter(f => /\.\d+\.jsonl$/.test(f));
    expect(archives.length).toBe(1);

    // Live file is the one without timestamp
    const live = files.find(f => f.endsWith('.jsonl') && !/\.\d+\.jsonl$/.test(f))!;
    const content = readFileSync(join(sessDir, live), 'utf-8');
    expect(content).toContain('"_type":"compaction"');
    expect(content).toContain('SUMMARY_OF_OLD_MESSAGES');

    // Cache + reloaded session should be smaller
    const session = await sm.getOrCreate(key);
    expect(session.messages.length).toBeLessThan(50);
    expect(session.metadata.summary).toBe('SUMMARY_OF_OLD_MESSAGES');
  });

  it('skips rotation when cut would remove fewer than 4 messages', async () => {
    const key = 'test:chat:tiny';
    await sm.append(key, [userMsg('hi'), assistantMsg('ok')]);

    await sm.summarize(key, 'SUMMARY', 5_000);

    const sessDir = join(workDir, 'sessions');
    const archives = readdirSync(sessDir).filter(f => /\.\d+\.jsonl$/.test(f));
    expect(archives.length).toBe(0); // no rotation
  });

  it('reloaded session ignores compaction entry in JSONL (it is metadata, not a message)', async () => {
    const key = 'test:chat:reload';

    const msgs: LLMMessage[] = [];
    for (let i = 0; i < 25; i++) {
      msgs.push(userMsg('u'.repeat(1000)));
      msgs.push(assistantMsg('a'.repeat(1000)));
    }
    await sm.append(key, msgs);
    await sm.summarize(key, 'SUMMARY', 5_000);

    // Fresh SessionManager (forces disk reload, no cache)
    const sm2 = new SessionManager(createTestConfig(workDir));
    const session = await sm2.getOrCreate(key);

    // No message in the loaded messages should have _type field
    for (const m of session.messages) {
      expect((m as Record<string, unknown>)._type).toBeUndefined();
    }
    expect(session.metadata.summary).toBe('SUMMARY');
  });

  it('commits one captured prefix and leaves late messages outside that prefix', async () => {
    const key = 'test:snapshot';
    const original: LLMMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: `${i}: ${'fact '.repeat(30)}`,
    }));
    await sm.append(key, original);
    const snapshot = await sm.prepareCompaction(key, 150);
    const prefixCount = snapshot.messages.length;
    expect(prefixCount).toBeGreaterThanOrEqual(4);
    const late: LLMMessage[] = [{ role: 'user', content: 'late correction '.repeat(1000) }];
    await sm.append(key, late);
    expect(snapshot.messages).toEqual(original.slice(0, prefixCount));
    expect(await sm.summarize(key, 'captured facts', 150, snapshot)).toBe(true);
    expect(await sm.getHistory(key)).toEqual([...original.slice(prefixCount), ...late]);
    const restarted = new SessionManager(createTestConfig(workDir));
    expect(await restarted.getHistory(key)).toEqual(await sm.getHistory(key));
    expect((await restarted.getOrCreate(key)).metadata.summary).toBe('captured facts');
  });

  it.each(['clear', 'rotation', 'fallback'] as const)('rejects an old snapshot after %s even when the prefix is identical', async action => {
    const key = 'test:generation';
    const original = Array.from({ length: 12 }, (_, i) => userMsg(`fact ${i}`));
    await sm.append(key, original);
    const snapshot = await sm.prepareCompaction(key, 10);
    if (action === 'clear') {
      await sm.clear(key);
      await sm.append(key, original);
    } else if (action === 'rotation') {
      const newer = await sm.prepareCompaction(key, 10);
      expect(await sm.summarize(key, 'newer facts', 10, newer)).toBe(true);
    } else {
      await sm.forceDropOldest(key, 0.5);
    }
    const before = structuredClone(await sm.getOrCreate(key));
    expect(await sm.summarize(key, 'stale facts', 10, snapshot)).toBe(false);
    await sm.forceDropOldest(key, 0.5, snapshot);
    expect(await sm.getOrCreate(key)).toEqual(before);
  });

  it('allows only one of two concurrent snapshots to replace the session', async () => {
    const key = 'test:concurrent-snapshots';
    await sm.append(key, Array.from({ length: 12 }, (_, i) => userMsg(`fact ${i}`)));
    const [first, second] = await Promise.all([sm.prepareCompaction(key, 10), sm.prepareCompaction(key, 10)]);
    const outcomes = await Promise.all([
      sm.summarize(key, 'first summary', 10, first),
      sm.summarize(key, 'second summary', 10, second),
    ]);
    expect(outcomes).toEqual([true, false]);
    expect((await sm.getOrCreate(key)).metadata.summary).toBe('first summary');
  });

  it('retains an oversized final assistant/tool group intact', async () => {
    const key = 'test:tool-boundary';
    const tail: LLMMessage[] = [
      userMsg('latest question'),
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'probe', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'probe', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'large result '.repeat(100) },
      { role: 'tool', tool_call_id: 'b', content: 'other result' },
      assistantMsg('answer'),
    ];
    const prefix = [userMsg('old 1'), assistantMsg('reply 1'), userMsg('old 2'), assistantMsg('reply 2')];
    await sm.append(key, [...prefix, ...tail]);
    const snapshot = await sm.prepareCompaction(key, 1);
    expect(snapshot.messages).toEqual(prefix);
    expect(await sm.summarize(key, 'old facts', 1, snapshot)).toBe(true);
    expect(await sm.getHistory(key)).toEqual(tail);
  });

  it('bounds a delayed fallback by its captured prefix', async () => {
    const key = 'test:fallback-snapshot';
    await sm.append(key, Array.from({ length: 12 }, (_, i) => userMsg(`fact ${i}`)));
    const snapshot = await sm.prepareCompaction(key, 10);
    const late = Array.from({ length: 20 }, (_, i) => userMsg(`late ${i}`));
    await sm.append(key, late);
    await sm.forceDropOldest(key, 0.5, snapshot);
    expect((await sm.getHistory(key)).slice(-late.length)).toEqual(late);
  });

  it('truncateToolResult respects unified cap from contextWindow', () => {
    // contextWindow=200k → effective=192k → cap = 192_000 * 2.5 * 0.5 = 240_000 chars
    const big = 'x'.repeat(300_000);
    const truncated = sm.truncateToolResult(big);
    expect(truncated.length).toBeLessThan(big.length);
    expect(truncated.length).toBeLessThanOrEqual(240_500); // cap + small overhead for marker
    expect(truncated).toContain('[truncated:');
  });

  it('truncateToolResult leaves content under cap unchanged', () => {
    const small = 'short';
    expect(sm.truncateToolResult(small)).toBe(small);
  });

  describe('forceDropOldest', () => {
    it('drops the oldest 50% of messages', async () => {
      const key = 'test:chat:drop';

      const msgs: LLMMessage[] = [];
      for (let i = 0; i < 10; i++) {
        msgs.push(userMsg(`u${i}`));
        msgs.push(assistantMsg(`a${i}`));
      }
      await sm.append(key, msgs);

      await sm.forceDropOldest(key, 0.5);

      const session = await sm.getOrCreate(key);
      expect(session.messages.length).toBeLessThan(20);
      expect(session.messages.length).toBeGreaterThanOrEqual(8); // ~half kept
      expect(session.metadata.summary).toBeUndefined();
      expect(session.metadata.compactionFailure).toContain('force-dropped');
    });

    it('skips when too few messages to drop', async () => {
      const key = 'test:chat:few';
      await sm.append(key, [userMsg('a'), assistantMsg('b')]);

      await sm.forceDropOldest(key, 0.5);

      const session = await sm.getOrCreate(key);
      expect(session.messages.length).toBe(2); // unchanged
    });
  });
});
