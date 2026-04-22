import { describe, it, expect } from 'vitest';
import { applyCacheMarkers, applyCacheToPenultimateMessage } from '../../src/llm/anthropic-provider.js';

describe('applyCacheMarkers', () => {
  it('marks only last tool when no MCP tools present', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks only last tool when MCP tools present (single marker saves cache budget)', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_search', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_pr', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toBeUndefined();
    expect((tools[2] as any).cache_control).toBeUndefined();
    expect((tools[3] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles single tool', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles empty tools list', () => {
    const tools: any[] = [];
    applyCacheMarkers(tools);
    expect(tools.length).toBe(0);
  });
});

describe('applyCacheToPenultimateMessage', () => {
  it('marks penultimate message when 3+ messages exist', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'user' as const, content: 'question' },
    ];
    applyCacheToPenultimateMessage(messages);
    expect((messages[1] as any).content).toEqual([{
      type: 'text', text: 'hi',
      cache_control: { type: 'ephemeral' },
    }]);
    expect(messages[0].content).toBe('hello');
    expect(messages[2].content).toBe('question');
  });

  it('handles penultimate with array content', () => {
    const messages = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'part1' },
        { type: 'text' as const, text: 'part2' },
      ] },
      { role: 'user' as const, content: 'b' },
    ];
    applyCacheToPenultimateMessage(messages);
    expect((messages[1].content as any)[0].cache_control).toBeUndefined();
    expect((messages[1].content as any)[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('skips when fewer than 3 messages', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    applyCacheToPenultimateMessage(messages);
    expect(messages[1].content).toBe('hi');
  });

  it('skips empty messages array', () => {
    const messages: any[] = [];
    applyCacheToPenultimateMessage(messages);
    expect(messages.length).toBe(0);
  });
});
