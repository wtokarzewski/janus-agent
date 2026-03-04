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
  if (msg.includes('429') || msg.includes('rate limit')) return true;
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

  // Client errors — failing over won't help
  if (status !== null && status >= 400 && status < 500) return false;

  // Server errors
  if (status !== null && status >= 500) return true;

  // Transient rate limit (but not prompt-too-big disguised as 429)
  if (msg.includes('rate limit') && !msg.includes('input tokens') && !msg.includes('prompt length')) return true;

  // Network errors
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('fetch failed')) return true;

  // Unknown errors — fail over (safe default)
  return true;
}

function extractStatusCode(msg: string): number | null {
  // Match patterns like "status 503", "error 401", or standalone "503"
  const match = msg.match(/\b([2-5]\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
