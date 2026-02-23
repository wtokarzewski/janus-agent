/**
 * Codex SDK provider — uses ChatGPT Plus/Pro subscription via `codex` CLI login.
 *
 * Uses structured output (JSON schema via outputSchema) to enforce tool call format.
 * Single-turn, no Codex built-in tools — just gets a response.
 */

import type { LLMProvider, ChatRequest, ChatResponse } from './types.js';
import {
  serializeMessages,
  buildToolCallSchema,
  buildToolSystemPrompt,
  parseStructuredResponse,
} from './sdk-utils.js';
import * as log from '../utils/logger.js';

export class CodexProvider implements LLMProvider {
  private defaultModel: string;

  constructor(config: { model: string }) {
    this.defaultModel = config.model;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const { Codex } = await import('@openai/codex-sdk');
    const hasTools = !!request.tools?.length;
    const model = request.model || this.defaultModel;

    log.debug(`LLM [codex]: model=${model}, messages=${request.messages.length}, tools=${request.tools?.length ?? 0}`);

    const systemParts = request.messages
      .filter(m => m.role === 'system')
      .map(m => m.content);
    if (hasTools) {
      systemParts.push(buildToolSystemPrompt(request.tools!));
    }

    const prompt = serializeMessages(request.messages);
    const fullPrompt = systemParts.length
      ? `[System]\n${systemParts.join('\n\n')}\n\n[Conversation]\n${prompt}`
      : prompt;

    const codex = new Codex();
    const thread = codex.startThread({ model });

    const turnOptions: Record<string, unknown> = {};
    if (hasTools) {
      turnOptions.outputSchema = buildToolCallSchema(request.tools!);
    }

    const turn = await thread.run(fullPrompt, turnOptions);

    const resultText = turn.finalResponse ?? '';
    const sdkUsage = {
      input_tokens: turn.usage?.input_tokens ?? 0,
      output_tokens: turn.usage?.output_tokens ?? 0,
    };

    log.debug(`LLM [codex]: tokens=${sdkUsage.input_tokens + sdkUsage.output_tokens}`);

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
