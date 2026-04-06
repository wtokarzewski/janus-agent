import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, ChatRequest, ChatResponse, LLMMessage, ToolCall, StreamCallback } from './types.js';
import type { TokenStore } from '../auth/types.js';
import { getAnthropicToken } from '../auth/anthropic-oauth.js';
import * as log from '../utils/logger.js';

/**
 * Apply prompt cache markers to tool definitions.
 * Places markers at two boundaries for optimal cache retention:
 * 1. Last built-in tool (stable across MCP changes)
 * 2. Last tool overall (captures MCP tools)
 * If no MCP tools present, only marks the last tool (same as before).
 */
export function applyCacheMarkers(tools: Array<{ name: string; [k: string]: unknown }>): void {
  if (tools.length === 0) return;

  const lastIdx = tools.length - 1;

  // Find last built-in tool (non-mcp_ prefix)
  let lastBuiltinIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    if (!tools[i].name.startsWith('mcp_')) {
      lastBuiltinIdx = i;
      break;
    }
  }

  // Mark built-in boundary (if it exists and differs from last tool)
  if (lastBuiltinIdx >= 0 && lastBuiltinIdx !== lastIdx) {
    tools[lastBuiltinIdx].cache_control = { type: 'ephemeral' };
  }

  // Always mark last tool
  tools[lastIdx].cache_control = { type: 'ephemeral' };
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
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.81',
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

    // OAuth tokens require Claude Code identity in system prompt
    const systemBlocks: Anthropic.TextBlockParam[] = [];
    if (this.useOAuth) {
      systemBlocks.push({
        type: 'text' as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' as const },
      });
    }
    if (systemMsg) {
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

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params);
    } catch (err) {
      // Fallback: if tool_choice rejected, retry without it (L14)
      if (params.tool_choice && err instanceof Error && /tool_choice|tool choice/i.test(err.message)) {
        log.warn(`Anthropic: tool_choice rejected, retrying without it`);
        delete params.tool_choice;
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

    // OAuth tokens require Claude Code identity in system prompt
    const streamSystemBlocks: Anthropic.TextBlockParam[] = [];
    if (this.useOAuth) {
      streamSystemBlocks.push({
        type: 'text' as const,
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: 'ephemeral' as const },
      });
    }
    if (systemMsg) {
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
