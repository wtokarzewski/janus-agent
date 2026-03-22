import { describe, it, expect } from 'vitest';
import { AgentResolver } from '../../src/agent/agent-resolver.js';
import type { JanusConfig } from '../../src/config/schema.js';
import type { InboundMessage } from '../../src/bus/types.js';

function makeConfig(overrides: Partial<JanusConfig> = {}): JanusConfig {
  return {
    agents: [],
    bindings: [],
    defaultAgentId: 'main',
    ...overrides,
  } as unknown as JanusConfig;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: '1',
    channel: 'telegram',
    chatId: '123',
    content: 'hello',
    author: 'user',
    timestamp: new Date(),
    ...overrides,
  };
}

describe('AgentResolver', () => {
  it('synthesizes implicit main agent when agents[] is empty', () => {
    const resolver = new AgentResolver(makeConfig());
    const ctx = resolver.resolve(makeMsg());
    expect(ctx.id).toBe('main');
    expect(ctx.name).toBe('Janus');
  });

  it('resolves single configured agent', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [{ id: 'solo', name: 'Solo', skillsDirs: [] }],
      defaultAgentId: 'solo',
    }));
    const ctx = resolver.resolve(makeMsg());
    expect(ctx.id).toBe('solo');
    expect(ctx.name).toBe('Solo');
  });

  it('routes by channel + chatId binding', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'work', name: 'Work', skillsDirs: [] },
        { id: 'main', name: 'Janus', skillsDirs: [] },
      ],
      bindings: [
        { agentId: 'work', match: { channel: 'telegram', chatId: '-100987654' } },
        { agentId: 'main', match: {} },
      ],
    }));

    const work = resolver.resolve(makeMsg({ channel: 'telegram', chatId: '-100987654' }));
    expect(work.id).toBe('work');

    const main = resolver.resolve(makeMsg({ channel: 'telegram', chatId: '999' }));
    expect(main.id).toBe('main');
  });

  it('first match wins (array order = priority)', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'a', name: 'A', skillsDirs: [] },
        { id: 'b', name: 'B', skillsDirs: [] },
      ],
      bindings: [
        { agentId: 'a', match: { channel: 'telegram' } },
        { agentId: 'b', match: { channel: 'telegram' } },
      ],
    }));
    expect(resolver.resolve(makeMsg()).id).toBe('a');
  });

  it('matches generic keys (topicId, guildId)', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'topic', name: 'Topic', skillsDirs: [] },
        { id: 'main', name: 'Janus', skillsDirs: [] },
      ],
      bindings: [
        { agentId: 'topic', match: { topicId: 42 } },
        { agentId: 'main', match: {} },
      ],
    }));

    const withTopic = resolver.resolve(makeMsg({ routingMeta: { topicId: 42 } }));
    expect(withTopic.id).toBe('topic');

    const noTopic = resolver.resolve(makeMsg());
    expect(noTopic.id).toBe('main');
  });

  it('empty match {} catches everything', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [{ id: 'catch', name: 'Catch', skillsDirs: [] }],
      bindings: [{ agentId: 'catch', match: {} }],
    }));
    expect(resolver.resolve(makeMsg({ channel: 'cli', chatId: 'whatever' })).id).toBe('catch');
  });

  it('partial match — channel-only binding matches any message on that channel', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'tg', name: 'TG', skillsDirs: [] },
        { id: 'main', name: 'Janus', skillsDirs: [] },
      ],
      bindings: [
        { agentId: 'tg', match: { channel: 'telegram' } },
        { agentId: 'main', match: {} },
      ],
    }));

    expect(resolver.resolve(makeMsg({ channel: 'telegram', chatId: '111' })).id).toBe('tg');
    expect(resolver.resolve(makeMsg({ channel: 'telegram', chatId: '222' })).id).toBe('tg');
    expect(resolver.resolve(makeMsg({ channel: 'cli', chatId: 'x' })).id).toBe('main');
  });

  it('falls back to defaultAgentId when no binding matches', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'work', name: 'Work', skillsDirs: [] },
        { id: 'fallback', name: 'Fallback', skillsDirs: [] },
      ],
      bindings: [
        { agentId: 'work', match: { channel: 'discord' } },
      ],
      defaultAgentId: 'fallback',
    }));

    expect(resolver.resolve(makeMsg({ channel: 'telegram' })).id).toBe('fallback');
  });

  it('uses agentId from message directly (cron/system)', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'cron-agent', name: 'Cron', skillsDirs: [] },
        { id: 'main', name: 'Janus', skillsDirs: [] },
      ],
    }));

    const ctx = resolver.resolve(makeMsg({ agentId: 'cron-agent' }));
    expect(ctx.id).toBe('cron-agent');
  });

  it('preserves per-agent params (temperature, maxTokens)', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [{
        id: 'creative',
        name: 'Creative',
        skillsDirs: [],
        params: { temperature: 0.9, maxTokens: 8000 },
      }],
      defaultAgentId: 'creative',
    }));

    const ctx = resolver.resolve(makeMsg());
    expect(ctx.params?.temperature).toBe(0.9);
    expect(ctx.params?.maxTokens).toBe(8000);
  });

  it('preserves tool allow/deny from agent definition', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [{
        id: 'safe',
        name: 'Safe',
        skillsDirs: [],
        tools: { allow: ['read_file', 'list_dir'], deny: ['exec'] },
      }],
      defaultAgentId: 'safe',
    }));

    const ctx = resolver.resolve(makeMsg());
    expect(ctx.toolAllow).toEqual(['read_file', 'list_dir']);
    expect(ctx.toolDeny).toEqual(['exec']);
  });

  it('preserves memory.shared flag', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [{
        id: 'isolated',
        name: 'Isolated',
        skillsDirs: [],
        memory: { shared: false },
      }],
      defaultAgentId: 'isolated',
    }));

    expect(resolver.resolve(makeMsg()).memoryShared).toBe(false);
  });

  it('list() returns all agents', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [
        { id: 'a', name: 'A', skillsDirs: [] },
        { id: 'b', name: 'B', skillsDirs: [] },
      ],
    }));
    expect(resolver.list().map(a => a.id)).toEqual(['a', 'b']);
  });

  it('get() returns agent by id', () => {
    const resolver = new AgentResolver(makeConfig({
      agents: [{ id: 'x', name: 'X', skillsDirs: [] }],
    }));
    expect(resolver.get('x')?.name).toBe('X');
    expect(resolver.get('nonexistent')).toBeUndefined();
  });
});
