import { expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { SpawnAgentTool } from '../../src/tools/builtin/spawn-agent.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.js';
import { SubagentRegistry } from '../../src/agent/subagent-registry.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';
import type { RequestContext } from '../../src/tools/types.js';

const call = (name: string, args = {}) => ({ id: `call-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const users = [{ id: 'owner', name: 'Owner' }, { id: 'guest', name: 'Guest' }];

it('inherits user, scope, agent rules and tool restrictions through a real child turn', async () => {
  const mock = new MockProvider([
    { content: '', toolCalls: [call('spawn_agent', { task: 'child' })] },
    { content: '', toolCalls: [call('inspect'), call('secret'), call('read_file', { path: '.janus/users/owner/files/private.txt' })] },
    { content: 'child done' }, { content: 'parent done' },
  ]);
  const deps = agentFixture(mock, { users, agents: [{ id: 'main', name: 'Main' }, { id: 'restricted', name: 'Restricted', tools: { deny: ['secret'] } }], bindings: [{ agentId: 'restricted', match: { channel: 'cli' } }] });
  const registry = new SubagentRegistry();
  deps.tools.register(new SpawnAgentTool(deps, registry));
  deps.tools.register(new ReadFileTool());
  const secret = vi.fn(async () => 'SECRET');
  const contexts: RequestContext[] = [];
  deps.tools.register({ name: 'inspect', description: '', parameters: {}, execute: async (_, ctx) => { contexts.push(ctx!); return 'ok'; } });
  deps.tools.register({ name: 'secret', description: '', parameters: {}, execute: secret });
  await mkdir(join(deps.config.workspace.dir, '.janus/users/owner/files'), { recursive: true });
  await writeFile(join(deps.config.workspace.dir, '.janus/users/owner/files/private.txt'), 'PRIVATE');
  await writeFile(join(deps.config.workspace.dir, 'AGENTS.md'), 'Mandatory shared rules');
  await mkdir(join(deps.config.workspace.dir, '.janus/users/guest'), { recursive: true });
  await writeFile(join(deps.config.workspace.dir, '.janus/users/guest/AGENTS.md'), 'Mandatory guest rules');
  await new AgentLoop(deps).processDirect('parent', { user: { userId: 'guest' }, scope: { kind: 'user', id: 'guest' } });
  expect(contexts[0]).toMatchObject({ userId: 'guest', isOwner: false, agentId: 'restricted', spawnDepth: 1, scope: { kind: 'user', id: 'guest' } });
  expect(secret).not.toHaveBeenCalled();
  const childRequest = JSON.stringify(mock.calls[2]);
  expect(childRequest).toContain('Access denied');
  expect(childRequest).not.toContain('PRIVATE');
  expect(childRequest).toContain('Mandatory shared rules');
  expect(childRequest).toContain('Mandatory guest rules');
  expect(registry.size).toBe(0);
});

it('increments nested depth and records parent links without a shared tool depth', async () => {
  const mock = new MockProvider([
    { content: '', toolCalls: [call('spawn_agent', { task: 'child' })] },
    { content: '', toolCalls: [call('spawn_agent', { task: 'grandchild' })] },
    { content: '', toolCalls: [call('spawn_agent', { task: 'too deep' })] },
    { content: 'grandchild done' }, { content: 'child done' }, { content: 'parent done' },
  ]);
  const deps = agentFixture(mock, { agent: { subagents: { maxSpawnDepth: 2 } } });
  const registry = new SubagentRegistry();
  const register = vi.spyOn(registry, 'register');
  deps.tools.register(new SpawnAgentTool(deps, registry));
  await new AgentLoop(deps).processDirect('parent');
  expect(register).toHaveBeenCalledTimes(2);
  expect(register.mock.calls[1][2]).toBe(register.mock.calls[0][0]);
  expect(JSON.stringify(mock.calls[3])).toContain('Maximum spawn depth');
});

it('rejects delegation without trusted request identity before contacting the provider', async () => {
  const mock = new MockProvider([{ content: 'oops' }]);
  const deps = agentFixture(mock, { users });
  expect(await new SpawnAgentTool(deps).execute({ task: 'child', userId: 'owner', isOwner: true })).toContain('identity');
  expect(mock.calls).toHaveLength(0);
});

it('uses distinct IDs in the same millisecond, enforces parent limits, and combines cancellation', async () => {
  const mock = new MockProvider([]);
  const deps = agentFixture(mock, { agent: { subagents: { maxChildrenPerAgent: 2 } } });
  const registry = new SubagentRegistry();
  const tool = new SpawnAgentTool(deps, registry);
  const releases: Array<() => void> = [];
  const signals = new Map<string, AbortSignal>();
  vi.spyOn(mock, 'chat').mockImplementation(async req => {
    signals.set(String(req.messages.find(m => m.role === 'user')?.content), req.signal!);
    await new Promise<void>(resolve => releases.push(resolve));
    return { content: 'late', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  });
  const ctrl = new AbortController();
  const parent: RequestContext = { isOwner: true, runId: 'parent', signal: ctrl.signal };
  const now = vi.spyOn(Date, 'now').mockReturnValue(123456789);
  try {
    const first = tool.execute({ task: 'first' }, parent);
    const second = tool.execute({ task: 'second' }, parent);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const children = registry.list();
    expect(new Set(children.map(c => c.id)).size).toBe(2);
    expect(children.every(c => c.parentId === 'parent')).toBe(true);
    expect(await tool.execute({ task: 'third' }, parent)).toContain('Maximum children');
    registry.cancel(children.find(c => c.task === 'first')!.id);
    expect(signals.get('first')!.aborted).toBe(true);
    expect(signals.get('second')!.aborted).toBe(false);
    ctrl.abort();
    expect(signals.get('second')!.aborted).toBe(true);
    releases.forEach(release => release());
    expect((await Promise.all([first, second])).every(result => !result.includes('late'))).toBe(true);
    expect(registry.size).toBe(0);
  } finally { ctrl.abort(); now.mockRestore(); releases.forEach(release => release()); }
});
