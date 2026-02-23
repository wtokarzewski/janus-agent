import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import type { LLMProvider, ChatRequest, ChatResponse } from '../../src/llm/types.js';

function makeMockProvider(response?: Partial<ChatResponse>, shouldFail = false): LLMProvider {
  return {
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      if (shouldFail) throw new Error('Provider failed');
      return {
        content: 'test response',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        finishReason: 'stop',
        ...response,
      };
    },
  };
}

const baseRequest: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('ProviderRegistry', () => {
  it('should register and use a provider', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'test',
      provider: makeMockProvider({ content: 'hello back' }),
      model: 'test-model',
      purpose: [],
      priority: 0,
    });

    const response = await registry.chat(baseRequest);
    expect(response.content).toBe('hello back');
  });

  it('should sort by priority (lower = higher priority)', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'low-priority',
      provider: makeMockProvider({ content: 'low' }),
      model: 'm1',
      purpose: [],
      priority: 10,
    });
    registry.register({
      name: 'high-priority',
      provider: makeMockProvider({ content: 'high' }),
      model: 'm2',
      purpose: [],
      priority: 1,
    });

    const response = await registry.chat(baseRequest);
    expect(response.content).toBe('high');
  });

  it('should route by purpose', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'chat-only',
      provider: makeMockProvider({ content: 'chat response' }),
      model: 'm1',
      purpose: ['chat'],
      priority: 0,
    });
    registry.register({
      name: 'summarize-only',
      provider: makeMockProvider({ content: 'summary response' }),
      model: 'm2',
      purpose: ['summarize'],
      priority: 0,
    });

    const chatResp = await registry.chat(baseRequest, 'chat');
    expect(chatResp.content).toBe('chat response');

    const summaryResp = await registry.chat(baseRequest, 'summarize');
    expect(summaryResp.content).toBe('summary response');
  });

  it('should failover to next provider on error', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'failing',
      provider: makeMockProvider(undefined, true),
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    registry.register({
      name: 'working',
      provider: makeMockProvider({ content: 'fallback' }),
      model: 'm2',
      purpose: [],
      priority: 1,
    });

    const response = await registry.chat(baseRequest);
    expect(response.content).toBe('fallback');
  });

  it('should throw when no providers registered', async () => {
    const registry = new ProviderRegistry();
    await expect(registry.chat(baseRequest)).rejects.toThrow('No providers available');
  });

  it('should throw when all providers fail', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'fail1',
      provider: makeMockProvider(undefined, true),
      model: 'm1',
      purpose: [],
      priority: 0,
    });

    await expect(registry.chat(baseRequest)).rejects.toThrow('Provider failed');
  });

  it('should fall back to all providers when purpose has no match', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'chat-only',
      provider: makeMockProvider({ content: 'generic' }),
      model: 'm1',
      purpose: ['chat'],
      priority: 0,
    });

    // Request with unknown purpose falls back to all providers
    const response = await registry.chat(baseRequest, 'unknown_purpose');
    expect(response.content).toBe('generic');
  });

  it('should list registered entries', () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'p1',
      provider: makeMockProvider(),
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe('p1');
  });
});
