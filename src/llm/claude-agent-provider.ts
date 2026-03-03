/**
 * Claude Agent SDK provider — uses Claude Code Max subscription via `claude login`.
 *
 * Uses structured output (JSON schema) to enforce tool call format.
 * Collects assistant text from streaming events; handles both success and
 * error_max_turns results.
 */

import type { LLMProvider, ChatRequest, ChatResponse, StreamCallback } from './types.js';
import {
  serializeMessages,
  buildToolCallSchema,
  buildToolSystemPrompt,
  parseStructuredResponse,
} from './sdk-utils.js';
import * as log from '../utils/logger.js';

// Cache SDK import — avoid `await import()` on every call
let queryFn: typeof import('@anthropic-ai/claude-agent-sdk')['query'] | undefined;
async function getQuery() {
  if (!queryFn) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = sdk.query;
  }
  return queryFn;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModel(name: string): string {
  return MODEL_ALIASES[name] ?? name;
}

export class ClaudeAgentProvider implements LLMProvider {
  private defaultModel: string;

  constructor(config: { model: string }) {
    this.defaultModel = resolveModel(config.model);
  }

  private buildOptions(request: ChatRequest) {
    const hasTools = !!request.tools?.length;
    const model = request.model || this.defaultModel;

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

    return { prompt, options, model, hasTools };
  }

  private extractAssistantText(msg: unknown): string {
    const aMsg = msg as { message?: { content?: Array<{ type: string; text?: string }> | string } };
    if (!aMsg.message?.content) return '';
    if (typeof aMsg.message.content === 'string') return aMsg.message.content;
    if (Array.isArray(aMsg.message.content)) {
      return aMsg.message.content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text?: string }) => b.text ?? '')
        .join('');
    }
    return '';
  }

  private buildResponse(resultText: string, sdkUsage: { input_tokens: number; output_tokens: number }, hasTools: boolean): ChatResponse {
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

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const query = await getQuery();
    const { prompt, options, model, hasTools } = this.buildOptions(request);

    log.debug(`LLM [claude-agent]: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const q = query({ prompt, options: options as never });

    let resultText = '';
    let sdkUsage = { input_tokens: 0, output_tokens: 0 };
    let lastAssistantText = '';

    for await (const msg of q) {
      log.debug(`LLM [claude-agent] event: type=${msg.type} subtype=${'subtype' in msg ? msg.subtype : '-'}`);

      if (msg.type === 'assistant') {
        const text = this.extractAssistantText(msg);
        if (text) lastAssistantText = text;
      }

      if (msg.type === 'result') {
        const result = msg as {
          subtype: string;
          structured_output?: unknown;
          result?: string;
          usage?: { input_tokens: number; output_tokens: number };
        };

        if (result.usage) sdkUsage = result.usage;

        if (result.subtype === 'success') {
          resultText = result.structured_output
            ? JSON.stringify(result.structured_output)
            : result.result ?? '';
        } else {
          log.warn(`LLM [claude-agent]: result subtype=${result.subtype}, using last assistant text (len=${lastAssistantText.length})`);
          resultText = result.result ?? lastAssistantText;
        }
      }
    }

    return this.buildResponse(resultText, sdkUsage, hasTools);
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    const query = await getQuery();
    const { prompt, options, model, hasTools } = this.buildOptions(request);

    log.debug(`LLM [claude-agent] stream: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const q = query({ prompt, options: options as never });

    let resultText = '';
    let sdkUsage = { input_tokens: 0, output_tokens: 0 };
    let lastAssistantText = '';

    for await (const msg of q) {
      log.debug(`LLM [claude-agent] stream event: type=${msg.type} subtype=${'subtype' in msg ? msg.subtype : '-'}`);

      if (msg.type === 'stream_event') {
        const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          onChunk(event.delta.text);
        }
      }

      if (msg.type === 'assistant') {
        const text = this.extractAssistantText(msg);
        if (text) lastAssistantText = text;
      }

      if (msg.type === 'result') {
        const result = msg as {
          subtype: string;
          structured_output?: unknown;
          result?: string;
          usage?: { input_tokens: number; output_tokens: number };
        };

        if (result.usage) sdkUsage = result.usage;

        if (result.subtype === 'success') {
          resultText = result.structured_output
            ? JSON.stringify(result.structured_output)
            : result.result ?? '';
        } else {
          log.warn(`LLM [claude-agent] stream: result subtype=${result.subtype}, using last assistant text (len=${lastAssistantText.length})`);
          resultText = result.result ?? lastAssistantText;
        }
      }
    }

    return this.buildResponse(resultText, sdkUsage, hasTools);
  }
}
