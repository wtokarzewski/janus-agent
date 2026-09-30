import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import type { ChatRequest, ProviderEntry } from '../../src/llm/types.js';

const sdk = vi.hoisted(() => {
  const response = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  return { create: vi.fn(async (_params: Record<string, unknown>) => response), stream: vi.fn((_params: Record<string, unknown>) => ({ on: vi.fn(), finalMessage: async (_params: Record<string, unknown>) => response })) };
});
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = sdk; } }));
function setup(window = 20_000, limit?: number) {
  const provider = new AnthropicProvider({ apiKey: 'synthetic', defaultModel: 'test-model' });
  const registry = new ProviderRegistry();
  registry.register({ name: 'anthropic', providerName: 'anthropic', provider, model: 'test-model', purpose: [], priority: 0,
    contextWindows: { 'test-model': window }, outputLimits: limit ? { 'test-model': limit } : undefined } as ProviderEntry);
  return { registry, provider };
}
const request: ChatRequest = { model: '', messages: [{ role: 'user', content: 'hello' }], maxTokens: 8_000,
  thinking: { type: 'enabled', budgetTokens: 2_048 } };

describe('Thinking output budgets', () => {
  it.each(['chat', 'stream'])('reserves the same total that reaches the SDK (%s)', async mode => {
    const { registry } = setup();
    const budget = registry.getContextBudget(request);
    await (mode === 'chat' ? registry.chat(request) : registry.chatStream(request, () => {}));
    const params = (mode === 'chat' ? sdk.create : sdk.stream).mock.lastCall?.[0];
    expect(params).toMatchObject({ max_tokens: 10_048, thinking: { type: 'enabled', budget_tokens: 2_048 } });
    expect(budget.reservedForOutput).toBe(10_048);
    expect(request.maxTokens).toBe(8_000);
  });
  it('fits thinking inside the model output limit and preserves output headroom', async () => {
    const { registry } = setup(20_000, 4_096);
    await registry.chat({ ...request, thinking: { type: 'enabled', budgetTokens: 8_192 } });
    expect(sdk.create.mock.lastCall?.[0]).toMatchObject({ max_tokens: 4_096, thinking: { budget_tokens: 3_072 } });
  });
  it('disables thinking consistently when the model cap cannot accommodate it', async () => {
    const { registry } = setup(20_000, 1_024);
    await registry.chat(request);
    expect(sdk.create.mock.lastCall?.[0]).toMatchObject({ max_tokens: 1_024 });
    expect(sdk.create.mock.lastCall?.[0]).not.toHaveProperty('thinking');
  });
  it.each(['chat', 'stream'])('skips a thinking request that exceeds a candidate window (%s)', async mode => {
    sdk.create.mockClear(); sdk.stream.mockClear();
    const { registry } = setup(9_000);
    registry.register({ name: 'fallback', providerName: 'fallback', model: 'plain', priority: 1, purpose: [],
      contextWindows: { plain: 9_000 }, provider: { chat: vi.fn(async () => ({ content: 'fallback', toolCalls: [], finishReason: 'stop' as const, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })) } });
    const result = await (mode === 'chat' ? registry.chat(request) : registry.chatStream(request, () => {}));
    expect(result.content).toBe('fallback');
    expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.stream).not.toHaveBeenCalled();
  });
});
