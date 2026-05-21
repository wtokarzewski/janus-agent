import { describe, it, expect } from 'vitest';
import { JanusConfigSchema } from '../../src/config/schema.js';
import { resolveLLM } from '../../src/config/config.js';

describe('JanusConfigSchema', () => {
  it('should produce all defaults from empty object', () => {
    const config = JanusConfigSchema.parse({});

    expect(config.llm.maxTokens).toBe(4096);
    expect(config.llm.temperature).toBe(0.3);
    expect(config.agent.toolRetries).toBe(2);
    expect(config.workspace.dir).toBe('.');
    expect(config.workspace.memoryDir).toBe('memory');
    expect(config.tools.execTimeout).toBe(30_000);
    expect(config.database.enabled).toBe(true);
    expect(config.database.path).toBe('.janus/janus.db');
    expect(config.heartbeat.enabled).toBe(false);
    expect(config.telegram.enabled).toBe(false);
  });

  it('should accept custom values', () => {
    const config = JanusConfigSchema.parse({
      llm: { model: 'gpt-4o', maxTokens: 8192 },
      agent: { tokenBudget: 500_000 },
      database: { enabled: false, path: '/tmp/test.db' },
    });

    expect(config.llm.model).toBe('gpt-4o');
    expect(config.llm.maxTokens).toBe(8192);
    expect(config.agent.tokenBudget).toBe(500_000);
    expect(config.database.enabled).toBe(false);
    expect(config.database.path).toBe('/tmp/test.db');
  });

  it('should validate exec deny patterns as string array', () => {
    const config = JanusConfigSchema.parse({
      tools: { execDenyPatterns: ['rm -rf /'] },
    });
    expect(config.tools.execDenyPatterns).toEqual(['rm -rf /']);
  });

  it('should accept new providers object format', () => {
    const config = JanusConfigSchema.parse({
      llm: {
        providers: {
          anthropic: { auth: 'oauth', priority: 0 },
          openrouter: { priority: 1 },
        },
        slots: {
          default: { anthropic: 'claude-sonnet-4-6', openrouter: 'anthropic/claude-sonnet-4-6' },
          background: null,
        },
      },
    });
    expect(config.llm.providers).toBeDefined();
    expect(config.llm.providers!.anthropic.priority).toBe(0);
    expect(config.llm.providers!.anthropic.auth).toBe('oauth');
    expect(config.llm.slots!.default).toEqual({ anthropic: 'claude-sonnet-4-6', openrouter: 'anthropic/claude-sonnet-4-6' });
    expect(config.llm.slots!.background).toBeNull();
  });

  it('should accept auth field with valid values', () => {
    const config = JanusConfigSchema.parse({
      llm: { auth: 'oauth', provider: 'anthropic', model: 'claude-sonnet-4-6' },
    });
    expect(config.llm.auth).toBe('oauth');
  });

  it('should accept auth=cli for subscription providers', () => {
    const config = JanusConfigSchema.parse({
      llm: { auth: 'cli', provider: 'claude-agent', model: 'claude-sonnet-4-6' },
    });
    expect(config.llm.auth).toBe('cli');
  });

  it('should default auth to undefined', () => {
    const config = JanusConfigSchema.parse({});
    expect(config.llm.auth).toBeUndefined();
  });

  it('should reject invalid auth values', () => {
    expect(() => JanusConfigSchema.parse({
      llm: { auth: 'invalid' },
    })).toThrow();
  });

  it('should reject invalid types', () => {
    expect(() => JanusConfigSchema.parse({
      agent: { tokenBudget: 'not a number' },
    })).toThrow();
  });

  it('should produce subagents defaults', () => {
    const config = JanusConfigSchema.parse({});
    expect(config.agent.subagents.maxSpawnDepth).toBe(1);
    expect(config.agent.subagents.maxChildrenPerAgent).toBe(5);
    expect(config.agent.subagents.maxConcurrentSubagents).toBe(8);
  });

  it('should accept custom subagents config', () => {
    const config = JanusConfigSchema.parse({
      agent: { subagents: { maxSpawnDepth: 2, maxChildrenPerAgent: 3, maxConcurrentSubagents: 4 } },
    });
    expect(config.agent.subagents.maxSpawnDepth).toBe(2);
    expect(config.agent.subagents.maxChildrenPerAgent).toBe(3);
    expect(config.agent.subagents.maxConcurrentSubagents).toBe(4);
  });

  it('should produce context defaults', () => {
    const config = JanusConfigSchema.parse({});
    expect(config.agent.context.keepRecentTokens).toBe(20_000);
    expect(config.agent.context.reserveTokens).toBe(20_000);
    expect(config.agent.context.toolResultMaxShare).toBe(0.3);
    expect(config.agent.context.toolResultHardMax).toBe(400_000);
    expect(config.agent.context.softTrimChars).toBe(4000);
    expect(config.agent.context.compactionThresholds).toEqual([0.75, 0.80, 0.85]);
    expect(config.agent.context.emergencyThreshold).toBe(0.95);
    expect(config.agent.context.protectedTailTurns).toBe(3);
  });

  it('should accept custom context config', () => {
    const config = JanusConfigSchema.parse({
      agent: {
        context: {
          keepRecentTokens: 30_000,
          reserveTokens: 10_000,
          toolResultMaxShare: 0.5,
          toolResultHardMax: 200_000,
          softTrimChars: 8000,
          compactionThresholds: [0.60, 0.70, 0.80],
          emergencyThreshold: 0.90,
          protectedTailTurns: 5,
        },
      },
    });
    expect(config.agent.context.keepRecentTokens).toBe(30_000);
    expect(config.agent.context.reserveTokens).toBe(10_000);
    expect(config.agent.context.toolResultMaxShare).toBe(0.5);
    expect(config.agent.context.toolResultHardMax).toBe(200_000);
    expect(config.agent.context.softTrimChars).toBe(8000);
    expect(config.agent.context.compactionThresholds).toEqual([0.60, 0.70, 0.80]);
    expect(config.agent.context.emergencyThreshold).toBe(0.90);
    expect(config.agent.context.protectedTailTurns).toBe(5);
  });

  it('should reject toolResultMaxShare outside 0.01–1.0', () => {
    expect(() => JanusConfigSchema.parse({
      agent: { context: { toolResultMaxShare: 0 } },
    })).toThrow();
    expect(() => JanusConfigSchema.parse({
      agent: { context: { toolResultMaxShare: 1.5 } },
    })).toThrow();
  });

  it('should reject negative protectedTailTurns', () => {
    expect(() => JanusConfigSchema.parse({
      agent: { context: { protectedTailTurns: -1 } },
    })).toThrow();
  });

  it('should default users to empty array', () => {
    const config = JanusConfigSchema.parse({});
    expect(config.users).toEqual([]);
    expect(config.family).toBeUndefined();
  });

  it('should accept valid user profiles', () => {
    const config = JanusConfigSchema.parse({
      users: [{
        id: 'user1',
        name: 'Alice',
        identities: [
          { channel: 'telegram', channelUserId: '123456789', channelUsername: 'alice_t' },
        ],
        tools: { allow: ['exec', 'read_file'], deny: ['dangerous_exec'] },
        skills: { allow: ['programmer'], deny: ['admin'] },
      }],
    });
    expect(config.users).toHaveLength(1);
    expect(config.users[0].id).toBe('user1');
    expect(config.users[0].identities).toHaveLength(1);
    expect(config.users[0].tools?.allow).toEqual(['exec', 'read_file']);
    expect(config.users[0].skills?.deny).toEqual(['admin']);
  });

  it('should accept valid family config', () => {
    const config = JanusConfigSchema.parse({
      family: {
        id: 'family_alice',
        name: 'Tokarzewscy',
        groupChatIds: ['-100987654321'],
      },
    });
    expect(config.family).toBeDefined();
    expect(config.family!.id).toBe('family_alice');
    expect(config.family!.groupChatIds).toEqual(['-100987654321']);
  });

  it('should accept tool policy schema', () => {
    const config = JanusConfigSchema.parse({
      users: [{
        id: 'dave',
        name: 'Dave',
        identities: [],
        tools: {
          allow: ['web.search'],
          policy: { contentRating: 'PG', maxRecencyDays: 30 },
        },
      }],
    });
    expect(config.users[0].tools?.policy?.contentRating).toBe('PG');
    expect(config.users[0].tools?.policy?.maxRecencyDays).toBe(30);
  });
});

