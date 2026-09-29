import { describe, it, expect, vi } from 'vitest';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { resolveBudget, resolveTransformSettings, softTrimOldToolResults } from '../../src/context/context-manager.js';
import { JanusConfigSchema } from '../../src/config/schema.js';
import type { LLMMessage, ProviderEntry, ChatResponse } from '../../src/llm/types.js';

const response: ChatResponse = { content: 'ok', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
function entry(name: string, window: number, priority: number): ProviderEntry {
  return { name, providerName: name, model: `${name}-model`, purpose: [], priority,
    contextWindows: { [`${name}-model`]: window }, provider: { chat: vi.fn(async () => response) } };
}
describe('Actual candidate budgets', () => {
  it.each(['chat', 'stream'])('does not send an oversized request to a smaller fallback (%s)', async mode => {
    const registry = new ProviderRegistry();
    const primary = entry('primary', 20_000, 0);
    const fallback = entry('fallback', 2_000, 1);
    vi.mocked(primary.provider.chat).mockRejectedValue(new Error('503 unavailable'));
    registry.register(primary); registry.register(fallback);
    const request = { model: '', maxTokens: 500, messages: [{ role: 'user' as const, content: 'x'.repeat(10_000) }] };
    await expect(mode === 'chat' ? registry.chat(request) : registry.chatStream(request, () => {})).rejects.toThrow(/context/i);
    expect(primary.provider.chat).toHaveBeenCalledOnce();
    expect(fallback.provider.chat).not.toHaveBeenCalled();
  });

  it('uses a smaller fallback when the whole request fits its actual window', async () => {
    const registry = new ProviderRegistry();
    const primary = entry('primary', 20_000, 0);
    const fallback = entry('fallback', 2_000, 1);
    vi.mocked(primary.provider.chat).mockRejectedValue(new Error('503 unavailable'));
    registry.register(primary); registry.register(fallback);
    expect((await registry.chat({ model: '', maxTokens: 500, messages: [{ role: 'user', content: 'hello' }] })).model).toBe('fallback-model');
    expect(fallback.provider.chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'fallback-model', maxTokens: 500 }));
  });

  it('uses the selected model override, pin and actual output reservation', async () => {
    const registry = new ProviderRegistry();
    const primary = entry('primary', 20_000, 0);
    primary.contextWindows!['override'] = 1_000;
    registry.register(primary);
    registry.register(entry('fallback', 2_000, 1));
    expect(registry.getContextBudget({ maxTokens: 500 }).effective).toBe(19_500);
    registry.pin('fallback');
    expect(registry.getContextBudget({ maxTokens: 500 }).effective).toBe(1_500);
    registry.unpin();
    expect(registry.getContextBudget({ model: 'override', maxTokens: 500 }).effective).toBe(500);
    expect(registry.getContextBudget({ maxTokens: 25_000 }).effective).toBe(0);
    expect(registry.getContextBudget({ maxTokens: 500, contextWindow: 5_000 }).effective).toBe(4_500);
  });

  it('uses a conservative unknown-model fallback and never invents extra space', () => {
    const registry = new ProviderRegistry(); registry.register(entry('primary', 20_000, 0));
    expect(registry.getContextBudget({ model: 'unknown', maxTokens: 500 }).contextWindow).toBe(200_000);
    expect(resolveBudget({ modelContextWindow: 1000, reservedForOutput: 2000 }).effective).toBe(0);
  });

  it('retains old config and gives trim options a measurable effect', () => {
    const config = JanusConfigSchema.parse({ agent: { context: { reserveTokens: 999, compactionThresholds: [0.1, 0.2, 0.3], softTrimChars: 100, protectedTailTurns: 0 } } });
    expect(config.agent.context.reserveTokens).toBe(999);
    expect(JanusConfigSchema.parse({ llm: { contextWindows: { synthetic: { small: 16000 } } } }).llm.contextWindows?.synthetic.small).toBe(16000);
    const settings = resolveTransformSettings(config.agent.context);
    const messages: LLMMessage[] = [{ role: 'tool', tool_call_id: 'id', content: 'x'.repeat(1000) }];
    expect(String(softTrimOldToolResults(messages, settings)[0].content).length).toBeLessThan(300);
    expect(softTrimOldToolResults(messages, { ...settings, keepLastAssistants: 3 })).toEqual(messages);
  });
});
