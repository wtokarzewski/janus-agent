/** Throwing deadline contract used by agent work (startup withTimeout returns a result). */
export function withDeadline<T>(promise: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      complete();
    };
    const abort = () => finish(() => reject(signal?.reason ?? new Error('Aborted')));
    const timer = setTimeout(() => finish(() => reject(new Error(message))), ms);
    // Attach both handlers even for an already-aborted caller: late failures are consumed.
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
