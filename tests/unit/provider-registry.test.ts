import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { ProviderCircuitBreaker } from '../../src/llm/circuit-breaker.js';
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
      providerName: 'test',
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
      providerName: 'low-priority',
      provider: makeMockProvider({ content: 'low' }),
      model: 'm1',
      purpose: [],
      priority: 10,
    });
    registry.register({
      name: 'high-priority',
      providerName: 'high-priority',
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
      providerName: 'chat-only',
      provider: makeMockProvider({ content: 'chat response' }),
      model: 'm1',
      purpose: ['chat'],
      priority: 0,
    });
    registry.register({
      name: 'summarize-only',
      providerName: 'summarize-only',
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
      providerName: 'failing',
      provider: makeMockProvider(undefined, true),
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    registry.register({
      name: 'working',
      providerName: 'working',
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
      providerName: 'fail1',
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
      providerName: 'chat-only',
      provider: makeMockProvider({ content: 'generic' }),
      model: 'm1',
      purpose: ['chat'],
      priority: 0,
    });

    // Request with unknown purpose falls back to all providers
    const response = await registry.chat(baseRequest, 'unknown_purpose');
    expect(response.content).toBe('generic');
  });

  // Typed auth errors DO fail over (see the circuit breaker suite) — an untyped
  // 401 stays on the generic 4xx rule.
  it('should NOT failover on a bare 401 without a typed auth error', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'bad-auth',
      providerName: 'bad-auth',
      provider: {
        async chat() { throw new Error('401 Unauthorized: Invalid API key'); },
      },
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    registry.register({
      name: 'backup',
      providerName: 'backup',
      provider: makeMockProvider({ content: 'should not reach' }),
      model: 'm2',
      purpose: [],
      priority: 1,
    });

    await expect(registry.chat(baseRequest)).rejects.toThrow('401 Unauthorized');
  });

  it('should failover on 503 server error', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'overloaded',
      providerName: 'overloaded',
      provider: {
        async chat() { throw new Error('503 Service Unavailable'); },
      },
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    registry.register({
      name: 'backup',
      providerName: 'backup',
      provider: makeMockProvider({ content: 'backup response' }),
      model: 'm2',
      purpose: [],
      priority: 1,
    });

    const response = await registry.chat(baseRequest);
    expect(response.content).toBe('backup response');
  });

  it('should list registered entries', () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'p1',
      providerName: 'p1',
      provider: makeMockProvider(),
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe('p1');
  });
});

