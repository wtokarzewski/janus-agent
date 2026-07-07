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
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-8': 'claude-opus-4-8',
  'sonnet-5': 'claude-sonnet-5',
  'fable-5': 'claude-fable-5',
};

function resolveModel(name: string): string {
  return MODEL_ALIASES[name] ?? name;
}

export class ClaudeAgentProvider implements LLMProvider {
  private defaultModel: string;
  private tokenStore?: import('../auth/types.js').TokenStore;

  constructor(config: { model: string; tokenStore?: import('../auth/types.js').TokenStore }) {
    this.defaultModel = resolveModel(config.model);
    this.tokenStore = config.tokenStore;
  }

  /** Refresh OAuth token in env before each call (if using OAuth). */
  private async ensureFreshToken(): Promise<void> {
    if (!this.tokenStore) return;
    const { getAnthropicToken } = await import('../auth/anthropic-oauth.js');
    const token = await getAnthropicToken(this.tokenStore);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
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
    await this.ensureFreshToken();
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
    await this.ensureFreshToken();
    const query = await getQuery();
    const { prompt, options, model, hasTools } = this.buildOptions(request);

    log.debug(`LLM [claude-agent] stream: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const q = query({ prompt, options: options as never });

    let resultText = '';
    let sdkUsage = { input_tokens: 0, output_tokens: 0 };
    let lastAssistantText = '';

    for await (const msg of q) {
      const msgType = msg.type;
      const msgSubtype = 'subtype' in msg ? msg.subtype : '-';
      log.info(`LLM [claude-agent] event: type=${msgType} subtype=${msgSubtype} keys=${Object.keys(msg).join(',')}`);

      // Stream text chunks to caller
      if (msgType === 'stream_event') {
        const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        log.info(`LLM [claude-agent] stream_event: event.type=${event?.type} delta.type=${event?.delta?.type} text="${event?.delta?.text?.slice(0, 50) ?? ''}"`);
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          onChunk(event.delta.text);
        }
      }

      // Also extract text from assistant messages (SDK may send complete text here instead of stream_events)
      if (msgType === 'assistant') {
        const text = this.extractAssistantText(msg);
        log.info(`LLM [claude-agent] assistant text (${text.length} chars): "${text.slice(0, 100)}"`);
        if (text) {
          // If we haven't streamed anything yet, emit the full text as a chunk
          if (!lastAssistantText && text) {
            onChunk(text);
          }
          lastAssistantText = text;
        }
      }

      if (msgType === 'result') {
        const r = msg as Record<string, unknown>;
        log.info(`LLM [claude-agent] result: subtype=${msgSubtype} result="${String(r.result ?? '').slice(0, 100)}"`);
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
