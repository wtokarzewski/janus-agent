import type { LLMProvider, ChatRequest, ChatResponse, ProviderEntry, StreamCallback } from './types.js';
import { isFailoverCandidate } from './retry.js';
import * as log from '../utils/logger.js';

/**
 * ProviderRegistry — manages multiple LLM providers with purpose routing and failover.
 *
 * Features:
 * - Purpose routing: different providers for 'chat', 'summarize', 'classify'
 * - Failover: if primary provider fails, tries next by priority
 * - Backward compatible: wraps a single provider if no multi-provider config
 * - Per-provider logLevel: minimal (errors only), normal (default), verbose (full error details)
 */
export class ProviderRegistry implements LLMProvider {
  private entries: ProviderEntry[] = [];

  register(entry: ProviderEntry): void {
    this.entries.push(entry);
    this.entries.sort((a, b) => a.priority - b.priority);
    log.info(`Provider registered: "${entry.name}" (model=${entry.model}, purpose=${entry.purpose.join(',') || '*'}, priority=${entry.priority})`);
  }

  get(name: string): ProviderEntry | undefined {
    return this.entries.find(e => e.name === name);
  }

  /** Get all registered entries. */
  list(): ProviderEntry[] {
    return [...this.entries];
  }

  /**
   * Send a chat request with purpose-based routing and failover.
   * If purpose is specified, filters to providers that match (or have no purpose = all).
   * Tries each provider in priority order until one succeeds.
   */
  async chat(request: ChatRequest, purpose?: string): Promise<ChatResponse> {
    const candidates = this.getCandidates(purpose);

    if (candidates.length === 0) {
      throw new Error(`No providers available${purpose ? ` for purpose "${purpose}"` : ''}`);
    }

    let lastError: Error | undefined;

    for (const entry of candidates) {
      try {
        const req = { ...request, model: request.model || entry.model };
        log.debug(`Provider "${entry.name}" (${entry.model}): attempting ${purpose ?? 'chat'} request`);
        return await entry.provider.chat(req);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logProviderError(entry, 'chat', lastError, request);

        if (!isFailoverCandidate(lastError)) throw lastError;

        if (candidates.length > 1) {
          log.info(`Failing over from "${entry.name}" (${entry.model}) to next provider...`);
        }
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  async chatStream(request: ChatRequest, onChunk: StreamCallback, purpose?: string): Promise<ChatResponse> {
    const candidates = this.getCandidates(purpose);

    if (candidates.length === 0) {
      throw new Error(`No providers available${purpose ? ` for purpose "${purpose}"` : ''}`);
    }

    let lastError: Error | undefined;

    for (const entry of candidates) {
      try {
        const req = { ...request, model: request.model || entry.model };
        log.debug(`Provider "${entry.name}" (${entry.model}): attempting ${purpose ?? 'chat'} stream request`);

        if (entry.provider.chatStream) {
          return await entry.provider.chatStream(req, onChunk);
        }

        // Fallback: non-streaming chat, then deliver content as single chunk
        const response = await entry.provider.chat(req);
        if (response.content) {
          onChunk(response.content);
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logProviderError(entry, 'stream', lastError, request);

        if (!isFailoverCandidate(lastError)) throw lastError;

        if (candidates.length > 1) {
          log.info(`Failing over from "${entry.name}" (${entry.model}) to next provider...`);
        }
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  private getCandidates(purpose?: string): ProviderEntry[] {
    if (!purpose) return this.entries;

    // Providers with matching purpose, or with empty purpose (serves all)
    const matched = this.entries.filter(
      e => e.purpose.length === 0 || e.purpose.includes(purpose),
    );

    return matched.length > 0 ? matched : this.entries;
  }
}

/**
 * Universal provider error logger — one function for all providers.
 *
 * Levels:
 * - minimal: single-line warn (provider + message)
 * - normal:  same as minimal (default)
 * - verbose: full error details (status, headers, body, request context)
 */
function logProviderError(entry: ProviderEntry, method: string, err: Error, request: ChatRequest): void {
  const level = entry.logLevel ?? 'normal';
  const prefix = `Provider "${entry.name}" (${entry.model})`;

  // All levels: basic failure message
  log.warn(`${prefix} ${method} failed: ${err.message}`);

  if (level !== 'verbose') return;

  // Verbose: extract everything we can from the SDK error object
  const e = err as unknown as Record<string, unknown>;

  const details: string[] = [];

  // HTTP status
  if (e.status != null) details.push(`status: ${e.status}`);

  // Error type/code (Anthropic: error.type, OpenAI: code)
  if (e.code) details.push(`code: ${e.code}`);
  const errorBody = e.error as Record<string, unknown> | undefined;
  if (errorBody?.type) details.push(`type: ${errorBody.type}`);

  // Request ID from headers (Anthropic: request-id, OpenAI: x-request-id)
  const headers = e.headers as Record<string, string> | undefined;
  if (headers) {
    const requestId = headers['request-id'] ?? headers['x-request-id'] ?? headers['cf-ray'];
    if (requestId) details.push(`request_id: ${requestId}`);
  }

  // Full error body
  if (errorBody) {
    details.push(`error_body: ${JSON.stringify(errorBody)}`);
  }

  // Request context (not the content — just shape)
  details.push(`messages: ${request.messages.length}`);
  details.push(`tools: ${request.tools?.length ?? 0}`);
  const systemMsg = request.messages.find(m => m.role === 'system');
  if (systemMsg) details.push(`system_prompt_len: ${systemMsg.content.length}`);

  log.error(`${prefix} VERBOSE:\n  ${details.join('\n  ')}`);
}
