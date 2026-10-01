import { describe, expect, it, vi, afterEach } from 'vitest';
import { AgentLoop, type AgentDeps } from '../../src/agent/agent-loop.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { estimateRequestTokens } from '../../src/context/context-manager.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';
import { structuredSummary } from '../helpers/summary.js';
import type { ChatRequest, ChatResponse, LLMMessage } from '../../src/llm/types.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const answer = (content = structuredSummary()): ChatResponse => ({ content, finishReason: 'stop', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const records = (count: number, size = 200): LLMMessage[] => Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `record ${i}: ` + 'x'.repeat(size) }));
const invoke = (agent: AgentLoop, key: string, current?: string, signal?: AbortSignal) =>
  (agent as unknown as { triggerCompactionSync(k: string, paths: Set<string>, signal?: AbortSignal, current?: string): Promise<void> }).triggerCompactionSync(key, new Set(), signal, current);
async function fixture(window = 200_000) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const config = createTestConfig({ agent: { context: { keepRecentTokens: 100 } } });
  const sessions = new SessionManager(config);
  const chat = vi.fn(async (_r: ChatRequest) => answer());
  const llm = new ProviderRegistry();
  llm.register({ name: 'summary', providerName: 'summary', model: 'test', priority: 0, purpose: ['summarize'], contextWindows: { test: window }, provider: { chat } });
  const agent = new AgentLoop({ config, sessions, llm, bus: new MessageBus() } as AgentDeps);
  await sessions.append('test', records(12));
  return { sessions, config, chat, run: (current?: string, signal?: AbortSignal) => invoke(agent, 'test', current, signal) };
}

