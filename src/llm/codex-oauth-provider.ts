import OpenAI from 'openai';
import type { LLMProvider, ChatRequest, ChatResponse, ToolCall, StreamCallback, LLMMessage } from './types.js';
import type { TokenStore } from '../auth/types.js';
import { getCodexToken } from '../auth/codex-oauth.js';
import * as log from '../utils/logger.js';

/**
 * Codex OAuth provider — uses OpenAI Responses API via ChatGPT backend.
 * For subscription users (ChatGPT Plus/Pro) authenticated via native OAuth.
 */
export class CodexOAuthProvider implements LLMProvider {
  private defaultModel: string;
  private tokenStore: TokenStore;

  constructor(config: { defaultModel: string; tokenStore: TokenStore }) {
    this.defaultModel = config.defaultModel;
    this.tokenStore = config.tokenStore;
  }

  private async createClient(): Promise<{ client: OpenAI; accountId?: string }> {
    const { token, accountId } = await getCodexToken(this.tokenStore);
    const headers: Record<string, string> = { 'OpenAI-Beta': 'responses=experimental' };
    if (accountId) headers['Chatgpt-Account-Id'] = accountId;

    const client = new OpenAI({
      apiKey: token,
      baseURL: 'https://chatgpt.com/backend-api',
      defaultHeaders: headers,
    });
    return { client, accountId };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;
    log.debug(`LLM [codex-oauth]: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const { client } = await this.createClient();

    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model,
      input: convertInput(request.messages),
      temperature: request.temperature ?? 0.7,
      max_output_tokens: request.maxTokens ?? 4096,
    };

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map(t => ({
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description ?? '',
        parameters: t.function.parameters ?? null,
        strict: false,
      }));
    }

    const response = await client.responses.create(params);
    return parseResponse(response);
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;
    log.debug(`LLM [codex-oauth] stream: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const { client } = await this.createClient();

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model,
      input: convertInput(request.messages),
      temperature: request.temperature ?? 0.7,
      max_output_tokens: request.maxTokens ?? 4096,
      stream: true,
    };

    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map(t => ({
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description ?? '',
        parameters: t.function.parameters ?? null,
        strict: false,
      }));
    }

    const stream = await client.responses.create(params);

    let content = '';
    const toolCalls: ToolCall[] = [];
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    // Track call_ids from output_item.added events for function calls
    const itemCallIds = new Map<string, string>();

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        content += event.delta;
        onChunk(event.delta);
      } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        const fc = event.item as { id?: string; call_id: string };
        if (fc.id) itemCallIds.set(fc.id, fc.call_id);
      } else if (event.type === 'response.function_call_arguments.done') {
        const callId = itemCallIds.get(event.item_id) ?? event.item_id;
        toolCalls.push({
          id: callId,
          type: 'function',
          function: { name: event.name, arguments: event.arguments },
        });
      } else if (event.type === 'response.completed') {
        const resp = event.response;
        if (resp.usage) {
          inputTokens = resp.usage.input_tokens;
          outputTokens = resp.usage.output_tokens;
        }
        // Determine finish reason from output items
        const hasFunctionCalls = resp.output.some(
          (item: { type: string }) => item.type === 'function_call',
        );
        if (hasFunctionCalls) finishReason = 'tool_calls';
        else if (resp.status === 'incomplete') finishReason = 'length';

        // Collect any text we may have missed
        if (!content) {
          content = resp.output_text ?? '';
        }
      }
    }

    log.debug(`LLM [codex-oauth] stream: finish=${finishReason}, tool_calls=${toolCalls.length}`);

    return {
      content,
      toolCalls,
      usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens },
      finishReason,
    };
  }
}

type ResponseInput = OpenAI.Responses.ResponseInput;

function convertInput(messages: LLMMessage[]): ResponseInput {
  const input: ResponseInput = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      input.push({ role: 'developer', content: msg.content });
    } else if (msg.role === 'user') {
      input.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      if (!msg.content && !msg.tool_calls?.length) {
        input.push({ role: 'assistant', content: '' });
      }
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: msg.content,
      });
    }
  }

  return input;
}

function parseResponse(response: OpenAI.Responses.Response): ChatResponse {
  let content = response.output_text ?? '';
  const toolCalls: ToolCall[] = [];

  for (const item of response.output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
    } else if (item.type === 'message' && !content) {
      for (const part of item.content) {
        if (part.type === 'output_text') content += part.text;
      }
    }
  }

  const finishReason = toolCalls.length > 0 ? 'tool_calls' as const
    : response.status === 'incomplete' ? 'length' as const
    : 'stop' as const;

  log.debug(`LLM [codex-oauth]: finish=${finishReason}, tool_calls=${toolCalls.length}`);

  return {
    content,
    toolCalls,
    usage: {
      promptTokens: response.usage?.input_tokens ?? 0,
      completionTokens: response.usage?.output_tokens ?? 0,
      totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0),
    },
    finishReason,
  };
}
