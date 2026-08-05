/**
 * OAuth refresh serialization.
 *
 * Refresh tokens are single-use: the provider hands back a new one and kills
 * the old on every exchange. Janus refreshes from three places — every LLM
 * call (`ensureFreshToken`), the 30-minute proactive sweep, and the setup
 * wizard — and lanes run up to 11 requests concurrently, so without a lock a
 * burst of calls fires several exchanges with the same token. One wins; the
 * rest come back `invalid_grant`.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Run at most one refresh per provider; concurrent callers share the result. */
export function singleFlight<T>(provider: string, exchange: () => Promise<T>): Promise<T> {
  const running = inFlight.get(provider) as Promise<T> | undefined;
  if (running) return running;

  const started = exchange().finally(() => {
    inFlight.delete(provider);
  });
  inFlight.set(provider, started);
  return started;
}