describe('Compaction transaction', () => {
  it('keeps the complete transcript after the first timeout and suppresses unchanged retries', async () => {
    const { sessions, chat, run } = await fixture();
    const before = structuredClone(await sessions.getOrCreate('test'));
    chat.mockRejectedValue(new Error('Summarization LLM call timed out'));
    await run(); await run();
    expect(await sessions.getOrCreate('test')).toEqual(before);
    expect(chat).toHaveBeenCalledOnce();
  });

  it('requests a shorter complete summary instead of slicing an oversized result', async () => {
    const { sessions, chat, run } = await fixture();
    chat.mockResolvedValueOnce(answer(structuredSummary('Long sentence. '.repeat(4000)))).mockResolvedValueOnce(answer());
    await run();
    expect(chat).toHaveBeenCalledTimes(2);
    expect((await sessions.getOrCreate('test')).metadata.summary).toBe(structuredSummary());
  });

  it('rejects two oversized results without committing a shortened fragment', async () => {
    const { sessions, chat, run } = await fixture();
    const before = structuredClone(await sessions.getOrCreate('test'));
    chat.mockResolvedValue(answer(structuredSummary('Long sentence. '.repeat(4000))));
    await run();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await sessions.getOrCreate('test')).toEqual(before);
  });

  it('retains the complete active request and source references omitted by the model', async () => {
    const { sessions, run } = await fixture();
    const current = 'Keep the agreed constraints. '.repeat(60) + 'Final instruction: ask first.';
    await sessions.append('test', [{ role: 'user', content: 'Use https://example.test/report and reference `REQ-456`.' }, ...records(6)]);
    await run(current);
    const summary = (await sessions.getOrCreate('test')).metadata.summary!;
    expect(summary).toContain(JSON.stringify(current));
    expect(summary).toContain('https://example.test/report');
    expect(summary).toContain('REQ-456');
  });

  it('budgets every batch, preserves tool pairs and never commits intermediate summaries', async () => {
    const { sessions, chat, run } = await fixture(12_000);
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 40; i++) messages.push(
      { role: 'user', content: `inspect item ${i}` },
      { role: 'assistant', content: '', tool_calls: [{ id: `call-${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `file${i}` }) } }] },
      { role: 'tool', tool_call_id: `call-${i}`, content: `evidence-${i} ` + 'x'.repeat(1800) },
    );
    await sessions.append('test', messages);
    chat.mockImplementation(async request => {
      expect(estimateRequestTokens(request) + request.maxTokens!).toBeLessThanOrEqual(12_000);
      const body = String(request.messages[1].content);
      for (const match of body.matchAll(/evidence-(\d+) /g)) expect(body).toContain(`"id":"call-${match[1]}"`);
      expect((await sessions.getOrCreate('test')).metadata.summary).toBeUndefined();
      return answer();
    });
    await run();
    expect(chat.mock.calls.length).toBeGreaterThan(1);
    expect((await sessions.getOrCreate('test')).metadata.summary).toBeDefined();
  });

  it('keeps history when a later batch fails', async () => {
    const { sessions, chat, run } = await fixture(12_000);
    await sessions.append('test', records(40, 3000));
    const before = structuredClone(await sessions.getOrCreate('test'));
    chat.mockResolvedValueOnce(answer()).mockRejectedValue(new Error('503 unavailable'));
    await run();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await sessions.getOrCreate('test')).toEqual(before);
  });

  it('does not discard an indivisible message that cannot fit', async () => {
    const { sessions, run } = await fixture(12_000);
    await sessions.append('test', [{ role: 'user', content: 'Huge '.repeat(20_000) }, ...records(6)]);
    const before = structuredClone(await sessions.getOrCreate('test'));
    await run();
    expect(await sessions.getOrCreate('test')).toEqual(before);
  });
});

async function memoryFixture(window = 200_000) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const deps = agentFixture(new MockProvider([{ content: 'ack' }]), { users: [{ id: 'alice', name: 'Alice' }], agent: { summarizationThreshold: 1000, context: { keepRecentTokens: 100 } } });
  const summary = vi.fn(async (_r: ChatRequest) => answer());
  const flush = vi.fn(async (_r: ChatRequest) => answer('<summary>NONE</summary><facts>Important fact.</facts>'));
  deps.llm.register({ name: 'summary', providerName: 'summary', model: 'test', priority: -1, purpose: ['summarize'], contextWindows: { test: window }, provider: { chat: r => String(r.messages[0].content).includes('memory manager') ? flush(r) : summary(r) } });
  const agent = new AgentLoop(deps);
  await agent.processDirect('hello', { chatId: 'alice', user: { userId: 'alice' }, scope: { kind: 'user', id: 'alice' } });
  const key = 'main:cli:alice';
  await deps.sessions.append(key, records(12, 700));
  return { deps, key, summary, flush, agent, run: (signal?: AbortSignal) => invoke(agent, key, undefined, signal) };
}

describe('Memory before compaction', () => {
  it('joins an existing write and only summarizes after its checkpoint', async () => {
    const { deps, key, summary, flush, agent, run } = await memoryFixture();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = deps.memory!.appendDaily.bind(deps.memory);
    const write = vi.spyOn(deps.memory!, 'appendDaily').mockImplementation(async (...args) => { await held; await original(...args); });
    const first = agent.flushAllSessions();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    const compact = run();
    await vi.advanceTimersByTimeAsync(1);
    expect(summary).not.toHaveBeenCalled();
    release(); await first; await compact;
    expect(flush).toHaveBeenCalledOnce();
    expect(summary).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][1]).toEqual({ userId: 'alice' });
    expect(await deps.sessions.pendingMemoryCount(key)).toBe(0);
  });

  it('does not compact after failed note writes', async () => {
    const { deps, key, summary, run } = await memoryFixture();
    const history = structuredClone(await deps.sessions.getHistory(key));
    vi.spyOn(deps.memory!, 'appendDaily').mockRejectedValue(new Error('disk full'));
    await run();
    expect(summary).not.toHaveBeenCalled();
    expect(await deps.sessions.getHistory(key)).toEqual(history);
    expect(await deps.sessions.pendingMemoryCount(key)).toBe(history.length);
  });

  it('rejects a late memory response after cancellation without writing notes', async () => {
    const { deps, summary, flush, run } = await memoryFixture();
    let release!: (r: ChatResponse) => void;
    flush.mockImplementation(() => new Promise<ChatResponse>(resolve => { release = resolve; }));
    const write = vi.spyOn(deps.memory!, 'appendDaily');
    const controller = new AbortController();
    const running = run(controller.signal);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).rejects.toThrow();
    release(answer('<summary>late</summary><facts>late</facts>'));
    await Promise.resolve(); await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
  });
});

it('checkpoints memory only after all budgeted batches have been written', async () => {
  const { deps, key, flush, run } = await memoryFixture(12_000);
  await deps.sessions.append(key, records(60, 1800));
  const pending = await deps.sessions.pendingMemoryCount(key);
  flush.mockImplementation(async request => {
    expect(estimateRequestTokens(request) + request.maxTokens!).toBeLessThanOrEqual(12_000);
    expect(await deps.sessions.pendingMemoryCount(key)).toBe(pending);
    return answer('<summary>NONE</summary><facts>Important fact.</facts>');
  });
  await run();
  expect(flush.mock.calls.length).toBeGreaterThan(1);
  expect(await deps.sessions.pendingMemoryCount(key)).toBe(0);
  expect((await deps.sessions.getOrCreate(key)).metadata.summary).toBeDefined();
});

it('does not interpret an image payload as a source reference', async () => {
  const { sessions, chat, run } = await fixture();
  await sessions.append('test', [{ role: 'user', content: [
    { type: 'text', text: 'Attached image' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abcdef1234567890'.repeat(10_000) } },
  ] }, ...records(6)]);
  await run();
  expect((await sessions.getOrCreate('test')).metadata.summary).toBeDefined();
  expect(chat.mock.calls[0][0].messages[1].content).toContain('[Non-text attachment omitted]');
  expect(chat.mock.calls[0][0].messages[1].content).not.toContain('abcdef1234567890');
});

it('does not acknowledge a memory response with an unfinished facts section', async () => {
  const { deps, key, flush, summary, run } = await memoryFixture();
  const pending = await deps.sessions.pendingMemoryCount(key);
  const history = vi.spyOn(deps.memory!, 'appendHistory');
  flush.mockResolvedValue(answer('<summary>One event.</summary><facts>unfinished'));
  await run();
  expect(history).not.toHaveBeenCalled();
  expect(summary).not.toHaveBeenCalled();
  expect(await deps.sessions.pendingMemoryCount(key)).toBe(pending);
});

it('flushes arrivals not covered by the existing owner before compacting them', async () => {
  const { deps, key, flush, summary, agent, run } = await memoryFixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = deps.memory!.appendDaily.bind(deps.memory);
  const write = vi.spyOn(deps.memory!, 'appendDaily').mockImplementation(async (...args) => { await held; await original(...args); });
  const first = agent.flushAllSessions();
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
  await deps.sessions.append(key, [{ role: 'user', content: 'New arrival after the owner snapshot.' }, ...records(6)]);
  const compact = run();
  await vi.advanceTimersByTimeAsync(1);
  expect(summary).not.toHaveBeenCalled();
  release(); await first; await compact;
  expect(flush).toHaveBeenCalledTimes(2);
  expect(flush.mock.calls[0][0].messages[1].content).not.toContain('New arrival after the owner snapshot.');
  expect(flush.mock.calls[1][0].messages[1].content).toContain('New arrival after the owner snapshot.');
  expect(await deps.sessions.pendingMemoryCount(key)).toBe(0);
  expect((await deps.sessions.getOrCreate(key)).metadata.summary).toBeDefined();
});
