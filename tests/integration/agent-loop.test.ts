/**
 * Integration tests for AgentLoop — full pipeline with mock LLM.
 * No external API calls.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop, type AgentDeps } from '../../src/agent/agent-loop.js';
import { MessageBus } from '../../src/bus/message-bus.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { SkillLoader } from '../../src/skills/skill-loader.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { SkillLearner } from '../../src/learner/learner.js';
import { MockProvider } from '../helpers/mock-llm.js';
import { createTestConfig } from '../helpers/test-fixtures.js';
import { PatternGate } from '../../src/gates/pattern-gate.js';
import type { GateService } from '../../src/gates/types.js';
import type { LearnerStorage, ExecutionRecord } from '../../src/learner/types.js';

class InMemoryLearnerStorage implements LearnerStorage {
  records: ExecutionRecord[] = [];
  async append(record: ExecutionRecord): Promise<void> { this.records.push(record); }
  async getAll(): Promise<ExecutionRecord[]> { return [...this.records]; }
  async getRecent(limit: number): Promise<ExecutionRecord[]> { return this.records.slice(-limit); }
}

function createDeps(mockProvider: MockProvider): { deps: AgentDeps; learnerStorage: InMemoryLearnerStorage } {
  const config = createTestConfig();
  const bus = new MessageBus();
  const registry = new ProviderRegistry();
  registry.register({
    name: 'mock',
    provider: mockProvider,
    model: 'test-model',
    purpose: [],
    priority: 0,
  });

  const tools = new ToolRegistry();
  tools.setContext({
    workspaceDir: config.workspace.dir,
    execDenyPatterns: [],
    execTimeout: 5000,
    maxFileSize: 1_000_000,
  });

  const memory = new MemoryStore(config);
  const sessions = new SessionManager(config);
  const skills = new SkillLoader(config);
  const context = new ContextBuilder({ skills, memory, config });
  const learnerStorage = new InMemoryLearnerStorage();
  const learner = new SkillLearner(learnerStorage);

  return {
    deps: { bus, llm: registry, tools, sessions, context, skills, config, learner },
    learnerStorage,
  };
}

describe('AgentLoop integration', () => {
  it('should process a simple message and return response', async () => {
    const mock = new MockProvider([
      { content: 'Hello! I am Janus.' },
    ]);
    const { deps } = createDeps(mock);
    const agent = new AgentLoop(deps);

    const result = await agent.processDirect('hello');
    expect(result).toBe('Hello! I am Janus.');
    expect(mock.calls).toHaveLength(1);
  });

  it('should execute tool calls and return final response', async () => {
    const mock = new MockProvider([
      // First: LLM wants to call a tool
      {
        content: 'Let me list the directory.',
        toolCalls: [{
          id: 'tc-1',
          type: 'function',
          function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
        }],
      },
      // Second: LLM gives final response after tool result
      { content: 'The directory contains test files.' },
    ]);

    const { deps } = createDeps(mock);
    // Register a simple tool for the test
    deps.tools.register({
      name: 'list_dir',
      description: 'List directory contents',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async () => 'file1.txt\nfile2.txt',
    });

    const agent = new AgentLoop(deps);
    const result = await agent.processDirect('list the current directory');

    expect(result).toBe('The directory contains test files.');
    // LLM should have been called twice: once for initial + once after tool result
    expect(mock.calls).toHaveLength(2);
  });

  it('should save session after processing', async () => {
    const mock = new MockProvider([{ content: 'Stored!' }]);
    const { deps } = createDeps(mock);
    const agent = new AgentLoop(deps);

    await agent.processDirect('save this', { channel: 'test', chatId: 'test-session' });

    const history = await deps.sessions.getHistory('test:test-session');
    expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(history.some(m => m.role === 'user' && m.content === 'save this')).toBe(true);
    expect(history.some(m => m.role === 'assistant' && m.content === 'Stored!')).toBe(true);
  });

  it('should record learner metrics after processing', async () => {
    const mock = new MockProvider([{ content: 'Done.' }]);
    const { deps, learnerStorage } = createDeps(mock);
    const agent = new AgentLoop(deps);

    await agent.processDirect('do something');

    // Wait for fire-and-forget learner record
    await new Promise(r => setTimeout(r, 50));

    expect(learnerStorage.records).toHaveLength(1);
    expect(learnerStorage.records[0].outcome).toBe('success');
    expect(learnerStorage.records[0].iterations).toBe(1);
  });

  it('should include userMessage in context build (for memory search)', async () => {
    const mock = new MockProvider([{ content: 'response' }]);
    const { deps } = createDeps(mock);
    const agent = new AgentLoop(deps);

    await agent.processDirect('what tools are available');

    // Verify the system prompt was passed to LLM
    expect(mock.calls[0].messages[0].role).toBe('system');
    expect(mock.calls[0].messages[0].content).toContain('Janus');
  });

  it('should handle LLM errors gracefully', async () => {
    const failingProvider: MockProvider = {
      calls: [],
      async chat() { throw new Error('API down'); },
    } as any;

    const config = createTestConfig({ agent: { maxIterations: 2, onLLMError: 'stop' } });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({
      name: 'failing',
      provider: failingProvider,
      model: 'test',
      purpose: [],
      priority: 0,
    });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });
    const result = await agent.processDirect('hello');

    expect(result).toContain('error');
  });

  it('should use streaming and deliver chunks via bus', async () => {
    const mock = new MockProvider([
      { content: 'Streamed response here' },
    ]);
    const config = createTestConfig({ streaming: { enabled: true } });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });

    // Collect streamed messages
    const received: Array<{ type?: string; content: string }> = [];
    bus.registerHandler('cli', async (msg) => {
      received.push({ type: msg.type, content: msg.content });
    });

    const result = await agent.processDirect('hello', { channel: 'cli', chatId: 'test' });

    expect(result).toBe('Streamed response here');
    // Should have received chunk(s) + stream_end
    expect(received.some(r => r.type === 'chunk')).toBe(true);
    expect(received.some(r => r.type === 'stream_end')).toBe(true);
    // Mock provider should have used chatStream
    expect(mock.streamCalls).toHaveLength(1);
  });

  it('should pass user and scope through processDirect', async () => {
    const mock = new MockProvider([{ content: 'Hello Alice!' }]);
    const { deps } = createDeps(mock);
    const agent = new AgentLoop(deps);

    const result = await agent.processDirect('hello', {
      channel: 'telegram',
      chatId: '123',
      user: { userId: 'user1', name: 'Alice', channelUserId: '123456789' },
      scope: { kind: 'user', id: 'user1' },
    });

    expect(result).toBe('Hello Alice!');
    // System prompt should contain user info
    const systemMsg = mock.calls[0].messages[0];
    expect(systemMsg.content).toContain('Alice');
    expect(systemMsg.content).toContain('User: user1');
    expect(systemMsg.content).toContain('Scope: user:user1');
  });

  it('should enforce tool deny list from user profile', async () => {
    const mock = new MockProvider([
      {
        content: 'Let me execute that.',
        toolCalls: [{
          id: 'tc-deny',
          type: 'function',
          function: { name: 'exec', arguments: JSON.stringify({ command: 'ls' }) },
        }],
      },
      { content: 'Tool was blocked.' },
    ]);

    const config = createTestConfig({
      users: [{
        id: 'zuzia',
        name: 'Zuzia',
        identities: [],
        tools: { deny: ['exec'] },
      }],
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.register({
      name: 'exec',
      description: 'Execute command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async () => 'executed',
    });

    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });
    const result = await agent.processDirect('run ls', {
      user: { userId: 'zuzia', name: 'Zuzia' },
      scope: { kind: 'user', id: 'zuzia' },
    });

    expect(result).toBe('Tool was blocked.');
    // The tool result in mock.calls[1] should contain the deny message
    const toolResultMsg = mock.calls[1].messages.find((m: any) => m.role === 'tool');
    expect(toolResultMsg?.content).toContain('not available for this user');
  });

  it('should process without user/scope (backward-compat)', async () => {
    const mock = new MockProvider([{ content: 'No user context.' }]);
    const { deps } = createDeps(mock);
    const agent = new AgentLoop(deps);

    const result = await agent.processDirect('hello');
    expect(result).toBe('No user context.');
    // System prompt should not contain user section
    const systemMsg = mock.calls[0].messages[0];
    expect(systemMsg.content).not.toContain('<user>');
  });

  it('should enforce tool allow list from user profile', async () => {
    const mock = new MockProvider([
      {
        content: 'Let me write a file.',
        toolCalls: [{
          id: 'tc-allow',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'test.txt', content: 'hi' }) },
        }],
      },
      { content: 'Blocked.' },
    ]);

    const config = createTestConfig({
      users: [{
        id: 'zuzia',
        name: 'Zuzia',
        identities: [],
        tools: { allow: ['read_file'] }, // Only read_file allowed
      }],
    });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.register({
      name: 'write_file',
      description: 'Write file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      execute: async () => 'written',
    });

    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner });
    const result = await agent.processDirect('write test.txt', {
      user: { userId: 'zuzia', name: 'Zuzia' },
    });

    expect(result).toBe('Blocked.');
  });

  it('should deny tool execution when gate denies', async () => {
    const mock = new MockProvider([
      {
        content: 'Let me remove the directory.',
        toolCalls: [{
          id: 'tc-gate',
          type: 'function',
          function: { name: 'exec', arguments: JSON.stringify({ command: 'rm -rf build/' }) },
        }],
      },
      { content: 'The action was denied.' },
    ]);

    const { deps } = createDeps(mock);

    // Register exec tool
    let execCalled = false;
    deps.tools.register({
      name: 'exec',
      description: 'Execute a shell command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: async () => { execCalled = true; return 'done'; },
    });

    // Set up gate that always denies
    const alwaysDeny: GateService = {
      async confirm(): Promise<boolean> { return false; },
    };
    deps.tools.setGate(new PatternGate(['rm\\s']), alwaysDeny);

    const agent = new AgentLoop(deps);
    const result = await agent.processDirect('remove build directory');

    expect(result).toBe('The action was denied.');
    expect(execCalled).toBe(false);
  });
});
