import OpenAI from 'openai';
import type { LLMProvider, ChatRequest, ChatResponse, ToolCall, StreamCallback } from './types.js';
import { AnthropicProvider } from './anthropic-provider.js';
import * as log from '../utils/logger.js';

const PROVIDER_DEFAULTS: Record<string, { apiBase: string; extraHeaders?: Record<string, string> }> = {
  openrouter: {
    apiBase: 'https://openrouter.ai/api/v1',
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/wtokarzewski/janus-agent',
      'X-Title': 'Janus AI Agent',
    },
  },
  openai: {
    apiBase: 'https://api.openai.com/v1',
  },
  deepseek: {
    apiBase: 'https://api.deepseek.com/v1',
  },
  groq: {
    apiBase: 'https://api.groq.com/openai/v1',
  },
};

/**
 * OpenAI-compatible provider using official OpenAI SDK.
 * Works with OpenRouter, OpenAI, DeepSeek, Groq, and any OpenAI-compatible API.
 * Built-in retry, proper TypeScript types, streaming-ready.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  private defaultModel: string;
  private name: string;

  constructor(config: {
    apiKey: string;
    defaultModel: string;
    apiBase: string;
    extraHeaders?: Record<string, string>;
    name: string;
  }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.apiBase,
      defaultHeaders: config.extraHeaders,
      maxRetries: 3,
    });
    this.defaultModel = config.defaultModel;
    this.name = config.name;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;

    log.debug(`LLM [${this.name}]: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const params: OpenAI.ChatCompletionCreateParams = {
      model,
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools as OpenAI.ChatCompletionTool[];
    }

    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    if (!choice) {
      throw new Error(`No choices in ${this.name} response`);
    }

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
      .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
      .map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

    const finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls'
      : choice.finish_reason === 'length' ? 'length'
      : 'stop';

    log.debug(`LLM [${this.name}]: finish=${finishReason}, tool_calls=${toolCalls.length}, tokens=${response.usage?.total_tokens ?? '?'}`);

    return {
      content: choice.message.content ?? '',
      toolCalls,
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      finishReason,
    };
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;

    log.debug(`LLM [${this.name}] stream: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const params: OpenAI.ChatCompletionCreateParams = {
      model,
      messages: request.messages as OpenAI.ChatCompletionMessageParam[],
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
    };

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools as OpenAI.ChatCompletionTool[];
    }

    const stream = await this.client.chat.completions.create(params);

    let content = '';
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.delta?.content) {
        content += choice.delta.content;
        onChunk(choice.delta.content);
      }

      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallsMap.get(tc.index);
          if (existing) {
            existing.args += tc.function?.arguments ?? '';
          } else {
            toolCallsMap.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason === 'tool_calls' ? 'tool_calls'
          : choice.finish_reason === 'length' ? 'length'
          : 'stop';
      }

      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));

    log.debug(`LLM [${this.name}] stream: finish=${finishReason}, tool_calls=${toolCalls.length}`);

    return {
      content,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason,
    };
  }
}

/**
 * Create the right provider based on config.
 * Async to support lazy-loading SDK providers.
 */
export async function createProvider(opts: {
  provider: string;
  apiKey: string;
  model: string;
  apiBase?: string;
}): Promise<LLMProvider> {
  const providerName = opts.provider;

  if (providerName === 'claude-agent') {
    const { ClaudeAgentProvider } = await import('./claude-agent-provider.js');
    return new ClaudeAgentProvider({ model: opts.model });
  }

  if (providerName === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider({ model: opts.model });
  }

  if (providerName === 'anthropic') {
    const model = opts.model.replace(/^anthropic\//, '');
    return new AnthropicProvider({
      apiKey: opts.apiKey,
      defaultModel: model,
      apiBase: opts.apiBase,
    });
  }

  const defaults = PROVIDER_DEFAULTS[providerName];
  const apiBase = opts.apiBase ?? defaults?.apiBase;

  if (!apiBase) {
    throw new Error(
      `Unknown provider "${providerName}". Supported: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}, claude-agent, codex. ` +
      `Or set llm.apiBase in janus.json for a custom OpenAI-compatible endpoint.`
    );
  }

  return new OpenAICompatibleProvider({
    apiKey: opts.apiKey,
    defaultModel: opts.model,
    apiBase,
    extraHeaders: defaults?.extraHeaders,
    name: providerName,
  });
}