describe('ProviderRegistry — circuit breaker', () => {
  /** Provider that always throws `message`, counting how often it was reached. */
  function makeCountingFailure(message: string) {
    const state = { attempts: 0 };
    const provider: LLMProvider = {
      async chat(): Promise<ChatResponse> {
        state.attempts++;
        throw new Error(message);
      },
    };
    return { provider, state };
  }

  it('fails over on an authentication error (credentials are per-provider)', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'alpha',
      providerName: 'alpha',
      provider: { async chat(): Promise<ChatResponse> { throw new Error('authentication_error: invalid x-api-key'); } },
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    registry.register({
      name: 'beta',
      providerName: 'beta',
      provider: makeMockProvider({ content: 'fallback' }),
      model: 'm2',
      purpose: [],
      priority: 1,
    });

    const response = await registry.chat(baseRequest);
    expect(response.content).toBe('fallback');
  });

  it('fails over when the primary\'s OAuth refresh token has expired', async () => {
    const registry = new ProviderRegistry();
    registry.register({
      name: 'alpha',
      providerName: 'alpha',
      provider: {
        async chat(): Promise<ChatResponse> {
          throw new Error('Token refresh failed (400): {"error": "invalid_grant", "error_description": "Refresh token expired"}');
        },
      },
      model: 'm1',
      purpose: [],
      priority: 0,
    });
    registry.register({
      name: 'beta',
      providerName: 'beta',
      provider: makeMockProvider({ content: 'fallback' }),
      model: 'm2',
      purpose: [],
      priority: 1,
    });

    const response = await registry.chat(baseRequest);
    expect(response.content).toBe('fallback');
  });

  it('stops trying a provider once its breaker opens', async () => {
    const breaker = new ProviderCircuitBreaker({ enabled: true, failureThreshold: 2, cooldownMs: 300_000 });
    const registry = new ProviderRegistry(breaker);
    const failing = makeCountingFailure('503 Service Unavailable');

    registry.register({ name: 'alpha', providerName: 'alpha', provider: failing.provider, model: 'm1', purpose: [], priority: 0 });
    registry.register({ name: 'beta', providerName: 'beta', provider: makeMockProvider({ content: 'fallback' }), model: 'm2', purpose: [], priority: 1 });

    for (let i = 0; i < 4; i++) {
      expect((await registry.chat(baseRequest)).content).toBe('fallback');
    }

    expect(failing.state.attempts).toBe(2);
    expect(breaker.isOpen('alpha')).toBe(true);
  });

  it('demotes a provider across every slot entry that shares it', async () => {
    const breaker = new ProviderCircuitBreaker({ enabled: true, failureThreshold: 1, cooldownMs: 300_000 });
    const registry = new ProviderRegistry(breaker);
    const failing = makeCountingFailure('503 Service Unavailable');
    const background = makeCountingFailure('503 Service Unavailable');

    registry.register({ name: 'alpha', providerName: 'alpha', provider: failing.provider, model: 'm1', purpose: [], priority: 0 });
    registry.register({ name: 'alpha-background', providerName: 'alpha', provider: background.provider, model: 'm1-mini', purpose: ['background'], priority: 0 });
    registry.register({ name: 'beta', providerName: 'beta', provider: makeMockProvider({ content: 'fallback' }), model: 'm2', purpose: [], priority: 1 });

    await registry.chat(baseRequest);                 // default slot trips the breaker
    const alreadyAttempted = background.state.attempts;
    const bg = await registry.chat(baseRequest, 'background');

    // Background traffic must not keep hitting the same unhealthy upstream just
    // because it is registered under a different label.
    expect(bg.content).toBe('fallback');
    expect(background.state.attempts).toBe(alreadyAttempted);
  });

  it('does not count a request-shaped error toward the threshold', async () => {
    const breaker = new ProviderCircuitBreaker({ enabled: true, failureThreshold: 2, cooldownMs: 300_000 });
    const registry = new ProviderRegistry(breaker);
    // Prompt-too-big 429 — fails on any provider, so it must not demote this one.
    const failing = makeCountingFailure('429 rate_limit_error: prompt is too long: 300000 input tokens');

    registry.register({ name: 'alpha', providerName: 'alpha', provider: failing.provider, model: 'm1', purpose: [], priority: 0 });
    registry.register({ name: 'beta', providerName: 'beta', provider: makeMockProvider({ content: 'fallback' }), model: 'm2', purpose: [], priority: 1 });

    for (let i = 0; i < 3; i++) {
      await expect(registry.chat(baseRequest)).rejects.toThrow('input tokens');
    }

    expect(breaker.isOpen('alpha')).toBe(false);
    expect(failing.state.attempts).toBe(3);
  });

  it('resets the failure count after a success', async () => {
    const breaker = new ProviderCircuitBreaker({ enabled: true, failureThreshold: 2, cooldownMs: 300_000 });
    const registry = new ProviderRegistry(breaker);
    let failNext = true;
    const flaky: LLMProvider = {
      async chat(): Promise<ChatResponse> {
        if (failNext) throw new Error('503 Service Unavailable');
        return { content: 'primary', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
      },
    };

    registry.register({ name: 'alpha', providerName: 'alpha', provider: flaky, model: 'm1', purpose: [], priority: 0 });
    registry.register({ name: 'beta', providerName: 'beta', provider: makeMockProvider({ content: 'fallback' }), model: 'm2', purpose: [], priority: 1 });

    await registry.chat(baseRequest);   // failure 1
    failNext = false;
    await registry.chat(baseRequest);   // success clears the counter
    failNext = true;
    await registry.chat(baseRequest);   // failure 1 again — below threshold

    expect(breaker.isOpen('alpha')).toBe(false);
  });

  it('keeps the current ladder behavior when no breaker is configured', async () => {
    const registry = new ProviderRegistry();
    const failing = makeCountingFailure('503 Service Unavailable');

    registry.register({ name: 'alpha', providerName: 'alpha', provider: failing.provider, model: 'm1', purpose: [], priority: 0 });
    registry.register({ name: 'beta', providerName: 'beta', provider: makeMockProvider({ content: 'fallback' }), model: 'm2', purpose: [], priority: 1 });

    for (let i = 0; i < 3; i++) await registry.chat(baseRequest);

    expect(failing.state.attempts).toBe(3);
  });
});

describe('ProviderRegistry — orphan surrogate sanitization (defense-in-depth)', () => {
  it('strips orphan surrogates from message content before dispatch', async () => {
    let captured: ChatRequest | undefined;
    const registry = new ProviderRegistry();
    registry.register({
      name: 'cap',
      providerName: 'cap',
      model: 'm',
      purpose: [],
      priority: 0,
      provider: {
        async chat(req: ChatRequest): Promise<ChatResponse> {
          captured = req;
          return { content: 'ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
        },
      },
    });

    await registry.chat({
      model: 'm',
      messages: [
        { role: 'user', content: 'hello\uD83D' },            // lone HIGH surrogate (split emoji head)
        { role: 'tool', tool_call_id: 't', content: '\uDE00world' }, // lone LOW surrogate (split emoji tail)
      ],
    });

    expect(captured).toBeDefined();
    expect(captured!.messages[0].content).toBe('hello');
    expect(captured!.messages[1].content).toBe('world');
  });

  it('leaves clean content (and valid emoji) untouched', async () => {
    let captured: ChatRequest | undefined;
    const registry = new ProviderRegistry();
    registry.register({
      name: 'cap',
      providerName: 'cap',
      model: 'm',
      purpose: [],
      priority: 0,
      provider: {
        async chat(req: ChatRequest): Promise<ChatResponse> {
          captured = req;
          return { content: 'ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: 'stop' };
        },
      },
    });

    await registry.chat({ model: 'm', messages: [{ role: 'user', content: 'clean 😀 text' }] });
    expect(captured!.messages[0].content).toBe('clean 😀 text');
  });
});
