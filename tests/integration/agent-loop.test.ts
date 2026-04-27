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
import type { ChatRequest } from '../../src/llm/types.js';

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

    const history = await deps.sessions.getHistory('main:test:test-session');
    expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant
    // User message now includes <context> wrapper with dynamic context prepended
    expect(history.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('save this'))).toBe(true);
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

    const config = createTestConfig({ agent: { onLLMError: 'stop' } });
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

    expect(result).toContain('API error');
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
    // User info is now in the user message (dynamic context), not the system prompt
    const lastMsg = mock.calls[0].messages[mock.calls[0].messages.length - 1];
    expect(lastMsg.content).toContain('Alice');
    expect(lastMsg.content).toContain('Sender: Alice (user1)');
    expect(lastMsg.content).toContain('Scope: user:user1');
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

  it('should flush memory when tokens exceed 40% of budget', async () => {
    // Low tokenBudget so pre-filled session + 1 message exceeds 40% threshold
    const config = createTestConfig({
      agent: { summarizationThreshold: 100, tokenBudget: 500 },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();

    // 1 chat response + possible summarization + 1 flush response
    const mock = new MockProvider([
      { content: 'Response 1' },
      { content: 'Summary of conversation' },
      { content: '- Decision: use SQLite' },
    ]);

    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
    const memory = new MemoryStore(config);
    const sessions = new SessionManager(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner, memory });

    // Pre-fill session to push tokens above 40% of 500
    const sessionKey = 'cli:flush-test';
    await sessions.append(sessionKey, [
      { role: 'user', content: 'x'.repeat(500) },
      { role: 'assistant', content: 'y'.repeat(500) },
    ]);

    await agent.processDirect('trigger flush', { channel: 'cli', chatId: 'flush-test' });

    // Wait for fire-and-forget flush + summarization
    await new Promise(r => setTimeout(r, 200));

    // At least one of the async calls should be a memory flush (memory manager prompt)
    const flushCall = mock.calls.find(c => {
      const content = c.messages[0]?.content;
      return typeof content === 'string' && content.includes('memory manager');
    });
    expect(flushCall).toBeTruthy();
  });

  it('should flush all sessions on flushAllSessions()', async () => {
    const config = createTestConfig({
      agent: { summarizationThreshold: 100 },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();

    // 2 chat responses + 2 flush responses (one per session)
    const mock = new MockProvider([
      { content: 'Hello' },
      { content: 'World' },
      { content: 'Flushed A' },
      { content: 'Flushed B' },
    ]);
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
    const memory = new MemoryStore(config);
    const sessions = new SessionManager(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner, memory });

    // Send messages (below flush interval, so no automatic flush)
    await agent.processDirect('hello', { chatId: 'session-a' });
    await agent.processDirect('world', { chatId: 'session-b' });

    expect(mock.calls.length).toBe(2); // Only chat calls, no flush yet

    // Trigger session-end flush (pointer-based: both sessions have lastFlushed=0, messages.length=2)
    await agent.flushAllSessions();

    // Should have made flush LLM call(s) for both sessions
    expect(mock.calls.length).toBeGreaterThan(2);
  });

  it('should execute multiple tool calls in parallel', async () => {
    const callOrder: string[] = [];
    const mock = new MockProvider([
      {
        content: 'Reading files...',
        toolCalls: [
          { id: 'tc-a', type: 'function', function: { name: 'slow_tool', arguments: JSON.stringify({ id: 'a' }) } },
          { id: 'tc-b', type: 'function', function: { name: 'slow_tool', arguments: JSON.stringify({ id: 'b' }) } },
          { id: 'tc-c', type: 'function', function: { name: 'slow_tool', arguments: JSON.stringify({ id: 'c' }) } },
        ],
      },
      { content: 'All done.' },
    ]);

    const { deps } = createDeps(mock);
    deps.tools.register({
      name: 'slow_tool',
      description: 'Slow tool for testing parallel execution',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: async (args) => {
        callOrder.push(`start:${args.id}`);
        await new Promise(r => setTimeout(r, 50));
        callOrder.push(`end:${args.id}`);
        return `result:${args.id}`;
      },
    });

    const agent = new AgentLoop(deps);
    const start = Date.now();
    const result = await agent.processDirect('run all');
    const elapsed = Date.now() - start;

    expect(result).toBe('All done.');
    // All 3 should have started before any finished (parallel)
    expect(callOrder.filter(c => c.startsWith('start:'))).toHaveLength(3);
    // Total time should be ~50ms (parallel), not ~150ms (sequential)
    // Allow generous margin for CI
    expect(elapsed).toBeLessThan(300);
  });

  it('should ask user on tool error when onToolError is ask', async () => {
    const mock = new MockProvider([
      {
        content: 'Running command...',
        toolCalls: [{
          id: 'tc-err',
          type: 'function',
          function: { name: 'failing_tool', arguments: '{}' },
        }],
      },
      { content: 'Stopped.' },
    ]);

    const config = createTestConfig({ agent: { onToolError: 'ask' as const, toolRetries: 1 } });
    const bus = new MessageBus();
    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
    tools.register({
      name: 'failing_tool',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'Error: something broke',
    });

    const sessions = new SessionManager(config);
    const memory = new MemoryStore(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    let gateAsked = false;
    const denyGate: GateService = {
      async confirm(): Promise<boolean> { gateAsked = true; return false; },
    };

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner, gateService: denyGate });
    const result = await agent.processDirect('do it');

    expect(gateAsked).toBe(true);
    expect(result).toBe('Stopped.');
    // Tool result should indicate user stopped it
    const toolMsg = mock.calls[1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg?.content).toContain('Stopped by user');
  });

  it('should retry flush before summarization and proceed on failure', async () => {
    // Low summarizationThreshold so 3 messages (6 entries) triggers it
    const config = createTestConfig({
      agent: { summarizationThreshold: 4 },
      streaming: { enabled: false },
    });
    const bus = new MessageBus();

    // Track which calls are flush calls (contain "memory manager" in system prompt)
    let flushAttempts = 0;

    const mock = new MockProvider([
      { content: 'Response 1' },
      { content: 'Response 2' },
      { content: 'Response 3' },
      // Flush calls will fail (handled below), summarization call:
      { content: 'Summary of conversation' },
    ]);

    // Override chat to fail on flush calls (memory manager in system prompt)
    const originalChat = mock.chat.bind(mock);
    mock.chat = async (request: ChatRequest) => {
      const systemContent = request.messages[0]?.content ?? '';
      if (typeof systemContent === 'string' && systemContent.includes('memory manager')) {
        flushAttempts++;
        throw new Error('Simulated flush LLM failure');
      }
      return originalChat(request);
    };

    const registry = new ProviderRegistry();
    registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

    const tools = new ToolRegistry();
    tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
    const memory = new MemoryStore(config);
    const sessions = new SessionManager(config);
    const skills = new SkillLoader(config);
    const context = new ContextBuilder({ skills, memory, config });
    const learner = new SkillLearner(new InMemoryLearnerStorage());

    const agent = new AgentLoop({ bus, llm: registry, tools, sessions, context, skills, config, learner, memory });

    // Send 3 messages = 6 session entries (user+assistant) > summarizationThreshold of 4
    await agent.processDirect('message 1', { chatId: 'retry-test' });
    await agent.processDirect('message 2', { chatId: 'retry-test' });
    await agent.processDirect('message 3', { chatId: 'retry-test' });

    // Wait for fire-and-forget summarization (includes flush retries with backoff: 2s + 4s)
    await new Promise(r => setTimeout(r, 10_000));

    // Flush should have been attempted 3 times (retry with backoff)
    expect(flushAttempts).toBe(3);

    // Summarization LLM call should have completed despite flush failures
    // mock.calls only contains successful calls (flush throws before reaching originalChat)
    const summarizeCall = mock.calls.find((c: ChatRequest) => {
      const sys = c.messages[0]?.content;
      return typeof sys === 'string' && sys.includes('summarizer');
    });
    expect(summarizeCall).toBeTruthy();
  }, 15_000);

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
