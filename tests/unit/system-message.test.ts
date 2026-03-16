/**
 * Tests for system message handling — no-op suppression for heartbeat/cron responses.
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
import { MessageTool } from '../../src/tools/builtin/message.js';
import type { LearnerStorage, ExecutionRecord } from '../../src/learner/types.js';
import type { InboundMessage, OutboundMessage } from '../../src/bus/types.js';

class InMemoryLearnerStorage implements LearnerStorage {
  records: ExecutionRecord[] = [];
  async append(record: ExecutionRecord): Promise<void> { this.records.push(record); }
  async getAll(): Promise<ExecutionRecord[]> { return [...this.records]; }
  async getRecent(limit: number): Promise<ExecutionRecord[]> { return this.records.slice(-limit); }
}

function createDeps(mockProvider: MockProvider) {
  const config = createTestConfig({ streaming: { enabled: false } });
  const bus = new MessageBus();
  const registry = new ProviderRegistry();
  registry.register({ name: 'mock', provider: mockProvider, model: 'test', purpose: [], priority: 0 });
  const tools = new ToolRegistry();
  tools.setContext({ workspaceDir: config.workspace.dir, execDenyPatterns: [], execTimeout: 5000, maxFileSize: 1_000_000 });
  const memory = new MemoryStore(config);
  const sessions = new SessionManager(config);
  const skills = new SkillLoader(config);
  const context = new ContextBuilder({ skills, memory, config });
  const learner = new SkillLearner(new InMemoryLearnerStorage());
  const deps: AgentDeps = { bus, llm: registry, tools, sessions, context, skills, config, learner };
  return { deps, bus };
}

describe('System message no-op suppression', () => {
  it('should suppress HEARTBEAT_OK responses', async () => {
    const mock = new MockProvider([{ content: 'HEARTBEAT_OK' }]);
    const { deps, bus } = createDeps(mock);
    const agent = new AgentLoop(deps);

    const published: OutboundMessage[] = [];
    bus.registerHandler('cli', async (msg) => { published.push(msg); });

    const ac = new AbortController();

    // Start dispatcher to route outbound messages
    const dispatcherPromise = bus.startDispatcher(ac.signal);

    const msg: InboundMessage = {
      id: 'hb-1',
      channel: 'system',
      chatId: 'heartbeat',
      content: 'Check heartbeat tasks',
      author: 'system',
      timestamp: new Date(),
    };
    await bus.publishInbound(msg, ac.signal);

    const agentPromise = agent.run(ac.signal);
    await new Promise(r => setTimeout(r, 300));
    ac.abort();
    await Promise.allSettled([agentPromise, dispatcherPromise]);

    // No-op response should be suppressed
    expect(published).toHaveLength(0);
  });

  it('should NOT suppress meaningful system responses', async () => {
    const mock = new MockProvider([{ content: 'I completed the scheduled task and updated the report.' }]);
    const { deps, bus } = createDeps(mock);
    // Add user with Telegram identity so cron routing can find a target
    deps.config.users = [{
      id: 'alice', name: 'Alice',
      identities: [{ channel: 'telegram', channelUserId: '123' }],
    }];
    const agent = new AgentLoop(deps);

    const published: OutboundMessage[] = [];
    bus.registerHandler('telegram', async (msg) => { published.push(msg); });

    const ac = new AbortController();

    // Start dispatcher to route outbound messages
    const dispatcherPromise = bus.startDispatcher(ac.signal);

    const msg: InboundMessage = {
      id: 'cron-1',
      channel: 'system',
      chatId: 'cron:daily-report',
      content: 'Generate daily report',
      author: 'system',
      timestamp: new Date(),
      user: { userId: 'alice', name: 'Alice' },
    };
    await bus.publishInbound(msg, ac.signal);

    const agentPromise = agent.run(ac.signal);
    await new Promise(r => setTimeout(r, 300));
    ac.abort();
    await Promise.allSettled([agentPromise, dispatcherPromise]);

    // Meaningful response should NOT be suppressed — routed to user's Telegram
    expect(published.length).toBeGreaterThan(0);
    expect(published[0].content).toContain('completed the scheduled task');
  });
});

describe('Duplicate cron response suppression via sentTargets', () => {
  it('should suppress response when message tool already sent to same target', async () => {
    const mock = new MockProvider([
      {
        content: '',
        toolCalls: [{
          id: 'tc1',
          type: 'function',
          function: {
            name: 'message',
            arguments: JSON.stringify({ channel: 'telegram', chat_id: '123', content: 'Report ready' }),
          },
        }],
      },
      { content: 'I sent the report to your Telegram.' },
    ]);
    const { deps, bus } = createDeps(mock);
    // Register MessageTool so the agent can execute it
    deps.tools.register(new MessageTool(bus));
    deps.config.users = [{
      id: 'alice', name: 'Alice',
      identities: [{ channel: 'telegram', channelUserId: '123' }],
    }];
    const agent = new AgentLoop(deps);

    const published: OutboundMessage[] = [];
    bus.registerHandler('telegram', async (msg) => { published.push(msg); });

    const ac = new AbortController();
    const dispatcherPromise = bus.startDispatcher(ac.signal);

    const msg: InboundMessage = {
      id: 'cron-dup-1',
      channel: 'system',
      chatId: 'cron:daily-report',
      content: 'Generate daily report',
      author: 'system',
      timestamp: new Date(),
      user: { userId: 'alice', name: 'Alice' },
    };
    await bus.publishInbound(msg, ac.signal);

    const agentPromise = agent.run(ac.signal);
    await new Promise(r => setTimeout(r, 500));
    ac.abort();
    await Promise.allSettled([agentPromise, dispatcherPromise]);

    // Only 1 message (from message tool), the LLM summary response should be suppressed
    expect(published).toHaveLength(1);
    expect(published[0].content).toBe('Report ready');
  });

  it('should NOT suppress response when message tool sent to different target', async () => {
    const mock = new MockProvider([
      {
        content: '',
        toolCalls: [{
          id: 'tc2',
          type: 'function',
          function: {
            name: 'message',
            arguments: JSON.stringify({ channel: 'telegram', chat_id: '456', content: 'Notification for Bob' }),
          },
        }],
      },
      { content: 'I notified Bob and here is your summary.' },
    ]);
    const { deps, bus } = createDeps(mock);
    deps.tools.register(new MessageTool(bus));
    deps.config.users = [
      { id: 'alice', name: 'Alice', identities: [{ channel: 'telegram', channelUserId: '123' }] },
      { id: 'bob', name: 'Bob', identities: [{ channel: 'telegram', channelUserId: '456' }] },
    ];
    const agent = new AgentLoop(deps);

    const published: OutboundMessage[] = [];
    bus.registerHandler('telegram', async (msg) => { published.push(msg); });

    const ac = new AbortController();
    const dispatcherPromise = bus.startDispatcher(ac.signal);

    const msg: InboundMessage = {
      id: 'cron-diff-1',
      channel: 'system',
      chatId: 'cron:daily-report',
      content: 'Generate daily report',
      author: 'system',
      timestamp: new Date(),
      user: { userId: 'alice', name: 'Alice' },
    };
    await bus.publishInbound(msg, ac.signal);

    const agentPromise = agent.run(ac.signal);
    await new Promise(r => setTimeout(r, 500));
    ac.abort();
    await Promise.allSettled([agentPromise, dispatcherPromise]);

    // 2 messages: message tool → 456 (Bob) + system response → 123 (Alice)
    expect(published).toHaveLength(2);
    expect(published.some(m => m.chatId === '456' && m.content === 'Notification for Bob')).toBe(true);
    expect(published.some(m => m.chatId === '123' && m.content.includes('summary'))).toBe(true);
  });
});
