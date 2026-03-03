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

    const debugFetch: typeof globalThis.fetch = async (url, init) => {
      log.debug(`LLM [codex-oauth] HTTP ${init?.method ?? 'GET'} ${url}`);
      if (init?.body) {
        const bodyStr = typeof init.body === 'string' ? init.body : String(init.body);
        log.debug(`LLM [codex-oauth] body (first 500): ${bodyStr.slice(0, 500)}`);
      }
      const res = await globalThis.fetch(url, init);
      if (!res.ok) {
        const cloned = res.clone();
        const text = await cloned.text().catch(() => '');
        log.error(`LLM [codex-oauth] response ${res.status}: body=${text.slice(0, 500) || '(empty)'}`);
      }
      return res;
    };

    const client = new OpenAI({
      apiKey: token,
      baseURL: 'https://chatgpt.com/backend-api/codex',
      defaultHeaders: headers,
      fetch: debugFetch,
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

  const instructions = systemParts.join('\n\n') || 'You are a coding assistant.';
  return { input, instructions };
}

function logApiError(method: string, err: unknown): void {
  const e = err as Record<string, unknown>;
  log.error(`LLM [codex-oauth] ${method} error: status=${e.status}, message=${e.message}`);
  if (e.error) log.error(`  error body: ${JSON.stringify(e.error)}`);
  if (e.code) log.error(`  code=${e.code}, param=${e.param}, type=${e.type}`);
}