describe('resolveLLM', () => {
  it('should resolve new providers+slots format', () => {
    const raw = JanusConfigSchema.parse({
      llm: {
        providers: {
          anthropic: { auth: 'oauth', priority: 0 },
          openrouter: { priority: 1 },
        },
        slots: {
          default: { anthropic: 'claude-sonnet-4-6', openrouter: 'anthropic/claude-sonnet-4-6' },
          background: { anthropic: 'claude-haiku-4-5-20251001' },
        },
      },
    });
    const resolved = resolveLLM(raw);

    expect(resolved.providers).toHaveLength(2);
    expect(resolved.providers[0].name).toBe('anthropic');
    expect(resolved.providers[0].auth).toBe('oauth');
    expect(resolved.providers[0].priority).toBe(0);
    expect(resolved.providers[1].name).toBe('openrouter');
    expect(resolved.providers[1].priority).toBe(1);

    expect(resolved.slots).toHaveLength(2);
    const defaultSlot = resolved.slots.find(s => s.name === 'default')!;
    expect(defaultSlot.entries).toHaveLength(2);
    expect(defaultSlot.entries[0].provider).toBe('anthropic');
    expect(defaultSlot.entries[0].model).toBe('claude-sonnet-4-6');
    expect(defaultSlot.entries[1].provider).toBe('openrouter');

    const bgSlot = resolved.slots.find(s => s.name === 'background')!;
    expect(bgSlot.entries).toHaveLength(1);
    expect(bgSlot.entries[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('should resolve null slot to empty entries', () => {
    const raw = JanusConfigSchema.parse({
      llm: {
        providers: { anthropic: { priority: 0 } },
        slots: { default: { anthropic: 'claude-sonnet-4-6' }, background: null },
      },
    });
    const resolved = resolveLLM(raw);
    const bgSlot = resolved.slots.find(s => s.name === 'background')!;
    expect(bgSlot.entries).toEqual([]);
  });

  it('should resolve legacy flat config', () => {
    const raw = JanusConfigSchema.parse({
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-6', auth: 'oauth' },
    });
    const resolved = resolveLLM(raw);

    expect(resolved.providers).toHaveLength(1);
    expect(resolved.providers[0].name).toBe('anthropic');
    expect(resolved.providers[0].auth).toBe('oauth');

    expect(resolved.slots).toHaveLength(1);
    expect(resolved.slots[0].name).toBe('default');
    expect(resolved.slots[0].entries[0].model).toBe('claude-sonnet-4-6');
  });

  it('should resolve empty config', () => {
    const raw = JanusConfigSchema.parse({});
    const resolved = resolveLLM(raw);
    expect(resolved.providers).toHaveLength(0);
    expect(resolved.slots[0].entries).toHaveLength(0);
  });

  it('should sort slot entries by provider priority', () => {
    const raw = JanusConfigSchema.parse({
      llm: {
        providers: {
          openrouter: { priority: 1 },
          anthropic: { priority: 0 },
        },
        slots: {
          default: { openrouter: 'anthropic/claude-sonnet-4-6', anthropic: 'claude-sonnet-4-6' },
        },
      },
    });
    const resolved = resolveLLM(raw);
    const defaultSlot = resolved.slots.find(s => s.name === 'default')!;
    // anthropic has priority 0, should be first
    expect(defaultSlot.entries[0].provider).toBe('anthropic');
    expect(defaultSlot.entries[1].provider).toBe('openrouter');
  });

  it('should infer cli auth for subscription providers', () => {
    const raw = JanusConfigSchema.parse({
      llm: { provider: 'claude-agent', model: 'claude-sonnet-4-6' },
    });
    const resolved = resolveLLM(raw);
    expect(resolved.providers[0].auth).toBe('cli');
  });
});
