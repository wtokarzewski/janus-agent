import { describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { JanusConfigSchema } from '../../src/config/schema.js';
import type { ChatRequest, ChatResponse, ProviderEntry } from '../../src/llm/types.js';

const sdk = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = sdk; } }));
const answer: ChatResponse = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
const wireAnswer = { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
function setup(window = 30_000, outputCap?: number) {
  sdk.create.mockReset().mockResolvedValue(wireAnswer);
  sdk.stream.mockReset().mockImplementation(() => ({ on: vi.fn(), finalMessage: async () => wireAnswer }));
  const registry = new ProviderRegistry();
  const provider = new AnthropicProvider({ apiKey: 'synthetic', defaultModel: 'test' });
  const entry: ProviderEntry = { name: 'a', providerName: 'a', provider, model: 'test', priority: 0, purpose: [],
    contextWindows: { test: window }, maxOutputTokens: outputCap ? { test: outputCap } : undefined };
  registry.register(entry);
  return { registry, provider };
}
const request: ChatRequest = { model: '', messages: [{ role: 'user', content: 'hello' }], maxTokens: 4096, thinking: { type: 'enabled', budgetTokens: 8192 } };

describe('Request output allowance', () => {
  it.each(['chat', 'stream'])('reserves exactly the output sent to the SDK (%s)', async mode => {
    const { registry } = setup();
    const budget = registry.getContextBudget(request);
    await (mode === 'chat' ? registry.chat(request) : registry.chatStream(request, () => {}));
    const params = (mode === 'chat' ? sdk.create : sdk.stream).mock.calls[0][0];
    expect(budget.reservedForOutput).toBe(12_288);
    expect(params.max_tokens).toBe(budget.reservedForOutput);
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(params.temperature).toBe(1);
  });

  it.each(['chat', 'stream'])('skips a thinking candidate whose full allowance leaves no prompt space (%s)', async mode => {
    const { registry } = setup(10_000);
    const fallback = vi.fn(async () => answer);
    registry.register({ name: 'plain', providerName: 'plain', model: 'other', provider: { chat: fallback }, purpose: [], priority: 1, contextWindows: { other: 10_000 } });
    expect(registry.getContextBudget(request).reservedForOutput).toBe(4096);
    const result = await (mode === 'chat' ? registry.chat(request) : registry.chatStream(request, () => {}));
    expect(result.provider).toBe('plain');
    expect(sdk.create).not.toHaveBeenCalled();
    expect(sdk.stream).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }));
  });

  it('preserves an already larger allowance without repeatedly expanding it', async () => {
    const { registry } = setup();
    const large = { ...request, maxTokens: 20_000 };
    const budget = registry.getContextBudget(large);
    await registry.chat(large);
    expect(budget.reservedForOutput).toBe(20_000);
    expect(sdk.create.mock.calls[0][0].max_tokens).toBe(20_000);
  });

  it('rejects a declared output cap without silently reducing the requested thinking', async () => {
    const { registry } = setup(30_000, 8_000);
    expect(registry.getContextBudget(request).effective).toBe(0);
    await expect(registry.chat(request)).rejects.toThrow(/budget/i);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('applies output limits to the actual overridden model and keeps non-thinking defaults', async () => {
    const { registry } = setup();
    registry.get('a')!.maxOutputTokens = { restricted: 2_000 };
    expect(registry.getContextBudget({ model: 'restricted', maxTokens: 4096 }).effective).toBe(0);
    await registry.chat({ ...request, thinking: undefined, maxTokens: 777 });
    expect(sdk.create.mock.calls[0][0]).toMatchObject({ max_tokens: 777 });
    expect(sdk.create.mock.calls[0][0].thinking).toBeUndefined();
  });

  it('loads explicit per-provider output caps without inventing model capabilities', () => {
    const config = JanusConfigSchema.parse({ llm: { maxOutputTokens: { a: { test: 12_288 } } } });
    expect(config.llm.maxOutputTokens).toEqual({ a: { test: 12_288 } });
  });
});
