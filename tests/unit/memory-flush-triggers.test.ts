import { expect, it, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const response = (): ChatResponse => ({ content: '<summary>NONE</summary><facts>NONE</facts>', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const chat = new MockProvider(Array.from({ length: 12 }, () => ({ content: 'ack' })));
  const deps = agentFixture(chat, { users: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }] });
  const flush = vi.fn(async (_request: ChatRequest) => response());
  deps.llm.register({ name: 'flush', providerName: 'flush', model: 'flush-model', purpose: ['summarize'], priority: -1, provider: { chat: flush } });
  return { deps, flush, agent: new AgentLoop(deps) };
}
const opts = (id: string) => ({ chatId: id, user: { userId: id }, scope: { kind: 'user' as const, id } });

it('flushes on twenty unflushed messages, without an idle trigger or duplicate flush', async () => {
  const { agent, deps, flush } = fixture();
  for (let i = 0; i < 9; i++) await agent.processDirect(`fact ${i}`, opts('alice'));
  expect(await deps.sessions.pendingMemoryCount('main:cli:alice')).toBe(18);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(flush).not.toHaveBeenCalled();
  await agent.processDirect('fact 9', opts('alice'));
  await vi.waitFor(async () => expect(await deps.sessions.pendingMemoryCount('main:cli:alice')).toBe(0));
  expect(flush).toHaveBeenCalledOnce();
  for (let i = 0; i < 10; i++) expect(String(flush.mock.calls[0][0].messages[1].content)).toContain(`fact ${i}`);
  await agent.flushAllSessions();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(flush).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('flushes both users below the count threshold on shutdown without mixing input', async () => {
  const { agent, deps, flush } = fixture();
  await agent.processDirect('ALICE_PRIVATE_FACT', opts('alice'));
  await agent.processDirect('BOB_PRIVATE_FACT', opts('bob'));
  expect(flush).not.toHaveBeenCalled();
  await agent.flushAllSessions();
  expect(flush).toHaveBeenCalledTimes(2);
  for (const [request] of flush.mock.calls) {
    const text = JSON.stringify(request.messages);
    const isAlice = text.includes('ALICE_PRIVATE_FACT');
    expect(text).toContain(isAlice ? 'alice' : 'bob');
    expect(text).not.toContain(isAlice ? 'BOB_PRIVATE_FACT' : 'ALICE_PRIVATE_FACT');
  }
  expect(await deps.sessions.pendingMemoryCount('main:cli:alice')).toBe(0);
  expect(await deps.sessions.pendingMemoryCount('main:cli:bob')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds shutdown waiting even when a provider never settles', async () => {
  const { agent, flush } = fixture();
  await agent.processDirect('fact', opts('alice'));
  flush.mockImplementation(() => new Promise<ChatResponse>(() => {}));
  let finished = false;
  const shutdown = agent.flushAllSessions().then(() => { finished = true; });
  await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  await shutdown;
  expect(finished).toBe(true);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(flush).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
