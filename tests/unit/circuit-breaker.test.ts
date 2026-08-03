import { describe, it, expect } from 'vitest';
import { ProviderCircuitBreaker } from '../../src/llm/circuit-breaker.js';
import type { ChatRequest, ChatResponse, LLMProvider, ProviderEntry } from '../../src/llm/types.js';

const noopProvider: LLMProvider = {
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    return { content: '', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'stop' };
  },
};

/** Fabricated provider names — must never match a real configuration. */
function makeEntry(providerName: string, label = providerName): ProviderEntry {
  return {
    name: label,
    providerName,
    provider: noopProvider,
    model: 'model-x',
    purpose: [],
    priority: 0,
  };
}

/** Injectable clock so cooldown expiry is testable without sleeping. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

const config = { enabled: true, failureThreshold: 2, cooldownMs: 300_000 };

describe('ProviderCircuitBreaker', () => {
  it('opens only on the Nth failure, not earlier', () => {
    const breaker = new ProviderCircuitBreaker(config);

    breaker.recordFailure('alpha');
    expect(breaker.isOpen('alpha')).toBe(false);

    breaker.recordFailure('alpha');
    expect(breaker.isOpen('alpha')).toBe(true);
  });

  it('resets the failure counter on success', () => {
    const breaker = new ProviderCircuitBreaker(config);

    breaker.recordFailure('alpha');
    breaker.recordSuccess('alpha');
    breaker.recordFailure('alpha');

    expect(breaker.isOpen('alpha')).toBe(false);
  });

  it('clears an open breaker on success', () => {
    const breaker = new ProviderCircuitBreaker(config);

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');
    expect(breaker.isOpen('alpha')).toBe(true);

    breaker.recordSuccess('alpha');
    expect(breaker.isOpen('alpha')).toBe(false);
  });

  it('tracks providers independently', () => {
    const breaker = new ProviderCircuitBreaker(config);

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');

    expect(breaker.isOpen('alpha')).toBe(true);
    expect(breaker.isOpen('beta')).toBe(false);
  });

  it('returns a provider to the pool after the cooldown elapses', () => {
    const clock = fakeClock();
    const breaker = new ProviderCircuitBreaker(config, clock.now);

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');
    expect(breaker.isOpen('alpha')).toBe(true);

    clock.advance(config.cooldownMs - 1);
    expect(breaker.isOpen('alpha')).toBe(true);

    clock.advance(2);
    expect(breaker.isOpen('alpha')).toBe(false);
  });

  it('starts counting from zero after a cooldown expires', () => {
    const clock = fakeClock();
    const breaker = new ProviderCircuitBreaker(config, clock.now);

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');
    clock.advance(config.cooldownMs + 1);
    expect(breaker.isOpen('alpha')).toBe(false);

    breaker.recordFailure('alpha');
    expect(breaker.isOpen('alpha')).toBe(false);

    breaker.recordFailure('alpha');
    expect(breaker.isOpen('alpha')).toBe(true);
  });

  it('drops open providers from the candidate list', () => {
    const breaker = new ProviderCircuitBreaker(config);
    const entries = [makeEntry('alpha'), makeEntry('beta')];

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');

    expect(breaker.filter(entries).map(e => e.providerName)).toEqual(['beta']);
  });

  it('demotes every entry of the same provider, whatever its registration label', () => {
    const breaker = new ProviderCircuitBreaker(config);
    const entries = [makeEntry('alpha'), makeEntry('alpha', 'alpha-background'), makeEntry('beta')];

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');

    expect(breaker.filter(entries).map(e => e.name)).toEqual(['beta']);
  });

  it('passes everything through when all providers are open', () => {
    const breaker = new ProviderCircuitBreaker(config);
    const entries = [makeEntry('alpha'), makeEntry('beta')];

    for (const name of ['alpha', 'beta']) {
      breaker.recordFailure(name);
      breaker.recordFailure(name);
    }

    expect(breaker.filter(entries)).toEqual(entries);
  });

  it('disables filtering and counting entirely when not enabled', () => {
    const breaker = new ProviderCircuitBreaker({ ...config, enabled: false });
    const entries = [makeEntry('alpha'), makeEntry('beta')];

    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');
    breaker.recordFailure('alpha');

    expect(breaker.isOpen('alpha')).toBe(false);
    expect(breaker.filter(entries)).toEqual(entries);
  });
});
