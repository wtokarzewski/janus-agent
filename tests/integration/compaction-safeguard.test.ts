import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, type AgentDeps } from '../../src/agent/agent-loop.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { estimateRequestTokens } from '../../src/context/context-manager.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';
import { finalizeSummary } from '../../src/agent/compaction-safeguard.js';
import { structuredSummary } from '../helpers/summary.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';

const response = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
async function fixture(window = 200_000) {
  const config = createTestConfig({ agent: { context: { keepRecentTokens: 100 } } });
  const sessions = new SessionManager(config);
  await sessions.append('test', Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fact ${i} ` + 'x'.repeat(100) })));
  const chat = vi.fn(async (_request: ChatRequest) => response(structuredSummary()));
  const llm = new ProviderRegistry();
  llm.register({ name: 'summary', providerName: 'summary', provider: { chat }, model: 'summary', priority: 0, purpose: [], contextWindows: { summary: window } });
  const agent = new AgentLoop({ config, sessions, llm, bus: new MessageBus() } as AgentDeps);
  const run = (ask?: string, signal?: AbortSignal) => (agent as unknown as { triggerCompactionSync(key: string, paths: Set<string>, signal?: AbortSignal, ask?: string): Promise<void> }).triggerCompactionSync('test', new Set(), signal, ask);
  return { config, sessions, chat, run };
}
describe('Compaction safeguards', () => {
  it('keeps the full active history on the first timeout and suppresses identical retries', async () => {
    const { sessions, config, chat, run } = await fixture();
    chat.mockRejectedValue(new Error('Summarization LLM call timed out'));
    const before = structuredClone(await sessions.getOrCreate('test'));
    await run(); await run();
    expect(await sessions.getOrCreate('test')).toEqual(before);
    expect(await new SessionManager(config).getOrCreate('test')).toEqual(before);
    expect(chat).toHaveBeenCalledOnce();
  });
  it('preserves audited identifiers and the active request even when omitted by the model', async () => {
    const { sessions, run } = await fixture();
    await sessions.append('test', [{ role: 'user', content: 'Use https://example.test/task/123456 and commit abcdef1234567890.' },
      { role: 'assistant', content: 'noted '.repeat(100) }, { role: 'user', content: 'tail '.repeat(100) }, { role: 'assistant', content: 'tail' }]);
    await run('Compare the offers, do not publish them.');
    const summary = (await sessions.getOrCreate('test')).metadata.summary;
    expect(summary).toContain('https://example.test/task/123456');
    expect(summary).toContain('abcdef1234567890');
    expect(summary).toContain('Compare the offers, do not publish them.');
  });
  it('budgets each chunk including previous summary and keeps tool calls with results', async () => {
    const { sessions, chat, run } = await fixture(10_000);
    for (let i = 0; i < 60; i++) await sessions.append('test', [
      { role: 'user', content: `step ${i} ` + 'context '.repeat(90) },
      { role: 'assistant', content: '', tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'lookup', arguments: '{"query":"fact"}' } }] },
      { role: 'tool', tool_call_id: `call-${i}`, content: `result-${i}` },
    ]);
    await sessions.append('test', [{ role: 'user', content: 'keep recent '.repeat(100) }, { role: 'assistant', content: 'tail' }]);
    await run();
    expect(chat.mock.calls.length).toBeGreaterThan(1);
    for (const [request] of chat.mock.calls) {
      expect(estimateRequestTokens(request) + request.maxTokens!).toBeLessThanOrEqual(10_000);
      const text = String(request.messages[1].content).split('<conversation>\n')[1].split('\n</conversation>')[0];
      const messages = text.split('\n').map(line => JSON.parse(line));
      for (const message of messages) if (message.role === 'tool') {
        expect(messages.some(m => m.tool_calls?.some((call: { id: string }) => call.id === message.tool_call_id))).toBe(true);
      }
    }
    expect((await sessions.getOrCreate('test')).metadata.summary).toContain('## Identifiers');
    expect((await sessions.getHistory('test')).length).toBeLessThan(20);
  });
  it('fits the persisted artifact while retaining every section and protected fact', async () => {
    const { sessions, chat, run } = await fixture();
    chat.mockResolvedValue(response(structuredSummary('detail '.repeat(5000))));
    await run('Keep the pending task.');
    const summary = (await sessions.getOrCreate('test')).metadata.summary!;
    expect(summary.length).toBeLessThanOrEqual(16_000);
    expect(summary).toContain('## Identifiers');
    expect(summary).toContain('Keep the pending task.');
  });
});


it('cancels before committing when a later chunk fails', async () => {
  const { sessions, chat, run } = await fixture(10_000);
  await sessions.append('test', Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'detail '.repeat(200) })));
  const before = structuredClone(await sessions.getOrCreate('test'));
  chat.mockResolvedValueOnce(response(structuredSummary())).mockRejectedValue(new Error('503 unavailable'));
  await run();
  expect(chat).toHaveBeenCalledTimes(2);
  expect(await sessions.getOrCreate('test')).toEqual(before);
});

it('retains history when one indivisible group cannot fit', async () => {
  const { sessions, chat, run } = await fixture(8_000);
  await sessions.clear('test');
  await sessions.append('test', [
    { role: 'user', content: 'oversized '.repeat(20_000) },
    ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'context '.repeat(100) })),
  ]);
  const before = structuredClone(await sessions.getOrCreate('test'));
  await run();
  expect(chat).not.toHaveBeenCalled();
  expect(await sessions.getOrCreate('test')).toEqual(before);
});

it('protects source facts after fitting and rejects an infeasible protected minimum', () => {
  const id = 'abcdef1234567890';
  const candidate = response(structuredSummary('😀'.repeat(5000) + id));
  const fitted = finalizeSummary(candidate, [id], 'Keep pending', 1600);
  expect(fitted).toContain(id);
  expect(fitted).toContain('Keep pending');
  expect(fitted!.length).toBeLessThanOrEqual(1600);
  expect(fitted!.isWellFormed()).toBe(true);
  expect(finalizeSummary(candidate, ['https://example.test/' + 'x'.repeat(2000)], 'Keep pending', 1600)).toBeNull();
});

async function memoryFixture(window = 200_000) {
  const deps = agentFixture(new MockProvider([{ content: 'ack' }]), { agent: { summarizationThreshold: 1000, context: { keepRecentTokens: 100 } } });
  const agent = new AgentLoop(deps);
  await agent.processDirect('private initial fact', { chatId: 'memory', user: { userId: 'alice' }, scope: { kind: 'user', id: 'alice' } });
  const key = 'main:cli:memory';
  await deps.sessions.append(key, Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'durable fact '.repeat(100) })));
  const flush = vi.fn(async (_request: ChatRequest) => response('<summary>NONE</summary><facts>private durable fact</facts>'));
  const compact = vi.fn(async (_request: ChatRequest) => response(structuredSummary()));
  deps.llm.register({ name: 'memory', providerName: 'memory', model: 'memory', purpose: ['summarize'], priority: -1, contextWindows: { memory: window },
    provider: { chat: req => String(req.messages[0].content).includes('You are a memory manager') ? flush(req) : compact(req) } });
  const run = (signal?: AbortSignal) => (agent as unknown as { triggerCompactionSync(key: string, paths: Set<string>, signal?: AbortSignal): Promise<void> }).triggerCompactionSync(key, new Set(), signal);
  return { deps, agent, key, flush, compact, run };
}

it('joins an existing flush and waits for durable writes before compaction', async () => {
  const { deps, agent, key, flush, compact, run } = await memoryFixture();
  let release!: () => void;
  const write = vi.spyOn(deps.memory!, 'appendDaily').mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const shutdown = agent.flushAllSessions();
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  const before = structuredClone(await deps.sessions.getHistory(key));
  const running = run();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(compact).not.toHaveBeenCalled();
  expect(await deps.sessions.getHistory(key)).toEqual(before);
  release(); await shutdown; await running;
  expect(flush).toHaveBeenCalledOnce();
  expect(compact).toHaveBeenCalledOnce();
  expect(write.mock.calls[0][1]).toEqual({ userId: 'alice' });
  expect(await deps.sessions.pendingMemoryCount(key)).toBe(0);
});

it('does not compact or advance the cursor after a failed memory write', async () => {
  const { deps, key, compact, run } = await memoryFixture();
  vi.spyOn(deps.memory!, 'appendDaily').mockRejectedValue(new Error('disk full'));
  const before = structuredClone(await deps.sessions.getOrCreate(key));
  const beforeDisk = await new SessionManager(deps.config).getOrCreate(key);
  await run();
  expect(compact).not.toHaveBeenCalled();
  expect(await deps.sessions.getOrCreate(key)).toEqual(before);
  expect(await new SessionManager(deps.config).getOrCreate(key)).toEqual(beforeDisk);
});

it('does not write or compact after an aborted pre-compaction flush returns late', async () => {
  const { deps, key, flush, compact, run } = await memoryFixture();
  let release!: (response: ChatResponse) => void;
  flush.mockImplementation(() => new Promise<ChatResponse>(resolve => { release = resolve; }));
  const write = vi.spyOn(deps.memory!, 'appendDaily');
  const before = structuredClone(await deps.sessions.getOrCreate(key));
  const controller = new AbortController();
  const running = run(controller.signal);
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
  controller.abort();
  await expect(running).rejects.toThrow();
  release(response('<summary>NONE</summary><facts>late</facts>'));
  await Promise.resolve();
  expect(write).not.toHaveBeenCalled();
  expect(compact).not.toHaveBeenCalled();
  expect(await deps.sessions.getOrCreate(key)).toEqual(before);
});


it('chunks a large pending memory snapshot and checkpoints only after the last write', async () => {
  const { deps, key, flush, compact, run } = await memoryFixture(10_000);
  await deps.sessions.append(key, Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `fact ${i} ` + 'detail '.repeat(100) })));
  const initialPending = await deps.sessions.pendingMemoryCount(key);
  const write = vi.spyOn(deps.memory!, 'appendDaily').mockImplementation(async () => {
    expect(await deps.sessions.pendingMemoryCount(key)).toBe(initialPending);
  });
  await run();
  expect(flush.mock.calls.length).toBeGreaterThan(1);
  expect(write).toHaveBeenCalledTimes(flush.mock.calls.length);
  for (const [request] of flush.mock.calls) expect(estimateRequestTokens(request) + request.maxTokens!).toBeLessThanOrEqual(10_000);
  expect(compact).toHaveBeenCalled();
  expect(await deps.sessions.pendingMemoryCount(key)).toBe(0);
});

it('does not treat image data as identifiers or claim it was summarized', async () => {
  const { sessions, chat, run } = await fixture();
  await sessions.append('test', [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcdef'.repeat(10000) } }] },
    { role: 'assistant', content: 'ack' }, { role: 'user', content: 'tail '.repeat(100) }, { role: 'assistant', content: 'tail' }]);
  await run();
  expect(chat).toHaveBeenCalled();
  expect(JSON.stringify(chat.mock.calls)).not.toContain('abcdef'.repeat(100));
  expect(JSON.stringify(chat.mock.calls)).toContain('Non-text content omitted');
  expect((await sessions.getOrCreate('test')).metadata.summary).toBeDefined();
});
