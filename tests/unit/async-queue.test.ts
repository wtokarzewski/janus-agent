import { describe, it, expect } from 'vitest';
import { AsyncQueue } from '../../src/bus/async-queue.js';

describe('AsyncQueue', () => {
  it('should publish and consume in order', async () => {
    const q = new AsyncQueue<number>();
    await q.publish(1);
    await q.publish(2);
    expect(await q.consume()).toBe(1);
    expect(await q.consume()).toBe(2);
  });

  it('should hand off directly when consumer is waiting', async () => {
    const q = new AsyncQueue<string>();
    const consumePromise = q.consume();
    await q.publish('hello');
    expect(await consumePromise).toBe('hello');
  });

  it('should track size correctly', async () => {
    const q = new AsyncQueue<number>();
    expect(q.size).toBe(0);
    await q.publish(1);
    await q.publish(2);
    expect(q.size).toBe(2);
    await q.consume();
    expect(q.size).toBe(1);
  });

  it('should apply backpressure when full', async () => {
    const q = new AsyncQueue<number>(2);
    await q.publish(1);
    await q.publish(2);
    expect(q.size).toBe(2);

    // Third publish should block
    let published = false;
    const publishPromise = q.publish(3).then(() => { published = true; });

    // Give microtask queue a chance to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(published).toBe(false);

    // Consume one to unblock
    await q.consume();
    await publishPromise;
    expect(published).toBe(true);
  });

  it('should abort consume with AbortSignal', async () => {
    const q = new AsyncQueue<number>();
    const ac = new AbortController();

    const consumePromise = q.consume(ac.signal);
    ac.abort();

    await expect(consumePromise).rejects.toThrow('Aborted');
  });

  it('should abort publish with AbortSignal when full', async () => {
    const q = new AsyncQueue<number>(1);
    await q.publish(1);

    const ac = new AbortController();
    const publishPromise = q.publish(2, ac.signal);
    ac.abort();

    await expect(publishPromise).rejects.toThrow('Aborted');
  });

  it('should throw immediately if signal already aborted', async () => {
    const q = new AsyncQueue<number>();
    const ac = new AbortController();
    ac.abort();

    await expect(q.consume(ac.signal)).rejects.toThrow();
    await expect(q.publish(1, ac.signal)).rejects.toThrow();
  });

  it('should track pending consumers', async () => {
    const q = new AsyncQueue<number>();
    expect(q.pending).toBe(0);

    const p1 = q.consume();
    const p2 = q.consume();
    expect(q.pending).toBe(2);

    await q.publish(1);
    await q.publish(2);
    await p1;
    await p2;
    expect(q.pending).toBe(0);
  });
});
