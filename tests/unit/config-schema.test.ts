import { describe, it, expect } from 'vitest';
import { JanusConfigSchema } from '../../src/config/schema.js';

describe('JanusConfigSchema', () => {
  it('should produce all defaults from empty object', () => {
    const config = JanusConfigSchema.parse({});

    expect(config.llm.provider).toBe('openrouter');
    expect(config.llm.maxTokens).toBe(4096);
    expect(config.llm.temperature).toBe(0.7);
    expect(config.agent.maxIterations).toBe(20);
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
      agent: { maxIterations: 50 },
      database: { enabled: false, path: '/tmp/test.db' },
    });

    expect(config.llm.model).toBe('gpt-4o');
    expect(config.llm.maxTokens).toBe(8192);
    expect(config.agent.maxIterations).toBe(50);
    expect(config.database.enabled).toBe(false);
    expect(config.database.path).toBe('/tmp/test.db');
  });

  it('should validate exec deny patterns as string array', () => {
    const config = JanusConfigSchema.parse({
      tools: { execDenyPatterns: ['rm -rf /'] },
    });
    expect(config.tools.execDenyPatterns).toEqual(['rm -rf /']);
  });

  it('should accept empty providers array', () => {
    const config = JanusConfigSchema.parse({
      llm: { providers: [] },
    });
    expect(config.llm.providers).toEqual([]);
  });

  it('should accept valid provider specs', () => {
    const config = JanusConfigSchema.parse({
      llm: {
        providers: [{
          name: 'test',
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'sk-test',
          purpose: ['chat'],
          priority: 1,
        }],
      },
    });
    expect(config.llm.providers![0].name).toBe('test');
    expect(config.llm.providers![0].purpose).toEqual(['chat']);
  });

  it('should reject invalid types', () => {
    expect(() => JanusConfigSchema.parse({
      agent: { maxIterations: 'not a number' },
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
        id: 'family_wt',
        name: 'Tokarzewscy',
        groupChatIds: ['-100987654321'],
      },
    });
    expect(config.family).toBeDefined();
    expect(config.family!.id).toBe('family_wt');
    expect(config.family!.groupChatIds).toEqual(['-100987654321']);
  });

  it('should accept tool policy schema', () => {
    const config = JanusConfigSchema.parse({
      users: [{
        id: 'zuzia',
        name: 'Zuzia',
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
