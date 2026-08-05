import type { LLMProvider, ChatRequest, ChatResponse, ProviderEntry, StreamCallback, LLMMessage } from './types.js';
import { isFailoverCandidate } from './retry.js';
import type { ProviderCircuitBreaker } from './circuit-breaker.js';
import { stripOrphanSurrogates } from '../utils/sanitize.js';
import * as log from '../utils/logger.js';

/**
 * Defense-in-depth: strip orphan UTF-16 surrogates from all message content
 * before any provider sees it. A split surrogate pair (e.g. an emoji cut by
 * truncation upstream) serializes to invalid JSON and makes providers reject
 * the request with 400 "no low surrogate in string". Returns the same array
 * reference when nothing changed, to preserve prompt-cache stability.
 */
function sanitizeRequestMessages(messages: LLMMessage[]): LLMMessage[] {
  let changed = false;
  const out = messages.map((m): LLMMessage => {
    if (typeof m.content === 'string') {
      const clean = stripOrphanSurrogates(m.content);
      if (clean === m.content) return m;
      changed = true;
      return { ...m, content: clean };
    }
    if (Array.isArray(m.content)) {
      let blockChanged = false;
      const blocks = (m.content as Array<Record<string, unknown>>).map((b) => {
        if (b && typeof b.text === 'string') {
          const clean = stripOrphanSurrogates(b.text);
          if (clean !== b.text) {
            blockChanged = true;
            return { ...b, text: clean };
          }
        }
        return b;
      });
      if (!blockChanged) return m;
      changed = true;
      return { ...m, content: blocks } as LLMMessage;
    }
    return m;
  });
  return changed ? out : messages;
}

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
  /** Operator-chosen provider, tried before the priority order. Process-local. */
  private pinned?: string;

  /** Without a breaker the registry re-walks the full priority ladder on every call. */
  constructor(private readonly breaker?: ProviderCircuitBreaker) {}

  /**
   * Send traffic to `providerName` first, regardless of priority or breaker
   * state — an operator asking for a provider outranks both. The rest of the
   * ladder stays behind it, so a pin is a preference, not a single point of
   * failure. Returns false if no entry serves that provider.
   */
  pin(providerName: string): boolean {
    if (!this.entries.some(e => e.providerName === providerName)) return false;
    this.pinned = providerName;
    log.info(`Provider pinned to "${providerName}" (until unpinned or restart)`);
    return true;
  }

  /** Back to priority order. */
  unpin(): void {
    if (this.pinned) log.info(`Provider pin on "${this.pinned}" released`);
    this.pinned = undefined;
  }

  getPinned(): string | undefined {
    return this.pinned;
  }

  /** Health of each registered provider, for status commands. */
  status(): { providerName: string; model: string; priority: number; pinned: boolean; demoted: boolean }[] {
    const seen = new Set<string>();
    return this.entries
      .filter(e => !seen.has(e.providerName) && seen.add(e.providerName))
      .map(e => ({
        providerName: e.providerName,
        model: e.model,
        priority: e.priority,
        pinned: e.providerName === this.pinned,
        demoted: this.breaker?.isOpen(e.providerName) ?? false,
      }));
  }

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
    const messages = sanitizeRequestMessages(request.messages);

    for (const entry of candidates) {
      try {
        const req = { ...request, messages, model: request.model || entry.model };
        log.debug(`Provider "${entry.name}" (${entry.model}): attempting ${purpose ?? 'chat'} request`);
        const result = await entry.provider.chat(req);
        this.breaker?.recordSuccess(entry.providerName);
        result.provider = entry.name;
        result.model = entry.model;
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logProviderError(entry, 'chat', lastError, request);

        // The same gate decides failover and demotion, so the two can never disagree:
        // an error that fails on any provider must not count against this one.
        if (!isFailoverCandidate(lastError)) throw lastError;
        this.breaker?.recordFailure(entry.providerName);

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
    const messages = sanitizeRequestMessages(request.messages);

    for (const entry of candidates) {
      try {
        const req = { ...request, messages, model: request.model || entry.model };
        log.debug(`Provider "${entry.name}" (${entry.model}): attempting ${purpose ?? 'chat'} stream request`);

        if (entry.provider.chatStream) {
          const result = await entry.provider.chatStream(req, onChunk);
          this.breaker?.recordSuccess(entry.providerName);
          result.provider = entry.name;
          result.model = entry.model;
          return result;
        }

        // Fallback: non-streaming chat, then deliver content as single chunk
        const response = await entry.provider.chat(req);
        this.breaker?.recordSuccess(entry.providerName);
        response.provider = entry.name;
        response.model = entry.model;
        if (response.content) {
          onChunk(response.content);
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logProviderError(entry, 'stream', lastError, request);

        if (!isFailoverCandidate(lastError)) throw lastError;
        this.breaker?.recordFailure(entry.providerName);

        if (candidates.length > 1) {
          log.info(`Failing over from "${entry.name}" (${entry.model}) to next provider...`);
        }
      }
    }

    throw lastError ?? new Error('All providers failed');
  }

  private getCandidates(purpose?: string): ProviderEntry[] {
    const byPurpose = this.matchPurpose(purpose);
    // Health filtering comes last, so it never widens the purpose match.
    const healthy = this.breaker ? this.breaker.filter(byPurpose) : byPurpose;

    if (!this.pinned) return healthy;
    // The pin is taken from the purpose-matched set, not the healthy one: an
    // operator overriding a demotion is exactly why the command exists.
    const pinnedEntries = byPurpose.filter(e => e.providerName === this.pinned);
    if (pinnedEntries.length === 0) return healthy;

    return [...pinnedEntries, ...healthy.filter(e => e.providerName !== this.pinned)];
  }

  private matchPurpose(purpose?: string): ProviderEntry[] {
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
