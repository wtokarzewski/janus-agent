import { describe, it, expect, vi, afterEach } from 'vitest';
import { getEventListeners } from 'node:events';
import { sleep, withDeadline } from '../../src/utils/abort.js';

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('Bounded waits', () => {
  it.each(['success', 'failure'])('cleans timer and listener after %s', async mode => {
    vi.useFakeTimers(); const ctrl = new AbortController();
    const promise = withDeadline(mode === 'success' ? Promise.resolve(17) : Promise.reject(new Error('failed')), 900_000, 'timeout', ctrl.signal);
    if (mode === 'success') expect(await promise).toBe(17);
    else await expect(promise).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  });

  it.each(['timeout', 'abort'])('handles late rejection after %s and removes resources', async mode => {
    vi.useFakeTimers(); const ctrl = new AbortController();
    let reject!: (error: Error) => void;
    const original = new Promise<never>((_, r) => { reject = r; });
    const pending = withDeadline(original, 500, 'deadline', ctrl.signal);
    const checked = expect(pending).rejects.toThrow();
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(500); else ctrl.abort();
    await checked;
    reject(new Error('late rejection'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  });

  it('cleans sleep listeners on normal completion and immediate abort', async () => {
    vi.useFakeTimers(); const ctrl = new AbortController();
    const done = sleep(50, ctrl.signal);
    await vi.advanceTimersByTimeAsync(50); await done;
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
    const waiting = sleep(900_000, ctrl.signal);
    const checked = expect(waiting).rejects.toThrow();
    ctrl.abort(); await checked;
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  });
});
