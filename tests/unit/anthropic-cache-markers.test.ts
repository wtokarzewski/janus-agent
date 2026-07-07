import { describe, it, expect } from 'vitest';
import { applyCacheMarkers, applyCacheToPenultimateMessage, trimLastAssistantWhitespace, modelRejectsSamplingParams } from '../../src/llm/anthropic-provider.js';

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

describe('trimLastAssistantWhitespace', () => {
  it('trims trailing newline from string content (summarization prefill case)', () => {
    const messages: any[] = [
      { role: 'user', content: 'summarize' },
      { role: 'assistant', content: '## Goal\n' },
    ];
    trimLastAssistantWhitespace(messages);
    expect(messages[1].content).toBe('## Goal');
  });

  it('trims trailing whitespace from last text block in array content', () => {
    const messages: any[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [
        { type: 'text', text: 'first part' },
        { type: 'text', text: '## Goal\n  ' },
      ] },
    ];
    trimLastAssistantWhitespace(messages);
    expect(messages[1].content[0].text).toBe('first part');
    expect(messages[1].content[1].text).toBe('## Goal');
  });

  it('leaves last message untouched when role is user', () => {
    const messages: any[] = [
      { role: 'assistant', content: 'reply\n' },
      { role: 'user', content: 'follow-up\n' },
    ];
    trimLastAssistantWhitespace(messages);
    expect(messages[1].content).toBe('follow-up\n');
  });

  it('does not trim when last block is tool_use (no text whitespace concern)', () => {
    const messages: any[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [
        { type: 'text', text: 'some text\n' },
        { type: 'tool_use', id: 'x', name: 'foo', input: {} },
      ] },
    ];
    trimLastAssistantWhitespace(messages);
    // Walks back from last block, hits tool_use, returns — text block is preserved as-is
    expect(messages[1].content[0].text).toBe('some text\n');
  });

  it('handles empty messages array', () => {
    const messages: any[] = [];
    trimLastAssistantWhitespace(messages);
    expect(messages.length).toBe(0);
  });

  it('preserves leading whitespace and internal whitespace', () => {
    const messages: any[] = [
      { role: 'assistant', content: '\n## Goal\nbody text   \n\n' },
    ];
    trimLastAssistantWhitespace(messages);
    expect(messages[0].content).toBe('\n## Goal\nbody text');
  });
});

describe('modelRejectsSamplingParams', () => {
  it('flags models that 400 on temperature (Opus 4.7/4.8, Sonnet 5, Fable, Mythos)', () => {
    expect(modelRejectsSamplingParams('claude-opus-4-8')).toBe(true);
    expect(modelRejectsSamplingParams('claude-opus-4-7')).toBe(true);
    expect(modelRejectsSamplingParams('claude-sonnet-5')).toBe(true);
    expect(modelRejectsSamplingParams('claude-fable-5')).toBe(true);
    expect(modelRejectsSamplingParams('claude-mythos-5')).toBe(true);
  });

  it('accepts sampling params on older families (Opus 4.6, Sonnet 4.6, Haiku)', () => {
    expect(modelRejectsSamplingParams('claude-opus-4-6')).toBe(false);
    expect(modelRejectsSamplingParams('claude-sonnet-4-6')).toBe(false);
    expect(modelRejectsSamplingParams('claude-haiku-4-5-20251001')).toBe(false);
  });

  it('strips the anthropic/ provider prefix before matching', () => {
    expect(modelRejectsSamplingParams('anthropic/claude-sonnet-5')).toBe(true);
    expect(modelRejectsSamplingParams('anthropic/claude-sonnet-4-6')).toBe(false);
  });
});

describe('prefill error matching', () => {
  // Documents the regex used in the chat() catch handler so future edits don't break it.
  const PREFILL_ERROR_RE = /assistant message prefill|must end with a user message/i;

  it('matches the canonical prefill rejection', () => {
    expect(PREFILL_ERROR_RE.test('This model does not support assistant message prefill. The conversation must end with a user message.')).toBe(true);
  });

  it('matches the conversation-must-end variant alone', () => {
    expect(PREFILL_ERROR_RE.test('messages: conversation must end with a user message')).toBe(true);
  });

  it('does not match unrelated 400 messages', () => {
    expect(PREFILL_ERROR_RE.test('messages: final assistant content cannot end with trailing whitespace')).toBe(false);
    expect(PREFILL_ERROR_RE.test('Invalid tool_choice value')).toBe(false);
  });
});
