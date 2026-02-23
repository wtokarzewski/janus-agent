/**
 * Claude Agent SDK provider — uses Claude Code Max subscription via `claude login`.
 *
 * Uses structured output (JSON schema) to enforce tool call format.
 * Single-turn only (maxTurns: 1), no Claude Code built-in tools.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from './types.js';
import {
  serializeMessages,
  buildToolCallSchema,
  buildToolSystemPrompt,
  parseStructuredResponse,
} from './sdk-utils.js';
import * as log from '../utils/logger.js';

export class ClaudeAgentProvider implements LLMProvider {
  private defaultModel: string;

  constructor(config: { model: string }) {
    this.defaultModel = config.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const hasTools = !!request.tools?.length;
    const model = request.model || this.defaultModel;

    log.debug(`LLM [claude-agent]: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const systemParts = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content);
    if (hasTools) {
      systemParts.push(buildToolSystemPrompt(request.tools!));
    }

    const prompt = serializeMessages(request.messages);

    const options: Record<string, unknown> = {
      model,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
    };

    if (systemParts.length) {
      options.systemPrompt = systemParts.join('\n\n');
    }

    if (hasTools) {
      options.outputFormat = {
        type: 'json_schema',
        schema: buildToolCallSchema(request.tools!),
      };
    }

    const q = query({ prompt, options: options as never });

    let resultText = '';
    let sdkUsage = { input_tokens: 0, output_tokens: 0 };

    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        const success = msg as { structured_output?: unknown; result: string; usage: { input_tokens: number; output_tokens: number } };
        resultText = success.structured_output
          ? JSON.stringify(success.structured_output)
          : success.result;
        sdkUsage = success.usage;
      }
    }

    log.debug(`LLM [claude-agent]: tokens=${sdkUsage.input_tokens + sdkUsage.output_tokens}`);

    if (hasTools) {
      return parseStructuredResponse(resultText, sdkUsage);
    }

    return {
      content: resultText,
      toolCalls: [],
      usage: {
        promptTokens: sdkUsage.input_tokens,
        completionTokens: sdkUsage.output_tokens,
        totalTokens: sdkUsage.input_tokens + sdkUsage.output_tokens,
      },
      finishReason: 'stop',
    };
  }
}
