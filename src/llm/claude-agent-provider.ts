/**
 * Claude Agent SDK provider — uses Claude Code Max subscription via `claude login`.
 *
 * Uses structured output (JSON schema) to enforce tool call format.
 * Collects assistant text from streaming events; handles both success and
 * error_max_turns results.
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
      maxTurns: 3,
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
    let lastAssistantText = '';

    for await (const msg of q) {
      log.debug(`LLM [claude-agent] event: type=${msg.type} subtype=${'subtype' in msg ? msg.subtype : '-'}`);

      // Capture assistant message text as fallback
      if (msg.type === 'assistant') {
        const aMsg = msg as { message?: { content?: Array<{ type: string; text?: string }> | string } };
        if (aMsg.message?.content) {
          if (typeof aMsg.message.content === 'string') {
            lastAssistantText = aMsg.message.content;
          } else if (Array.isArray(aMsg.message.content)) {
            const textParts = aMsg.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { text?: string }) => b.text ?? '');
            if (textParts.length) {
              lastAssistantText = textParts.join('');
            }
          }
        }
      }

      if (msg.type === 'result') {
        const result = msg as {
          subtype: string;
          structured_output?: unknown;
          result?: string;
          usage?: { input_tokens: number; output_tokens: number };
        };

        if (result.usage) {
          sdkUsage = result.usage;
        }

        if (result.subtype === 'success') {
          resultText = result.structured_output
            ? JSON.stringify(result.structured_output)
            : result.result ?? '';
        } else {
          // error_max_turns or other error — use whatever text we collected
          log.warn(`LLM [claude-agent]: result subtype=${result.subtype}, using last assistant text (len=${lastAssistantText.length})`);
          resultText = result.result ?? lastAssistantText;
        }
      }
    }

    log.debug(`LLM [claude-agent]: tokens=${sdkUsage.input_tokens + sdkUsage.output_tokens}, resultLen=${resultText.length}`);

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
