import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatResponse, LLMMessage, ToolCall, StreamCallback } from './types.js';
import type { TokenStore } from '../auth/types.js';
import { getAnthropicToken } from '../auth/anthropic-oauth.js';
import * as log from '../utils/logger.js';

/**
 * Apply prompt cache marker to last tool definition.
 * Single marker conserves Anthropic's 4-breakpoint budget
 * (system + tool + penultimate msg + last msg).
 */
export function applyCacheMarkers(tools: Array<{ name: string; cache_control?: unknown }>): void {
  if (tools.length === 0) return;
  tools[tools.length - 1].cache_control = { type: 'ephemeral' };
}

/**
 * Anthropic rejects trailing whitespace in the final assistant message
 * (400: "messages: final assistant content cannot end with trailing whitespace").
 * Strip it from the last text block of the last message if it's an assistant turn.
 * This makes prefills like `## Goal\n` safe to use without per-call-site trimming.
 */
export function trimLastAssistantWhitespace(messages: Anthropic.MessageParam[]): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.role !== 'assistant') return;
  if (typeof last.content === 'string') {
    last.content = last.content.replace(/\s+$/, '');
    return;
  }
  if (!Array.isArray(last.content)) return;
  for (let i = last.content.length - 1; i >= 0; i--) {
    const block = last.content[i] as { type: string; text?: string };
    if (block.type === 'text' && typeof block.text === 'string') {
      block.text = block.text.replace(/\s+$/, '');
      return;
    }
    if (block.type === 'tool_use') return;
  }
}

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
        timeout: 2 * 60 * 1000, // 2 min per request (default 10 min is too long)
      });
      this.useOAuth = true;
    } else {
      this.client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.apiBase,
        maxRetries: 3,
        timeout: 2 * 60 * 1000,
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
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
        'user-agent': 'claude-cli/2.1.104',
        'x-app': 'cli',
      },
      maxRetries: 3,
      timeout: 2 * 60 * 1000,
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

    // System blocks — OAuth must be separate block (API requirement), no cache marker
    // to stay within 4-breakpoint limit. OAuth is cached as prefix of staticPart's marker.
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    if (this.useOAuth) {
      systemBlocks.push({
        type: 'text' as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      });
    }
    if (request.systemParts) {
      systemBlocks.push({
        type: 'text' as const,
        text: request.systemParts.staticPart,
        cache_control: { type: 'ephemeral' as const },
      });
      // dynamicPart is injected into user message by agent-loop (not in system blocks)
    } else if (systemMsg) {
      // Fallback for non-split callers (flush, summarization use system message directly)
      systemBlocks.push({
        type: 'text' as const,
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' as const },
      });
    }
    if (systemBlocks.length > 0) {
      params.system = systemBlocks;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t) => {
        const tool: Anthropic.Tool = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        };
        return tool;
      });
      applyCacheMarkers(params.tools);
      // Tool choice with fallback (L14)
      if (request.toolChoice === 'required') {
        params.tool_choice = { type: 'any' };
      } else if (request.toolChoice === 'none') {
        // Remove tools instead — Anthropic doesn't support tool_choice: none
        delete params.tools;
      } else if (request.toolChoice) {
        params.tool_choice = { type: request.toolChoice };
      }
    }

    // Cache conversation history prefix by marking last user message
    applyCacheToLastUserMessage(params.messages);
    applyCacheToPenultimateMessage(params.messages);
    trimLastAssistantWhitespace(params.messages);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      // Fallback: if tool_choice rejected, retry without it (L14)
      if (params.tool_choice && err instanceof Error && /tool_choice|tool choice/i.test(err.message)) {
        log.warn(`Anthropic: tool_choice rejected, retrying without it`);
        delete params.tool_choice;
        response = await this.client.messages.create(params);
      } else if (
        err instanceof Error
        && /assistant message prefill|must end with a user message/i.test(err.message)
        && params.messages.length > 0
        && params.messages[params.messages.length - 1].role === 'assistant'
      ) {
        // Some Anthropic configurations (notably Claude Code OAuth on certain models)
        // refuse trailing assistant prefills. Drop the prefill and retry — callers
        // that depend on the prefill text (e.g. summarization) prepend it back themselves.
        log.warn(`Anthropic: assistant prefill rejected, retrying without it`);
        params.messages = params.messages.slice(0, -1);
        response = await this.client.messages.create(params);
      } else {
        throw err;
      }
    }

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

    const cacheUsage = response.usage as unknown as Record<string, unknown>;
    const cacheRead = typeof cacheUsage.cache_read_input_tokens === 'number' ? cacheUsage.cache_read_input_tokens as number : undefined;
    const cacheWrite = typeof cacheUsage.cache_creation_input_tokens === 'number' ? cacheUsage.cache_creation_input_tokens as number : undefined;
    log.debug(`LLM [anthropic]: finish=${finishReason}, tool_calls=${toolCalls.length}, tokens=${response.usage.input_tokens + response.usage.output_tokens}${cacheRead ? `, cache_read=${cacheRead}` : ''}${cacheWrite ? `, cache_write=${cacheWrite}` : ''}`);

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
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

    // System blocks — OAuth must be separate block (API requirement), no cache marker
    const streamSystemBlocks: Anthropic.TextBlockParam[] = [];
    if (this.useOAuth) {
      streamSystemBlocks.push({
        type: 'text' as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      });
    }
    if (request.systemParts) {
      streamSystemBlocks.push({
        type: 'text' as const,
        text: request.systemParts.staticPart,
        cache_control: { type: 'ephemeral' as const },
      });
    } else if (systemMsg) {
      streamSystemBlocks.push({
        type: 'text' as const,
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' as const },
      });
    }
    if (streamSystemBlocks.length > 0) {
      params.system = streamSystemBlocks;
    }

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((t) => {
        const tool: Anthropic.Tool = {
          name: t.function.name,
          description: t.function.description ?? '',
          input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
        };
        return tool;
      });
      applyCacheMarkers(params.tools);
    }

    // Cache conversation history prefix by marking last user message
    applyCacheToLastUserMessage(params.messages);
    applyCacheToPenultimateMessage(params.messages);
    trimLastAssistantWhitespace(params.messages);

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

    const streamCacheUsage = finalMessage.usage as unknown as Record<string, unknown>;
    const streamCacheRead = typeof streamCacheUsage.cache_read_input_tokens === 'number' ? streamCacheUsage.cache_read_input_tokens as number : undefined;
    const streamCacheWrite = typeof streamCacheUsage.cache_creation_input_tokens === 'number' ? streamCacheUsage.cache_creation_input_tokens as number : undefined;
    log.debug(`LLM [anthropic] stream: finish=${finishReason}, tool_calls=${toolCalls.length}${streamCacheRead ? `, cache_read=${streamCacheRead}` : ''}${streamCacheWrite ? `, cache_write=${streamCacheWrite}` : ''}`);

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
        ...(streamCacheRead != null ? { cacheReadTokens: streamCacheRead } : {}),
        ...(streamCacheWrite != null ? { cacheWriteTokens: streamCacheWrite } : {}),
      },
      finishReason,
      ...(thinkingContent ? { thinkingContent } : {}),
    };
  }
}

