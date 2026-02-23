import type { LLMProvider, ChatRequest, ChatResponse, ProviderEntry, StreamCallback } from './types.js';
import * as log from '../utils/logger.js';

/**
 * ProviderRegistry — manages multiple LLM providers with purpose routing and failover.
 *
 * Features:
 * - Purpose routing: different providers for 'chat', 'summarize', 'classify'
 * - Failover: if primary provider fails, tries next by priority
 * - Backward compatible: wraps a single provider if no multi-provider config
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
        log.debug(`Provider "${entry.name}": attempting ${purpose ?? 'chat'} request`);
        return await entry.provider.chat(req);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log.warn(`Provider "${entry.name}" failed: ${lastError.message}`);

        if (candidates.length > 1) {
          log.info(`Failing over to next provider...`);
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
        log.debug(`Provider "${entry.name}": attempting ${purpose ?? 'chat'} stream request`);

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
        log.warn(`Provider "${entry.name}" stream failed: ${lastError.message}`);

        if (candidates.length > 1) {
          log.info(`Failing over to next provider...`);
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
