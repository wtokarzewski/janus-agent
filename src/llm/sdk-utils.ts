/**
 * Shared utilities for subscription SDK providers (Claude Agent SDK, Codex SDK).
 *
 * Both SDKs take a text prompt (not chat messages) and support structured output
 * via JSON schema. These utilities bridge between Janus's chat message format
 * and the SDKs' text-prompt interface.
 */

import type { LLMMessage, ToolDefinition, ChatResponse, ToolCall } from './types.js';
import * as log from '../utils/logger.js';

/**
 * Serialize chat messages into a single text prompt.
 * System messages are excluded (handled separately by each provider).
 */
export function serializeMessages(messages: LLMMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      parts.push(`[User]\n${msg.content}`);
    } else if (msg.role === 'assistant') {
      let text = msg.content;
      if (msg.tool_calls?.length) {
        const calls = msg.tool_calls.map(tc =>
          `<tool_call name="${tc.function.name}">${tc.function.arguments}</tool_call>`
        ).join('\n');
        text = text ? `${text}\n${calls}` : calls;
      }
      parts.push(`[Assistant]\n${text}`);
    } else if (msg.role === 'tool') {
      parts.push(`[Tool Result (${msg.tool_call_id})]\n${msg.content}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Build a JSON schema that enforces structured tool call responses.
 * The model MUST return JSON matching this schema when tools are available.
 */
export function buildToolCallSchema(tools: ToolDefinition[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Text response to the user (can be empty if only making tool calls)',
      },
      tool_calls: {
        type: 'array',
        description: 'Tool calls to execute. Omit or use empty array if no tools needed.',
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              enum: tools.map(t => t.function.name),
              description: 'Tool name to call',
            },
            arguments: {
              type: 'object',
              description: 'Tool arguments as a JSON object',
            },
          },
          required: ['name', 'arguments'],
          additionalProperties: false,
        },
      },
    },
    required: ['content'],
    additionalProperties: false,
  };
}

/**
 * Build a system prompt addition that describes available tools.
 */
export function buildToolSystemPrompt(tools: ToolDefinition[]): string {
  const toolDescriptions = tools.map(t => {
    const params = JSON.stringify(t.function.parameters, null, 2);
    return `### ${t.function.name}\n${t.function.description}\nParameters: ${params}`;
  }).join('\n\n');

  return `# Available Tools\n\nYou have access to the following tools. ` +
    `When you need to use a tool, respond with JSON matching the structured output schema.\n\n${toolDescriptions}`;
}

/**
 * Parse a structured JSON response (from SDK structured output) into ChatResponse.
 * Falls back to plain text if JSON parsing fails.
 */
export function parseStructuredResponse(
  text: string,
  usage: { input_tokens: number; output_tokens: number },
): ChatResponse {
  const base = {
    usage: {
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      totalTokens: usage.input_tokens + usage.output_tokens,
    },
  };

  try {
    const parsed = JSON.parse(text.trim());

    if (parsed.tool_calls?.length) {
      const toolCalls: ToolCall[] = parsed.tool_calls.map(
        (tc: { name: string; arguments: unknown }, i: number) => ({
          id: `sdk-${Date.now()}-${i}`,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        }),
      );
      return {
        ...base,
        content: parsed.content ?? '',
        toolCalls,
        finishReason: 'tool_calls',
      };
    }

    return {
      ...base,
      content: parsed.content ?? text,
      toolCalls: [],
      finishReason: 'stop',
    };
  } catch {
    log.warn('SDK: structured output parse failed, falling back to text');
    return {
      ...base,
      content: text,
      toolCalls: [],
      finishReason: 'stop',
    };
  }
}