function convertMessage(msg: LLMMessage): Anthropic.MessageParam {
  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content };
    }
    // Multimodal user content (text + images)
    const content: Anthropic.ContentBlockParam[] = msg.content.map(block =>
      block.type === 'image'
        ? { type: 'image' as const, source: { type: 'base64' as const, media_type: block.source.media_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: block.source.data } }
        : { type: 'text' as const, text: block.text },
    );
    return { role: 'user', content };
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
    // Support multimodal tool results (text + images)
    const content = Array.isArray(msg.content)
      ? msg.content.map(block =>
          block.type === 'image'
            ? { type: 'image' as const, source: { type: 'base64' as const, media_type: block.source.media_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: block.source.data } }
            : { type: 'text' as const, text: block.text })
      : msg.content;
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content,
      }],
    };
  }

  return { role: 'user', content: 'content' in msg ? msg.content : '' };
}

/**
 * Add cache_control to the penultimate message to cache conversation history prefix.
 * Between requests, the previous "last user message" becomes the penultimate —
 * its prefix (system + tools + history) is identical, enabling cache hit on ~50K tokens.
 */
export function applyCacheToPenultimateMessage(messages: Anthropic.MessageParam[]): void {
  if (messages.length < 3) return;
  const msg = messages[messages.length - 2];

  if (Array.isArray(msg.content)) {
    const lastBlock = msg.content[msg.content.length - 1];
    if (lastBlock && ('type' in lastBlock)) {
      (lastBlock as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
  } else if (typeof msg.content === 'string') {
    (msg as unknown as Record<string, unknown>).content = [{
      type: 'text' as const,
      text: msg.content,
      cache_control: { type: 'ephemeral' as const },
    }];
  }
}

/**
 * Add cache_control to the last user message to cache conversation history prefix.
 * This tells Anthropic where the cacheable prefix ends — without it, system blocks
 * may not be cached effectively.
 */
function applyCacheToLastUserMessage(messages: Anthropic.MessageParam[]): void {
  if (messages.length === 0) return;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== 'user') return;

  if (Array.isArray(lastMsg.content)) {
    const lastBlock = lastMsg.content[lastMsg.content.length - 1];
    if (lastBlock && ('type' in lastBlock) && (lastBlock.type === 'text' || lastBlock.type === 'image' || lastBlock.type === 'tool_result')) {
      (lastBlock as unknown as Record<string, unknown>).cache_control = { type: 'ephemeral' };
    }
  } else if (typeof lastMsg.content === 'string') {
    (lastMsg as unknown as Record<string, unknown>).content = [{
      type: 'text' as const,
      text: lastMsg.content,
      cache_control: { type: 'ephemeral' as const },
    }];
  }
}
