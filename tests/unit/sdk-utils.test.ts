import { describe, it, expect } from 'vitest';
import {
  serializeMessages,
  buildToolCallSchema,
  buildToolSystemPrompt,
  parseStructuredResponse,
} from '../../src/llm/sdk-utils.js';
import type { LLMMessage, ToolDefinition } from '../../src/llm/types.js';

const sampleTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec',
      description: 'Execute a command',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
];

describe('serializeMessages', () => {
  it('serializes user and assistant messages', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'Read file.txt' },
    ];

    const result = serializeMessages(messages);
    expect(result).toContain('[User]\nHello');
    expect(result).toContain('[Assistant]\nHi there');
    expect(result).toContain('[User]\nRead file.txt');
  });

  it('skips system messages', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are an agent' },
      { role: 'user', content: 'Hello' },
    ];

    const result = serializeMessages(messages);
    expect(result).not.toContain('system');
    expect(result).not.toContain('You are an agent');
    expect(result).toContain('[User]\nHello');
  });

  it('includes tool calls in assistant messages', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: 'Let me read that file.',
        tool_calls: [{
          id: 'tc-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"test.txt"}' },
        }],
      },
    ];

    const result = serializeMessages(messages);
    expect(result).toContain('read_file');
    expect(result).toContain('tool_call');
    expect(result).toContain('Let me read that file.');
  });

  it('includes tool results', () => {
    const messages: LLMMessage[] = [
      { role: 'tool', tool_call_id: 'tc-1', content: 'file contents here' },
    ];

    const result = serializeMessages(messages);
    expect(result).toContain('[Tool Result (tc-1)]');
    expect(result).toContain('file contents here');
  });
});

describe('buildToolCallSchema', () => {
  it('creates a valid JSON schema with tool names', () => {
    const schema = buildToolCallSchema(sampleTools);

    expect(schema.type).toBe('object');
    expect(schema.required).toContain('content');

    const props = schema.properties as Record<string, unknown>;
    expect(props.content).toBeDefined();
    expect(props.tool_calls).toBeDefined();

    const toolCallsSchema = props.tool_calls as Record<string, unknown>;
    expect(toolCallsSchema.type).toBe('array');

    const items = toolCallsSchema.items as Record<string, unknown>;
    const nameSchema = (items.properties as Record<string, unknown>).name as Record<string, unknown>;
    expect(nameSchema.enum).toEqual(['read_file', 'exec']);
  });
});

describe('buildToolSystemPrompt', () => {
  it('lists available tools', () => {
    const prompt = buildToolSystemPrompt(sampleTools);

    expect(prompt).toContain('# Available Tools');
    expect(prompt).toContain('### read_file');
    expect(prompt).toContain('Read a file');
    expect(prompt).toContain('### exec');
    expect(prompt).toContain('Execute a command');
  });
});

describe('parseStructuredResponse', () => {
  const usage = { input_tokens: 100, output_tokens: 50 };

  it('parses response with tool calls', () => {
    const json = JSON.stringify({
      content: 'Reading the file...',
      tool_calls: [
        { name: 'read_file', arguments: { path: 'test.txt' } },
      ],
    });

    const response = parseStructuredResponse(json, usage);

    expect(response.content).toBe('Reading the file...');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(response.toolCalls[0].function.arguments)).toEqual({ path: 'test.txt' });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.usage.promptTokens).toBe(100);
    expect(response.usage.completionTokens).toBe(50);
  });

  it('parses response without tool calls', () => {
    const json = JSON.stringify({
      content: 'Here is the answer.',
      tool_calls: [],
    });

    const response = parseStructuredResponse(json, usage);

    expect(response.content).toBe('Here is the answer.');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
  });

  it('parses response with only content', () => {
    const json = JSON.stringify({ content: 'Just text.' });

    const response = parseStructuredResponse(json, usage);

    expect(response.content).toBe('Just text.');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
  });

  it('falls back to plain text on invalid JSON', () => {
    const response = parseStructuredResponse('This is not JSON', usage);

    expect(response.content).toBe('This is not JSON');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
  });

  it('handles empty content with tool calls', () => {
    const json = JSON.stringify({
      content: '',
      tool_calls: [
        { name: 'exec', arguments: { command: 'ls' } },
      ],
    });

    const response = parseStructuredResponse(json, usage);

    expect(response.content).toBe('');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.finishReason).toBe('tool_calls');
  });

  it('generates unique tool call IDs', () => {
    const json = JSON.stringify({
      content: '',
      tool_calls: [
        { name: 'read_file', arguments: { path: 'a.txt' } },
        { name: 'read_file', arguments: { path: 'b.txt' } },
      ],
    });

    const response = parseStructuredResponse(json, usage);

    expect(response.toolCalls).toHaveLength(2);
    expect(response.toolCalls[0].id).not.toBe(response.toolCalls[1].id);
    expect(response.toolCalls[0].type).toBe('function');
    expect(response.toolCalls[1].type).toBe('function');
  });
});
