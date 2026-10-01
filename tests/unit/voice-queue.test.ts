import { it, expect, vi } from 'vitest';
import { VoiceQueue } from '../../src/channels/voice-queue.js';
const limits = { maxQueuedJobs: 1, maxQueueWaitMs: 1000 };

it('runs one job at a time in FIFO order and deduplicates delivery', async () => {
  const queue = new VoiceQueue();
  const order: number[] = [];
  let release!: () => void;
  const first = queue.enqueue('a:1', 'a', limits, async () => { order.push(1); await new Promise<void>(r => { release = r; }); });
  const duplicate = vi.fn();
  await queue.enqueue('a:1', 'a', limits, duplicate);
  const second = queue.enqueue('a:2', 'a', limits, async () => { order.push(2); });
  await expect(queue.enqueue('b:1', 'b', limits, async () => {})).rejects.toThrow('full');
  expect(order).toEqual([1]); release(); await first; await second;
  expect(order).toEqual([1, 2]); expect(duplicate).not.toHaveBeenCalled();
  await queue.idle();
});
it('cancels only matching chat jobs, then continues with another chat', async () => {
  const queue = new VoiceQueue();
  const first = queue.enqueue('a:1', 'a', limits, async signal => { await new Promise<void>(r => signal.addEventListener('abort', () => r())); });
  const run = vi.fn(async () => {});
  const second = queue.enqueue('b:1', 'b', limits, run);
  expect(queue.cancel('a')).toBe(1); await first; await second;
  expect(run).toHaveBeenCalledOnce();
});
it('expires a queued job without running it', async () => {
  const queue = new VoiceQueue();
  let release!: () => void;
  const first = queue.enqueue('a:1', 'a', limits, async () => { await new Promise<void>(r => { release = r; }); });
  const run = vi.fn();
  await expect(queue.enqueue('b:1', 'b', { ...limits, maxQueueWaitMs: 10 }, run)).rejects.toThrow('expired');
  release(); await first; await queue.idle(); expect(run).not.toHaveBeenCalled();
});
it('shutdown cancels active and queued work', async () => {
  const queue = new VoiceQueue();
  const first = queue.enqueue('a:1', 'a', limits, async signal => { await new Promise<void>(r => signal.addEventListener('abort', () => r())); });
  const run = vi.fn(); const second = queue.enqueue('b:1', 'b', limits, run);
  expect(queue.cancel()).toBe(2); await first; await second; await queue.idle(); expect(run).not.toHaveBeenCalled();
});
