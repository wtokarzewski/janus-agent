import * as log from '../utils/logger.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULTS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
};

/**
 * Retry with exponential backoff + jitter.
 * Retries on: 429 (transient rate limit), 500+ (server), network errors.
 * Does NOT retry on: prompt-too-big 429 (would just fail again).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...opts };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxRetries || !isRetryable(lastError)) {
        throw lastError;
      }

      // Use Retry-After header if available, otherwise exponential backoff
      const retryAfterMs = parseRetryAfter(lastError);
      const backoffDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const jitter = backoffDelay * 0.5 * Math.random();
      const waitMs = retryAfterMs ?? (backoffDelay + jitter);

      log.warn(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(waitMs)}ms: ${lastError.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function isRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();

  // Prompt too big — retrying won't help, the payload is inherently too large
  if (msg.includes('rate_limit_error') && (msg.includes('input tokens') || msg.includes('prompt length'))) {
    log.error('Prompt exceeds API token limit — not retrying (reduce context size)');
    return false;
  }

  // Transient rate limit (per-minute quota, concurrent requests)
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit')) return true;
  // Resource exhaustion (gRPC-style, Anthropic overload) (L5)
  if (msg.includes('resource_exhausted') || msg.includes('overloaded') || msg.includes('capacity')) return true;
  // Server errors
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  // Network
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed')) return true;
  return false;
}

/** Extract retry delay from error message if Retry-After info is present. */
function parseRetryAfter(err: Error): number | null {
  // Anthropic includes retry timing in error messages sometimes
  const match = err.message.match(/retry.after[:\s]+(\d+)/i);
  if (match) return parseInt(match[1], 10) * 1000;
  return null;
}

/**
 * Should a multi-provider registry fail over to the next provider?
 * True for transient errors (5xx, network, rate-limit).
 * False for client errors that would fail on any provider (401, 400, prompt-too-big).
 */
export function isFailoverCandidate(err: Error): boolean {
  const msg = err.message.toLowerCase();
  const status = extractStatusCode(msg);

  // Server errors — always failover
  if (status !== null && status >= 500) return true;

  // Resource exhaustion / overload — failover to different provider (L5)
  if (msg.includes('resource_exhausted') || msg.includes('overloaded') || msg.includes('capacity')) return true;

  // Transient rate limit (but not prompt-too-big disguised as 429) (L6)
  if ((msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('too many requests'))
    && !msg.includes('input tokens') && !msg.includes('prompt length')) return true;

  // Network errors
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed')) return true;

  // Auth errors — DO failover. Credentials are per-provider (separate entries in
  // .janus/auth.json), so a rejected key or a failed OAuth refresh on one provider
  // says nothing about the next one's credentials.
  if (msg.includes('invalid_api_key') || msg.includes('authentication_error')) return true;

  // Request format errors — DO failover, different providers accept different formats
  // (invalid_request from Anthropic may succeed on OpenAI and vice versa)
  if (msg.includes('invalid_request') || msg.includes('malformed')) return true;

  // 422: distinguish format errors (failover may help) from billing errors (won't help) (L9)
  if (status === 422) {
    if (msg.includes('billing') || msg.includes('payment') || msg.includes('quota')) return false;
    return true; // format/validation error — different provider may accept
  }

  // Other client errors — failing over won't help
  if (status !== null && status >= 400 && status < 500) return false;

  // Unknown errors — fail over (safe default)
  log.debug(`Unknown error → failover: ${msg.slice(0, 120)}`);
  return true;
}

function extractStatusCode(msg: string): number | null {
  // Specific HTTP-context patterns first (avoids false positives from versions, line numbers)
  for (const p of [
    /\bstatus[:\s]+(\d{3})\b/i,
    /\bhttp[\s/]+\d*\.?\d*\s*(\d{3})\b/i,
    /\berror[:\s]+(\d{3})\b/i,
  ]) {
    const m = msg.match(p);
    if (m) return parseInt(m[1], 10);
  }
  // Fallback: standalone 4xx/5xx not preceded by digit/dot
  const fallback = msg.match(/(?<![.\d])([45]\d{2})(?!\d)/);
  return fallback ? parseInt(fallback[1], 10) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
