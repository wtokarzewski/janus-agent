import { describe, it, expect } from 'vitest';
import { isFailoverCandidate, isContextLengthError, isNonRetryableClientError } from '../../src/llm/retry.js';

/** Verbatim shapes seen in production logs. */
const OAUTH_REFRESH_EXPIRED =
  'Token refresh failed (400): {"error": "invalid_grant", "error_description": "Refresh token expired"}';
const ANTHROPIC_PROMPT_TOO_LONG =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213000 tokens > 200000 maximum"}}';
const OPENAI_CONTEXT_LENGTH =
  "This model's maximum context length is 128000 tokens, however you requested 130000 tokens";

describe('isFailoverCandidate', () => {
  it('fails over when the primary\'s OAuth refresh token has expired', () => {
    // Credentials are per-provider — a dead refresh token says nothing about the fallback.
    expect(isFailoverCandidate(new Error(OAUTH_REFRESH_EXPIRED))).toBe(true);
  });

  it('fails over on a typed auth error', () => {
    expect(isFailoverCandidate(new Error('authentication_error: invalid x-api-key'))).toBe(true);
  });

  it('does not fail over on a prompt that is too long for any provider', () => {
    expect(isFailoverCandidate(new Error(ANTHROPIC_PROMPT_TOO_LONG))).toBe(false);
  });

  it('fails over on server errors', () => {
    expect(isFailoverCandidate(new Error('503 Service Unavailable'))).toBe(true);
  });
});

describe('isContextLengthError', () => {
  it('does not mistake a token refresh failure for a context overflow', () => {
    // The word "Token" alone used to trip this, wasting two hard-clear retries.
    expect(isContextLengthError(new Error(OAUTH_REFRESH_EXPIRED))).toBe(false);
  });

  it('detects an over-long prompt', () => {
    expect(isContextLengthError(new Error(ANTHROPIC_PROMPT_TOO_LONG))).toBe(true);
  });

  it('detects an exceeded context window', () => {
    expect(isContextLengthError(new Error(OPENAI_CONTEXT_LENGTH))).toBe(true);
  });

  it('detects the input-length variant', () => {
    expect(isContextLengthError(new Error('input length and `max_tokens` exceed context limit'))).toBe(true);
  });

  it('ignores unrelated failures', () => {
    expect(isContextLengthError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isContextLengthError(new Error('fetch failed'))).toBe(false);
  });
});

describe('isNonRetryableClientError', () => {
  it('does not retry an expired refresh token — it never self-heals', () => {
    expect(isNonRetryableClientError(new Error(OAUTH_REFRESH_EXPIRED))).toBe(true);
  });

  it('does not retry auth failures', () => {
    expect(isNonRetryableClientError(new Error('401 authentication_error'))).toBe(true);
    expect(isNonRetryableClientError(new Error('invalid_api_key'))).toBe(true);
  });

  it('does not retry malformed requests', () => {
    expect(isNonRetryableClientError(new Error('invalid_request: unexpected field'))).toBe(true);
    expect(isNonRetryableClientError(new Error('400 malformed body'))).toBe(true);
  });

  it('retries transient server and network failures', () => {
    expect(isNonRetryableClientError(new Error('503 Service Unavailable'))).toBe(false);
    expect(isNonRetryableClientError(new Error('fetch failed'))).toBe(false);
    expect(isNonRetryableClientError(new Error('Overloaded'))).toBe(false);
  });
});
