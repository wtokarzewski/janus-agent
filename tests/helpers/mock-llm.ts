/**
 * Mock LLM provider for integration tests.
 * Returns canned responses, optionally with tool calls.
 */

import type { LLMProvider, ChatRequest, ChatResponse, ToolCall, StreamCallback } from '../../src/llm/types.js';

export interface MockResponse {
  content: string;
  toolCalls?: ToolCall[];
}

export class MockProvider implements LLMProvider {
  private responses: MockResponse[];
  private callIndex = 0;
  calls: ChatRequest[] = [];
  streamCalls: ChatRequest[] = [];

  constructor(responses: MockResponse[]) {
    this.responses = responses;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);

    const response = this.responses[this.callIndex] ?? {
      content: 'No more canned responses',
      toolCalls: [],
    };
    this.callIndex++;

    return {
      content: response.content,
      toolCalls: response.toolCalls ?? [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: (response.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
    };
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    this.streamCalls.push(request);

    const response = this.responses[this.callIndex] ?? {
      content: 'No more canned responses',
      toolCalls: [],
    };
    this.callIndex++;

    // Simulate streaming by emitting content word by word
    const words = response.content.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = i === 0 ? words[i] : ' ' + words[i];
      onChunk(chunk);
    }

    return {
      content: response.content,
      toolCalls: response.toolCalls ?? [],
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: (response.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
    };
  }
}
