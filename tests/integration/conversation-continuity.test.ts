import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { EditFileTool } from '../../src/tools/builtin/edit-file.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';
import { structuredSummary } from '../helpers/summary.js';
import type { ChatRequest, ChatResponse } from '../../src/llm/types.js';

const response = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const call = (name: string, args: object) => ({ id: `call-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const users = [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }];

it('carries corrected facts through three compactions, a restart and provider failover', async () => {
  const primary = new MockProvider([]);
  const deps = agentFixture(primary, { users, agent: { context: { keepRecentTokens: 100 } } });
  vi.spyOn(primary, 'chat').mockImplementation(async req => { primary.calls.push(structuredClone(req)); return response('Acknowledged.'); });
  const constraints = 'Never publish without approval; deadline 2030-04-03; open task: compare offers.';
  const summaries: ChatRequest[] = [];
  let summaryNumber = 0;
  deps.llm.register({ name: 'summary', providerName: 'summary', model: 'summary-model', purpose: ['summarize'], priority: -1,
    provider: { chat: async req => {
      if (String(req.messages[0].content).includes('memory manager')) return response('<summary>NONE</summary><facts>NONE</facts>');
      summaries.push(structuredClone(req));
      expect(JSON.stringify(req.messages)).toContain(constraints);
      if (summaryNumber > 0) expect(String(req.messages[0].content)).toContain('## Goal');
      if (summaryNumber === 1) expect(JSON.stringify(req.messages)).toContain('Correction: limit 23 replaces 17');
      return response(structuredSummary(`${constraints} Limit: ${summaryNumber++ === 0 ? 17 : 23}.`));
    } },
  });
  const opts = { channel: 'test', chatId: 'alice-chat', user: { userId: 'alice' }, scope: { kind: 'user' as const, id: 'alice' } };
  const key = 'main:test:alice-chat';
  const agent = new AgentLoop(deps);
  for (let round = 0; round < 3; round++) {
    await agent.processDirect(round === 0 ? `${constraints} Limit: 17.` : round === 1 ? 'Correction: limit 23 replaces 17' : 'Continue the open task.', opts);
    for (let i = 0; i < 3; i++) await agent.processDirect(`round ${round}, step ${i}: ${'filler '.repeat(120)}`, opts);
    await (agent as unknown as { triggerCompactionSync(key: string, paths: Set<string>): Promise<void> }).triggerCompactionSync(key, new Set());
    expect((await deps.sessions.getOrCreate(key)).metadata.summary).toContain(`Limit: ${round === 0 ? 17 : 23}`);
  }
  expect(summaries).toHaveLength(3);
  const restarted = new SessionManager(deps.config);
  expect(await restarted.getHistory(key)).toEqual(await deps.sessions.getHistory(key));
  const fallback = new MockProvider([{ content: 'Restored from corrected summary.' }]);
  deps.llm.register({ name: 'fallback', providerName: 'fallback', model: 'second-model', purpose: ['chat'], priority: 1, provider: fallback });
  vi.mocked(primary.chat).mockRejectedValue(new Error('503 unavailable'));
  const resumed = new AgentLoop({ ...deps, sessions: restarted });
  await resumed.processDirect('Resume without changing the constraints.', opts);
  const request = fallback.calls[0];
  expect(request.model).toBe('second-model');
  expect(String(request.messages[0].content)).toContain(constraints);
  expect(String(request.messages[0].content)).toContain('Limit: 23');
  expect(String(request.messages[0].content)).not.toContain('Limit: 17');
  expect(request.messages.filter(m => m.content === 'Resume without changing the constraints.')).toHaveLength(1);
  await resumed.processDirect('BOB_PRIVATE_FACT', { channel: 'test', chatId: 'bob-chat', user: { userId: 'bob' } });
  expect(JSON.stringify(fallback.calls.at(-1))).not.toContain(constraints);
  expect(JSON.stringify(fallback.calls.at(-1))).not.toContain('Limit: 23');
  expect(JSON.stringify(await restarted.getHistory(key))).not.toContain('BOB_PRIVATE_FACT');
});

it('rebuilds pinned sums while a tool receives an image, without crossing two users or sessions', async () => {
  const mock = new MockProvider([]);
  const deps = agentFixture(mock, { users });
  const alicePath = '.janus/users/alice/files/totals.md';
  const initial = 'apples: 10\npears: 20\ntotal: 30';
  const updated = 'apples: 15\npears: 20\ntotal: 35';
  for (const user of ['alice', 'bob']) {
    await mkdir(join(deps.config.workspace.dir, `.janus/users/${user}/files`), { recursive: true });
    await writeFile(join(deps.config.workspace.dir, `.janus/users/${user}/files/totals.md`), user === 'alice' ? initial : 'BOB_PRIVATE_TOTAL: 99');
  }
  vi.spyOn(deps.skills, 'loadAll').mockResolvedValue([{ name: 'totals', description: '', version: '1', always: true, pinned: ['totals.md'], instructions: '', location: '/synthetic' }]);
  deps.tools.register(new EditFileTool()); deps.tools.register(new ReadFileTool());
  const editor = deps.tools.get('edit_file')!;
  const execute = editor.execute.bind(editor);
  vi.spyOn(editor, 'execute').mockImplementation(async (args, ctx) => {
    const result = await execute(args, ctx);
    deps.bus.pushSteering({ id: 'photo-unique', channel: 'test', chatId: 'alice-chat', author: 'alice', user: { userId: 'alice' },
      timestamp: new Date(), content: 'Check this receipt too', images: [{ data: 'YWJj', mimeType: 'image/png' }] });
    return result;
  });
  let step = 0;
  vi.spyOn(mock, 'chat').mockImplementation(async req => {
    mock.calls.push(structuredClone(req));
    if (String(req.systemParts?.dynamicPart).includes('BOB_PRIVATE_TOTAL')) return response('Bob done');
    const tool = step++ === 0 ? call('edit_file', { path: alicePath, old_string: initial, new_string: updated })
      : step === 2 ? call('read_file', { path: alicePath }) : undefined;
    return { ...response(tool ? '' : 'Verified total: 35'), toolCalls: tool ? [tool] : [], finishReason: tool ? 'tool_calls' : 'stop' };
  });
  const agent = new AgentLoop(deps);
  await Promise.all([
    agent.processDirect('Update apples to 15 and verify the sum', { channel: 'test', chatId: 'alice-chat', user: { userId: 'alice' } }),
    agent.processDirect('Check my own totals', { channel: 'test', chatId: 'bob-chat', user: { userId: 'bob' } }),
  ]);
  const aliceCalls = mock.calls.filter(req => !String(req.systemParts?.dynamicPart).includes('BOB_PRIVATE_TOTAL'));
  expect(aliceCalls).toHaveLength(3);
  expect(aliceCalls[0].systemParts?.dynamicPart).toContain(initial);
  for (const req of aliceCalls.slice(1)) {
    expect(req.systemParts?.dynamicPart).toContain(updated);
    expect(req.systemParts?.dynamicPart).not.toContain('total: 30');
    const images = req.messages.filter(m => m.role === 'user' && Array.isArray(m.content));
    expect(images).toHaveLength(1);
    expect(images[0].content).toEqual(expect.arrayContaining([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }]));
    expect(JSON.stringify(req)).not.toContain('BOB_PRIVATE_TOTAL');
  }
  const saved = await readFile(join(deps.config.workspace.dir, alicePath), 'utf8');
  const values = saved.split('\n').map(line => Number(line.split(': ')[1]));
  expect(values[2]).toBe(values[0] + values[1]);
  expect(JSON.stringify(mock.calls.find(req => String(req.systemParts?.dynamicPart).includes('BOB_PRIVATE_TOTAL')))).not.toContain('photo-unique');
  expect((await deps.sessions.getHistory('main:test:alice-chat')).filter(m => Array.isArray(m.content))).toHaveLength(1);
});

it('keeps a cancelled old turn locked until it settles, then resumes one clean follow-up', async () => {
  const mock = new MockProvider([]);
  const deps = agentFixture(mock);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let count = 0;
  vi.spyOn(mock, 'chat').mockImplementation(async req => {
    mock.calls.push(structuredClone(req));
    if (count++ === 0) { entered(); await held; return { ...response('STALE_REPLY'), toolCalls: [call('effect', {})], finishReason: 'tool_calls' }; }
    return response('Current reply');
  });
  const effect = vi.fn(async () => 'effect');
  deps.tools.register({ name: 'effect', description: '', parameters: {}, execute: effect });
  const agent = new AgentLoop(deps);
  const old = agent.processDirect('old task');
  await started;
  agent.stop('main:cli:direct');
  const next = agent.processDirect('new task');
  await Promise.resolve();
  expect(mock.calls).toHaveLength(1);
  release();
  await old;
  expect(await next).toBe('Current reply');
  expect(effect).not.toHaveBeenCalled();
  expect(JSON.stringify(mock.calls[1])).not.toContain('STALE_REPLY');
  expect(mock.calls[1].messages.filter(m => m.content === 'new task')).toHaveLength(1);
  const history = await new SessionManager(deps.config).getHistory('main:cli:direct');
  expect(history.filter(m => m.content === 'Current reply')).toHaveLength(1);
  expect(JSON.stringify(history)).not.toContain('STALE_REPLY');
});
