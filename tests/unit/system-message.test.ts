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
    const agent = new AgentLoop(deps);

    const published: OutboundMessage[] = [];
    bus.registerHandler('cli', async (msg) => { published.push(msg); });

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
    };
    await bus.publishInbound(msg, ac.signal);

    const agentPromise = agent.run(ac.signal);
    await new Promise(r => setTimeout(r, 300));
    ac.abort();
    await Promise.allSettled([agentPromise, dispatcherPromise]);

    // Meaningful response should NOT be suppressed
    expect(published.length).toBeGreaterThan(0);
    expect(published[0].content).toContain('completed the scheduled task');
  });
});
