/**
 * Bound an awaited promise so a hung dependency cannot stall startup.
 *
 * Returns a result object rather than throwing: a timeout is an expected
 * outcome the caller has to handle, not an exceptional one. The rejection
 * handler is attached immediately, so a promise abandoned at the deadline
 * can still reject later without surfacing as an unhandled rejection.
 */

export type TimeoutResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'error'; error: unknown };

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimeoutResult<T>> {
  return new Promise<TimeoutResult<T>>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        // Abandoned after the deadline — swallow it, the caller already moved on.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'error', error });
      },
    );
  });
}
