import { expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { ExecTool } from '../../src/tools/builtin/exec.js';
import { SpawnAgentTool } from '../../src/tools/builtin/spawn-agent.js';
import { SubagentRegistry } from '../../src/agent/subagent-registry.js';
import { PatternGate } from '../../src/gates/pattern-gate.js';
import { agentFixture } from '../helpers/agent-fixture.js';
import { MockProvider } from '../helpers/mock-llm.js';

const call = (name: string, args: object) => ({ id: `call-${name}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
const users = [{ id: 'owner', name: 'Owner' }, { id: 'guest', name: 'Guest', tools: { allow: ['exec', 'spawn_agent'] } }];

it.each([
  ['owner', true, false], ['guest', false, false], ['unknown', false, false], [undefined, false, false],
  ['owner', true, true], ['guest', false, true], ['unknown', false, true], [undefined, false, true],
] as const)('authorizes %s (allowed=%s, child=%s) at the shell boundary', async (userId, allowed, child) => {
  const mock = new MockProvider([
    ...(child ? [{ content: '', toolCalls: [call('spawn_agent', { task: 'run harmless echo' })] }] : []),
    { content: '', toolCalls: [call('exec', { command: 'echo EXECUTED_MARKER', isOwner: true })] },
    { content: 'done' }, { content: 'parent done' },
  ]);
  const deps = agentFixture(mock, { users });
  deps.tools.register(new ExecTool(deps.config));
  deps.tools.register(new SpawnAgentTool(deps, new SubagentRegistry()));
  await new AgentLoop(deps).processDirect('run command', { channel: userId ? 'cli' : 'system', user: userId ? { userId } : undefined });
  const outputs = mock.calls.flatMap(req => req.messages.filter(m => m.role === 'tool').map(m => String(m.content)));
  expect(outputs.some(output => output.trim() === 'EXECUTED_MARKER')).toBe(allowed);
  if (!allowed) expect(outputs.join('\n')).toMatch(/owner-only|identity/);
});

it('keeps single-user shell and deny patterns, while master disable wins even for the owner', async () => {
  const deps = agentFixture(new MockProvider([]));
  const tool = new ExecTool(deps.config);
  tool.setContext({ workspaceDir: deps.config.workspace.dir });
  expect((await tool.execute({ command: 'echo LOCAL' })).trim()).toBe('LOCAL');
  expect(await tool.execute({ command: 'rm -rf /' })).toContain('blocked by safety rules');
  deps.config.tools.execEnabled = false;
  const disabled = new ExecTool(deps.config);
  expect(await disabled.execute({ command: 'echo BLOCKED' }, { isOwner: true })).toContain('disabled');
});

it('rejects missing context and allowlist bypass at direct execution, and retains gates for owners', async () => {
  const deps = agentFixture(new MockProvider([]), { users });
  const tool = new ExecTool(deps.config);
  expect(await tool.execute({ command: 'echo BLOCKED' })).toContain('owner-only');
  expect(await tool.execute({ command: 'echo BLOCKED' }, { isOwner: false, userToolAllow: ['exec'] })).toContain('owner-only');
  deps.tools.register(tool);
  const confirm = vi.fn(async () => false);
  deps.tools.setGate(new PatternGate(['echo']), { confirm });
  expect(await deps.tools.execute('exec', { command: 'echo BLOCKED' }, { isOwner: false, userToolAllow: ['exec'] })).toContain('owner-only');
  expect(confirm).not.toHaveBeenCalled();
  expect(await deps.tools.execute('exec', { command: 'echo BLOCKED' }, { isOwner: true })).toContain('denied by user');
  expect(confirm).toHaveBeenCalledOnce();
});
