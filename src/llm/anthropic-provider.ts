import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatResponse, LLMMessage, ToolCall, StreamCallback } from './types.js';
import type { TokenStore } from '../auth/types.js';
import { getAnthropicToken } from '../auth/anthropic-oauth.js';
import * as log from '../utils/logger.js';

/**
 * Anthropic Messages API provider using official SDK.
 * Built-in retry, proper TypeScript types, streaming-ready.
 * Supports both API key and OAuth token authentication.
 */
export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private defaultModel: string;
  private tokenStore?: TokenStore;
  private useOAuth: boolean;

  constructor(config: {
    apiKey?: string;
    authToken?: string;
    defaultModel: string;
    apiBase?: string;
    defaultHeaders?: Record<string, string>;
    tokenStore?: TokenStore;
  }) {
    if (config.authToken) {
      this.client = new Anthropic({
        apiKey: null as unknown as string,
        authToken: config.authToken,
        baseURL: config.apiBase,
        defaultHeaders: config.defaultHeaders,
        maxRetries: 3,
      });
      this.useOAuth = true;
    } else {
      this.client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.apiBase,
        maxRetries: 3,
      });
      this.useOAuth = false;
    }
    this.defaultModel = config.defaultModel;
    this.tokenStore = config.tokenStore;
  }

  private async ensureFreshToken(): Promise<void> {
    if (!this.useOAuth || !this.tokenStore) return;
    const token = await getAnthropicToken(this.tokenStore);
    this.client = new Anthropic({
      apiKey: null as unknown as string,
      authToken: token,
      defaultHeaders: {
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.62',
        'x-app': 'cli',
      },
      maxRetries: 3,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    await this.ensureFreshToken();
    const model = (request.model || this.defaultModel).replace(/^anthropic\//, '');

    log.debug(`LLM [anthropic]: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const systemMsg = request.messages.find(m => m.role === 'system');
    const nonSystemMsgs = request.messages.filter(m => m.role !== 'system');

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages: nonSystemMsgs.map(m => convertMessage(m)),
    };

    // Extended thinking requires temperature=1 and uses a dedicated budget
    if (request.thinking) {
      (params as unknown as Record<string, unknown>).thinking = request.thinking;
      params.temperature = 1;
      // Ensure max_tokens accommodates thinking budget
      params.max_tokens = Math.max(params.max_tokens, request.thinking.budgetTokens + 4096);
    } else {
      params.temperature = request.temperature ?? 0.7;
    }

    if (systemMsg) {
      params.system = [{
        type: 'text' as const,
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' as const },
      }];
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t, i, arr) => {
        const tool: Anthropic.Tool = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        };
        // Cache breakpoint on last tool for prompt caching
        if (i === arr.length - 1) {
          (tool as Anthropic.Tool & { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
        }
        return tool;
      });
    }

    const response = await this.client.messages.create(params);

    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'thinking') {
        thinkingContent += (block as unknown as { thinking: string }).thinking;
      } else if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const finishReason = response.stop_reason === 'tool_use' ? 'tool_calls' as const
      : response.stop_reason === 'max_tokens' ? 'length' as const
      : 'stop' as const;

    log.debug(`LLM [anthropic]: finish=${finishReason}, tool_calls=${toolCalls.length}, tokens=${response.usage.input_tokens + response.usage.output_tokens}`);

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      finishReason,
      ...(thinkingContent ? { thinkingContent } : {}),
    };
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    await this.ensureFreshToken();
    const model = (request.model || this.defaultModel).replace(/^anthropic\//, '');

    log.debug(`LLM [anthropic] stream: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const systemMsg = request.messages.find(m => m.role === 'system');
    const nonSystemMsgs = request.messages.filter(m => m.role !== 'system');

    const params: Anthropic.MessageCreateParams = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      messages: nonSystemMsgs.map(m => convertMessage(m)),
      stream: true,
    };

    if (request.thinking) {
      (params as unknown as Record<string, unknown>).thinking = request.thinking;
      params.temperature = 1;
      params.max_tokens = Math.max(params.max_tokens, request.thinking.budgetTokens + 4096);
    } else {
      params.temperature = request.temperature ?? 0.7;
    }

    if (systemMsg) {
      params.system = [{
        type: 'text' as const,
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' as const },
      }];
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t, i, arr) => {
        const tool: Anthropic.Tool = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        };
        if (i === arr.length - 1) {
          (tool as Anthropic.Tool & { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
        }
        return tool;
      });
    }

    const stream = this.client.messages.stream(params);

    stream.on('text', (delta) => {
      onChunk(delta);
    });

    const finalMessage = await stream.finalMessage();

    let content = '';
    let thinkingContent = '';
    const toolCalls: ToolCall[] = [];

    for (const block of finalMessage.content) {
      if (block.type === 'thinking') {
        thinkingContent += (block as unknown as { thinking: string }).thinking;
      } else if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const finishReason = finalMessage.stop_reason === 'tool_use' ? 'tool_calls' as const
      : finalMessage.stop_reason === 'max_tokens' ? 'length' as const
      : 'stop' as const;

    log.debug(`LLM [anthropic] stream: finish=${finishReason}, tool_calls=${toolCalls.length}`);

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
      },
      finishReason,
      ...(thinkingContent ? { thinkingContent } : {}),
    };
  }
}

function convertMessage(msg: LLMMessage): Anthropic.MessageParam {
  if (msg.role === 'user') {
    return { role: 'user', content: msg.content };
  }

  if (msg.role === 'assistant') {
    const content: Anthropic.ContentBlockParam[] = [];
    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        let input: unknown;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: input as Record<string, unknown>,
        });
      }
    }
    return { role: 'assistant', content };
  }

  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: msg.content,
      }],
    };
  }

  return { role: 'user', content: 'content' in msg ? msg.content : '' };
}
