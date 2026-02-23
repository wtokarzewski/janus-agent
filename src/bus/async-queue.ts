/**
 * Bounded async queue with backpressure.
 * Blocks publish when full, blocks consume when empty.
 * Supports AbortSignal for clean shutdown.
 */
export class AsyncQueue<T> {
  private queue: T[] = [];
  private publishWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private consumeWaiters: Array<{ resolve: (value: T) => void; reject: (err: Error) => void }> = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  async publish(item: T, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    // If someone is waiting to consume, hand off directly
    if (this.consumeWaiters.length > 0) {
      const waiter = this.consumeWaiters.shift()!;
      waiter.resolve(item);
      return;
    }

    // If queue is full, wait for space
    if (this.queue.length >= this.maxSize) {
      await new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject };
        this.publishWaiters.push(entry);

        signal?.addEventListener('abort', () => {
          const idx = this.publishWaiters.indexOf(entry);
          if (idx !== -1) this.publishWaiters.splice(idx, 1);
          reject(new Error('Aborted'));
        }, { once: true });
      });
    }

    this.queue.push(item);
  }

  async consume(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();

    // If items available, return immediately
    if (this.queue.length > 0) {
      const item = this.queue.shift()!;
      // Wake up a blocked publisher if any
      if (this.publishWaiters.length > 0) {
        this.publishWaiters.shift()!.resolve();
      }
      return item;
    }

    // Wait for an item
    return new Promise<T>((resolve, reject) => {
      const entry = { resolve, reject };
      this.consumeWaiters.push(entry);

      signal?.addEventListener('abort', () => {
        const idx = this.consumeWaiters.indexOf(entry);
        if (idx !== -1) this.consumeWaiters.splice(idx, 1);
        reject(new Error('Aborted'));
      }, { once: true });
    });
  }

  get size(): number {
    return this.queue.length;
  }

  get pending(): number {
    return this.consumeWaiters.length;
  }
}
