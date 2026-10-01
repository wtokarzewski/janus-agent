import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop, type AgentDeps } from '../../src/agent/agent-loop.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import { structuredSummary } from '../helpers/summary.js';
import type { ChatResponse, ChatRequest } from '../../src/llm/types.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
async function fixture(responses: Array<Partial<ChatResponse>>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const config = createTestConfig({ agent: { context: { keepRecentTokens: 100 } } });
  const sessions = new SessionManager(config);
  await sessions.append('test', Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `fact ${i} ` + 'x'.repeat(100),
  })));
  const previous = structuredSummary('17');
  await sessions.summarize('test', previous, 200);
  await sessions.append('test', Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: `new fact ${i} ` + 'x'.repeat(100),
  })));
  const chat = vi.fn(async (_request: ChatRequest): Promise<ChatResponse> => ({
    content: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ...responses.shift(),
  }));
  // Exercise the compaction boundary without running unrelated tool/turn logic.
  const llm = new ProviderRegistry();
  llm.register({ name: 'summary', providerName: 'summary', model: 'test', priority: 0, purpose: ['summarize'], provider: { chat } });
  const loop = new AgentLoop({ config, sessions, bus: new MessageBus(), llm } as unknown as AgentDeps);
  const run = (signal?: AbortSignal) => (loop as unknown as { triggerCompactionSync(key: string, paths: Set<string>, signal?: AbortSignal): Promise<void> }).triggerCompactionSync('test', new Set(), signal);
  return { config, sessions, chat, run, previous };
}

describe('Summary commit validation', () => {
  it.each([
    { content: '' },
    { content: '## Goal\n' },
    { content: 'Keep facts.\n## Constraints & Preferences\nNever change the' },
    { content: structuredSummary(), finishReason: 'length' as const },
  ])('retains history and prior summary after invalid output: %j', async invalid => {
    const { config, sessions, chat, run } = await fixture([invalid, invalid]);
    const before = structuredClone(await sessions.getOrCreate('test'));
    const beforeDisk = await new SessionManager(config).getOrCreate('test');
    await run();
    await run(); // same captured prefix must not start another retry cascade
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await sessions.getOrCreate('test')).toEqual(before);
    expect(await new SessionManager(config).getOrCreate('test')).toEqual(beforeDisk);
  });

  it('accepts the second complete answer and preserves a short prior summary in the request', async () => {
    const valid = structuredSummary('37');
    const { config, chat, run, previous } = await fixture([{ content: '' }, { content: valid }]);
    expect(previous.length / 2.5).toBeLessThan(100);
    await run();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(chat.mock.calls[0][0].messages[0].content).toContain(previous);
    expect((await new SessionManager(config).getOrCreate('test')).metadata.summary).toBe(valid);
  });

  it('retains history when the one validation retry times out', async () => {
    const { sessions, chat, run } = await fixture([{ content: '' }]);
    chat.mockImplementationOnce(async () => ({ content: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }))
      .mockRejectedValueOnce(new Error('Summarization LLM call timed out'));
    const before = structuredClone(await sessions.getOrCreate('test'));
    await run();
    await run();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await sessions.getOrCreate('test')).toEqual(before);
  });

  it('cancels an ignored summarizer request without committing its late result', async () => {
    const { sessions, chat, run } = await fixture([]);
    const before = structuredClone(await sessions.getOrCreate('test'));
    let release!: (response: ChatResponse) => void;
    chat.mockImplementation(() => new Promise<ChatResponse>(resolve => { release = resolve; }));
    const ctrl = new AbortController();
    const running = run(ctrl.signal);
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    ctrl.abort();
    await expect(running).rejects.toThrow();
    release({ content: structuredSummary(), toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    await Promise.resolve();
    expect(await sessions.getOrCreate('test')).toEqual(before);
  });

  it('carries exact constraints through three consecutive compactions', async () => {
    const facts = 'Limit 17; deadline 2030-04-03; never publish without approval.';
    const valid = structuredSummary(facts);
    const { sessions, chat, run } = await fixture([{ content: valid }, { content: valid }, { content: valid }]);
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sessions.append('test', Array.from({ length: 8 }, (_, j) => ({ role: j % 2 ? 'assistant' : 'user', content: 'next '.repeat(100) })));
      await run();
      expect((await sessions.getOrCreate('test')).metadata.summary).toContain(facts);
      if (i > 0) expect(chat.mock.calls[i][0].messages[0].content).toContain(facts);
    }
  });
});
