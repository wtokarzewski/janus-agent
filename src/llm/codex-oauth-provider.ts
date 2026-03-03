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
    const headers: Record<string, string> = {
      'openai-beta': 'responses=experimental',
      'originator': 'codex_cli_rs',
    };
    if (accountId) headers['chatgpt-account-id'] = accountId;

    const client = new OpenAI({
      apiKey: token,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: headers,
    });
    return { client, accountId };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Codex backend requires stream=true, so we stream and collect the result
    return this.chatStream(request, () => {});
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback): Promise<ChatResponse> {
    const model = request.model || this.defaultModel;
    log.debug(`LLM [codex-oauth] stream: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const { client } = await this.createClient();
    const { input, instructions } = convertInput(request.messages);

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model,
      input,
      instructions,
      store: false,
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
      params.tool_choice = 'auto';
      params.parallel_tool_calls = true;
    }

    let stream;
    try {
      stream = await client.responses.create(params);
    } catch (err: unknown) {
      logApiError('stream', err);
      throw err;
    }

    let content = '';
    const toolCalls: ToolCall[] = [];
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
    let inputTokens = 0;
    let outputTokens = 0;
    const itemMeta = new Map<string, { callId: string; name: string }>();

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        content += event.delta;
        onChunk(event.delta);
      } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        const fc = event.item as unknown as Record<string, unknown>;
        if (fc.id) itemMeta.set(fc.id as string, { callId: (fc.call_id as string) ?? '', name: (fc.name as string) ?? '' });
      } else if (event.type === 'response.function_call_arguments.done') {
        const meta = itemMeta.get(event.item_id);
        const callId = meta?.callId ?? event.item_id;
        const name = event.name || meta?.name || '';
        toolCalls.push({
          id: callId,
          type: 'function',
          function: { name, arguments: event.arguments },
        });
      } else if (event.type === 'response.completed') {
        const resp = event.response;
        if (resp.usage) {
          inputTokens = resp.usage.input_tokens;
          outputTokens = resp.usage.output_tokens;
        }
        const hasFunctionCalls = resp.output.some(
          (item: { type: string }) => item.type === 'function_call',
        );
        if (hasFunctionCalls) finishReason = 'tool_calls';
        else if (resp.status === 'incomplete') finishReason = 'length';

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

function convertInput(messages: LLMMessage[]): { input: ResponseInput; instructions: string } {
  const input: ResponseInput = [];
  const systemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
    } else if (msg.role === 'user') {
      input.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (!tc.function?.name) continue;
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
          });
        }
      }
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: msg.content,
      });
    }
  }

  // Strip orphan function_call_outputs — every output must have a matching function_call
  const callIds = new Set<string>();
  for (const item of input) {
    if ('type' in item && item.type === 'function_call') {
      callIds.add((item as { call_id: string }).call_id);
    }
  }
  const cleaned = input.filter(item => {
    if ('type' in item && item.type === 'function_call_output') {
      return callIds.has((item as { call_id: string }).call_id);
    }
    return true;
  }) as ResponseInput;

  const instructions = systemParts.join('\n\n') || 'You are a coding assistant.';
  return { input: cleaned, instructions };
}

function logApiError(method: string, err: unknown): void {
  const e = err as Record<string, unknown>;
  log.error(`LLM [codex-oauth] ${method} error: status=${e.status}, message=${e.message}`);
  if (e.error) log.error(`  error body: ${JSON.stringify(e.error)}`);
  if (e.code) log.error(`  code=${e.code}, param=${e.param}, type=${e.type}`);
}

