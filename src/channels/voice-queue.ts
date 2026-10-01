const DEDUP_TTL_MS = 10 * 60_000;
const MAX_SEEN = 1000;
interface Job {
  key: string; chat: string; controller: AbortController;
  run: (signal: AbortSignal) => Promise<void>;
  resolve: () => void; reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** One worker, bounded waiting, and chat-scoped cancellation. */
export class VoiceQueue {
  private waiting: Job[] = [];
  private active?: Job;
  private seen = new Map<string, number>();
  private idleWaiters: Array<() => void> = [];

  enqueue(key: string, chat: string, limits: { maxQueuedJobs: number; maxQueueWaitMs: number }, run: Job['run']): Promise<void> {
    const now = Date.now();
    for (const [id, time] of this.seen) if (now - time > DEDUP_TTL_MS) this.seen.delete(id);
    if (this.seen.has(key) || this.active?.key === key || this.waiting.some(j => j.key === key)) return Promise.resolve();
    if (this.active && this.waiting.length >= limits.maxQueuedJobs) return Promise.reject(new Error('Voice queue is full; try again shortly'));
    this.seen.set(key, now);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value!);
    return new Promise<void>((resolve, reject) => {
      const job: Job = { key, chat, run, resolve, reject, controller: new AbortController() };
      job.timer = setTimeout(() => {
        this.waiting = this.waiting.filter(j => j !== job);
        reject(new Error('Voice queue wait expired; send the recording again'));
      }, limits.maxQueueWaitMs);
      this.waiting.push(job);
      void this.drain();
    });
  }

  cancel(chat?: string): number {
    let count = 0;
    if (this.active && (chat === undefined || this.active.chat === chat)) { this.active.controller.abort(); count++; }
    this.waiting = this.waiting.filter(job => {
      if (chat !== undefined && job.chat !== chat) return true;
      clearTimeout(job.timer); job.controller.abort(); job.resolve(); count++; return false;
    });
    return count;
  }

  async idle(): Promise<void> {
    if (!this.active && !this.waiting.length) return;
    await new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    const job = this.waiting.shift();
    if (!job) { for (const resolve of this.idleWaiters.splice(0)) resolve(); return; }
    this.active = job;
    clearTimeout(job.timer);
    try { await job.run(job.controller.signal); job.resolve(); }
    catch (error) {
      if (job.controller.signal.aborted) job.resolve();
      else job.reject(error instanceof Error ? error : new Error('Voice processing failed'));
    } finally { this.active = undefined; void this.drain(); }
  }
}

export const voiceQueue = new VoiceQueue();
