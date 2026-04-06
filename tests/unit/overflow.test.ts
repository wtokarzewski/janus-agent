import { describe, it, expect } from 'vitest';
import { isContextOverflow } from '../../src/llm/overflow.js';

describe('isContextOverflow', () => {
  it('detects Anthropic request_too_large', () => {
    expect(isContextOverflow(new Error('request_too_large: max 200000 tokens'))).toBe(true);
  });

  it('detects Anthropic prompt is too long', () => {
    expect(isContextOverflow(new Error('prompt is too long: 250000 tokens > 200000 maximum'))).toBe(true);
  });

  it('detects OpenAI maximum context length', () => {
    expect(isContextOverflow(new Error("This model's maximum context length is 128000 tokens"))).toBe(true);
  });

  it('detects OpenAI Request too large', () => {
    expect(isContextOverflow(new Error('Request too large for model'))).toBe(true);
  });

  it('detects Google exceeds the maximum', () => {
    expect(isContextOverflow(new Error('Input exceeds the maximum number of tokens'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isContextOverflow(new Error('rate limit exceeded'))).toBe(false);
    expect(isContextOverflow(new Error('network timeout'))).toBe(false);
    expect(isContextOverflow(new Error('invalid api key'))).toBe(false);
  });

  it('handles non-Error objects gracefully', () => {
    expect(isContextOverflow('string error' as unknown as Error)).toBe(false);
    expect(isContextOverflow(null as unknown as Error)).toBe(false);
  });
});
