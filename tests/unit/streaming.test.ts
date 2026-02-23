/**
 * Unit tests for streaming functionality.
 */

import { describe, it, expect } from 'vitest';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { MockProvider } from '../helpers/mock-llm.js';
import type { LLMProvider, ChatResponse } from '../../src/llm/types.js';

describe('Streaming', () => {
  it('should stream chunks via chatStream callback', async () => {
    const mock = new MockProvider([
      { content: 'Hello world from streaming' },
    ]);

    const chunks: string[] = [];
    const result = await mock.chatStream(
      { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
      (chunk) => chunks.push(chunk),
    );

    expect(result.content).toBe('Hello world from streaming');
    expect(chunks.join('')).toBe('Hello world from streaming');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should accumulate full response from stream', async () => {
    const mock = new MockProvider([
      { content: 'Complete response text' },
    ]);

    const result = await mock.chatStream(
      { model: 'test', messages: [{ role: 'user', content: 'test' }] },
      () => {},
    );

    expect(result.content).toBe('Complete response text');
    expect(result.usage.totalTokens).toBe(150);
    expect(result.finishReason).toBe('stop');
  });

  describe('ProviderRegistry.chatStream', () => {
    it('should use provider chatStream when available', async () => {
      const mock = new MockProvider([{ content: 'streamed' }]);
      const registry = new ProviderRegistry();
      registry.register({ name: 'mock', provider: mock, model: 'test', purpose: [], priority: 0 });

      const chunks: string[] = [];
      const result = await registry.chatStream(
        { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
        (chunk) => chunks.push(chunk),
      );

      expect(result.content).toBe('streamed');
      expect(chunks.length).toBeGreaterThan(0);
      expect(mock.streamCalls).toHaveLength(1);
    });

    it('should fallback to chat() when chatStream not available', async () => {
      // Provider without chatStream
      const provider: LLMProvider = {
        async chat(): Promise<ChatResponse> {
          return {
            content: 'non-streamed fallback',
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            finishReason: 'stop',
          };
        },
      };

      const registry = new ProviderRegistry();
      registry.register({ name: 'basic', provider, model: 'test', purpose: [], priority: 0 });

      const chunks: string[] = [];
      const result = await registry.chatStream(
        { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
        (chunk) => chunks.push(chunk),
      );

      expect(result.content).toBe('non-streamed fallback');
      expect(chunks).toEqual(['non-streamed fallback']);
    });

    it('should failover streaming to next provider', async () => {
      const failProvider: LLMProvider = {
        async chat(): Promise<ChatResponse> { throw new Error('fail'); },
        async chatStream(): Promise<ChatResponse> { throw new Error('stream fail'); },
      };
      const goodMock = new MockProvider([{ content: 'recovered' }]);

      const registry = new ProviderRegistry();
      registry.register({ name: 'fail', provider: failProvider, model: 'test', purpose: [], priority: 0 });
      registry.register({ name: 'good', provider: goodMock, model: 'test', purpose: [], priority: 1 });

      const chunks: string[] = [];
      const result = await registry.chatStream(
        { model: 'test', messages: [{ role: 'user', content: 'hi' }] },
        (chunk) => chunks.push(chunk),
      );

      expect(result.content).toBe('recovered');
    });
  });
});
