import { expect, it, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';
import { structuredSummary } from '../helpers/summary.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const answer = (content: string, finishReason: ChatResponse['finishReason'] = 'stop'): ChatResponse => ({ content, finishReason, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
async function fixture(outputs: ChatResponse[]) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const primary = new MockProvider([{ content: 'Done' }]);
  const deps = agentFixture(primary, { agent: { contextWindow: 12000, context: { keepRecentTokens: 100 } } });
  const key = 'main:cli:direct';
  await deps.sessions.append(key, Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'prior '.repeat(100) })));
  const previous = structuredSummary('17');
  await deps.sessions.summarize(key, previous, 100);
  await deps.sessions.append(key, [
    { role: 'assistant', content: '', tool_calls: [{ id: 'evidence', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'evidence', content: 'Tool evidence: exact value 37' },
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `retained fact ${i}: ` + 'x'.repeat(5000) })),
  ]);
  const summarize = vi.fn(async (_request: ChatRequest) => outputs.shift() ?? answer(''));
  deps.llm.register({ name: 'summary', providerName: 'summary', model: 'test-summary', purpose: ['summarize'], priority: -1, provider: { chat: summarize } });
  return { deps, primary, summarize, previous, key, agent: new AgentLoop(deps) };
}

it('bounds invalid summaries to two attempts and preserves previous facts and transcript', async () => {
  const { agent, deps, summarize, primary, previous, key } = await fixture([answer(''), answer(structuredSummary(), 'length')]);
  const before = structuredClone(await deps.sessions.getHistory(key));
  expect(await agent.processDirect('continue')).toContain('exceeds the context budget');
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(primary.calls).toHaveLength(0);
  expect((await deps.sessions.getOrCreate(key)).metadata.summary).toBe(previous);
  const after = await deps.sessions.getHistory(key);
  for (const message of before) expect(after).toContainEqual(message);
  expect(vi.getTimerCount()).toBe(0);
});

it('includes actual tool evidence and a short prior summary, then resumes after one valid retry', async () => {
  const valid = structuredSummary('17; tool evidence exact value 37');
  const { agent, deps, summarize, primary, previous, key } = await fixture([answer('incomplete'), answer(valid)]);
  expect(await agent.processDirect('continue')).toBe('Done');
  expect(summarize).toHaveBeenCalledTimes(2);
  for (const call of summarize.mock.calls) {
    const request = call[0];
    expect(request.messages[0].content).toContain(previous);
    expect(request.messages[1].content).toContain('tool: Tool evidence: exact value 37');
  }
  expect((await deps.sessions.getOrCreate(key)).metadata.summary).toBe(valid);
  expect(String(primary.calls[0].messages[0].content)).toContain('exact value 37');
  expect(vi.getTimerCount()).toBe(0);
});
