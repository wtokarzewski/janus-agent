import type { ProviderEntry } from './types.js';
import * as log from '../utils/logger.js';

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Consecutive failover-eligible failures before a provider is demoted. */
  failureThreshold: number;
  /** How long a demoted provider stays out of the candidate list. */
  cooldownMs: number;
}

interface BreakerState {
  failures: number;
  /** Timestamp when the cooldown ends, or null while the breaker is closed. */
  trippedUntil: number | null;
}

/**
 * Per-provider circuit breaker.
 *
 * Without it, ProviderRegistry re-walks the priority ladder on every call, so a
 * multi-hour upstream incident costs the full retry ladder on every message.
 * After `failureThreshold` failures a provider is skipped for `cooldownMs`;
 * expiry doubles as the health probe, since the primary has priority 0 and is
 * tried first again on the next request.
 *
 * State is keyed by the base provider name from config, never by the
 * registration label — one upstream may back several registered entries
 * (default slot, background slot) and they must be demoted together.
 */
export class ProviderCircuitBreaker {
  private state = new Map<string, BreakerState>();

  /** `now` is injectable so cooldown expiry is testable without sleeping. */
  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  recordFailure(providerName: string): void {
    if (!this.config.enabled) return;

    const state = this.state.get(providerName) ?? { failures: 0, trippedUntil: null };
    state.failures++;
    this.state.set(providerName, state);

    if (state.trippedUntil === null && state.failures >= this.config.failureThreshold) {
      state.trippedUntil = this.now() + this.config.cooldownMs;
      log.info(
        `Circuit breaker open for provider "${providerName}" after ${state.failures} failures — `
        + `skipping it for ${Math.round(this.config.cooldownMs / 1000)}s`,
      );
    }
  }

  recordSuccess(providerName: string): void {
    if (!this.config.enabled) return;
    this.state.delete(providerName);
  }

  isOpen(providerName: string): boolean {
    if (!this.config.enabled) return false;

    const state = this.state.get(providerName);
    if (!state || state.trippedUntil === null) return false;

    if (this.now() >= state.trippedUntil) {
      // Expired: clear in place and log, so recovery is visible in the log.
      this.state.delete(providerName);
      log.info(`Circuit breaker closed for provider "${providerName}" — cooldown elapsed, trying it again`);
      return false;
    }

    return true;
  }

  /**
   * Drop demoted providers — unless that would leave no candidates at all, in
   * which case hitting an unhealthy provider beats refusing to answer.
   */
  filter(entries: ProviderEntry[]): ProviderEntry[] {
    if (!this.config.enabled) return entries;

    const healthy = entries.filter(e => !this.isOpen(e.providerName));
    return healthy.length > 0 ? healthy : entries;
  }
}
