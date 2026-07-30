import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../../src/utils/with-timeout.js';

describe('withTimeout', () => {
  it('returns the value when the promise settles before the deadline', async () => {
    const result = await withTimeout(Promise.resolve('me'), 1000);

    expect(result).toEqual({ ok: true, value: 'me' });
  });

  it('reports a timeout when the promise is still pending at the deadline', async () => {
    const result = await withTimeout(new Promise<string>(() => {}), 20);

    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('reports the error when the promise rejects before the deadline', async () => {
    const boom = new Error('504: Gateway Timeout');

    const result = await withTimeout(Promise.reject(boom), 1000);

    expect(result).toEqual({ ok: false, reason: 'error', error: boom });
  });

  // grammy's bot.init() retries forever and can reject long after we gave up on it.
  // An abandoned rejection must not surface as an unhandled rejection and kill the process.
  it('swallows a rejection that arrives after the timeout was reported', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let rejectLate!: (err: Error) => void;
    const late = new Promise<string>((_, reject) => { rejectLate = reject; });

    const result = await withTimeout(late, 10);
    rejectLate(new Error('too late'));
    await new Promise(resolve => setTimeout(resolve, 50));
    process.off('unhandledRejection', unhandled);

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('clears the timer once the promise settles so it cannot hold the process open', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    await withTimeout(Promise.resolve('done'), 60_000);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
