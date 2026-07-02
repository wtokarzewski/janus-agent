import { AsyncQueue } from './async-queue.js';
import type { InboundMessage, OutboundMessage, Lane } from './types.js';
import * as log from '../utils/logger.js';

export type OutboundHandler = (msg: OutboundMessage) => Promise<void>;

const ALL_LANES: Lane[] = ['user', 'cron', 'heartbeat'];

/**
 * MessageBus — decouples channels from agent loop.
 *
 * Inbound messages are routed to per-lane queues based on msg.lane.
 * Channels register handlers via registerHandler(channelName, handler).
 * startDispatcher() runs a background loop that routes OutboundMessages to the right handler.
 */
export class MessageBus {
  private inboundLanes: Map<Lane, AsyncQueue<InboundMessage>>;
  private outbound: AsyncQueue<OutboundMessage>;
  private handlers = new Map<string, OutboundHandler>();
  private steering = new Map<string, InboundMessage[]>();
  /** chatId → timestamp when markProcessing was called. Entries older than PROCESSING_TTL_MS are stale. */
  private processingChats = new Map<string, number>();
  private static readonly PROCESSING_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(maxSize = 100) {
    this.inboundLanes = new Map();
    for (const lane of ALL_LANES) {
      this.inboundLanes.set(lane, new AsyncQueue<InboundMessage>(maxSize));
    }
    this.outbound = new AsyncQueue<OutboundMessage>(maxSize);
  }

  publishInbound(msg: InboundMessage, signal?: AbortSignal): Promise<void> {
    const lane = msg.lane ?? 'user';
    const queue = this.inboundLanes.get(lane) ?? this.inboundLanes.get('user')!;
    // Telemetry for system lanes: a growing queue with no waiting consumer means
    // the lane's consumers are stuck or dead — the failure is otherwise silent.
    if (lane !== 'user') {
      log.info(`Bus: inbound → lane "${lane}" (queued=${queue.size}, waitingConsumers=${queue.pending})`);
      if (queue.size > 0 && queue.pending === 0) {
        log.warn(`Bus: lane "${lane}" has ${queue.size} unconsumed message(s) and no waiting consumer — lane may be wedged`);
      }
    }
    return queue.publish(msg, signal);
  }

  consumeInbound(signal?: AbortSignal, lane: Lane = 'user'): Promise<InboundMessage> {
    const queue = this.inboundLanes.get(lane) ?? this.inboundLanes.get('user')!;
    return queue.consume(signal);
  }

  publishOutbound(msg: OutboundMessage, signal?: AbortSignal): Promise<void> {
    return this.outbound.publish(msg, signal);
  }

  consumeOutbound(signal?: AbortSignal): Promise<OutboundMessage> {
    return this.outbound.consume(signal);
  }

  /** Register a channel handler for outbound routing. */
  registerHandler(channel: string, handler: OutboundHandler): void {
    this.handlers.set(channel, handler);
  }

  /** Check if any handlers are registered (used to decide dispatcher vs direct poll). */
  get hasHandlers(): boolean {
    return this.handlers.size > 0;
  }

  /** Get registered channel names (for dynamic channel resolution). */
  get registeredChannels(): string[] {
    return [...this.handlers.keys()];
  }

  /** Send directly to a channel handler, bypassing the queue. Used for streaming and typing. */
  streamTo(channel: string, chatId: string, type: 'chunk' | 'stream_end' | 'stream_flush' | 'typing', content = ''): void {
    const handler = this.handlers.get(channel);
    if (!handler) return;

    const msg: OutboundMessage = { chatId, channel, content, timestamp: new Date(), type };
    handler(msg).catch(err => {
      log.error(`Bus: stream handler for "${channel}" failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // --- Steering: mid-iteration user messages ---

  /** Mark a chat as being processed by the agent loop. */
  markProcessing(chatId: string): void {
    this.processingChats.set(chatId, Date.now());
  }

  /** Clear processing state; re-queue ONE pending steering message to maintain per-chat serialization. */
  clearProcessing(chatId: string): void {
    const pending = this.steering.get(chatId);
    if (pending && pending.length > 0) {
      // Re-queue only the FIRST message — remaining stay buffered.
      // Keep processingChats alive so new Telegram messages stay buffered
      // until the re-queued message calls markProcessing in processLaneMessage.
      const first = pending.shift()!;
      if (pending.length === 0) this.steering.delete(chatId);
      this.processingChats.set(chatId, Date.now());
      const lane = first.lane ?? 'user';
      const queue = this.inboundLanes.get(lane) ?? this.inboundLanes.get('user')!;
      queue.publish(first).catch(() => {});
    } else {
      this.processingChats.delete(chatId);
    }
  }

  /** Check if a chat is currently being processed. Auto-clears stale entries (>5 min). */
  isProcessing(chatId: string): boolean {
    const ts = this.processingChats.get(chatId);
    if (ts === undefined) return false;
    if (Date.now() - ts > MessageBus.PROCESSING_TTL_MS) {
      log.warn(`Stale processing state for chat ${chatId} (${Math.round((Date.now() - ts) / 60000)}m), auto-clearing`);
      this.clearProcessing(chatId);
      return false;
    }
    return true;
  }

  /** Buffer a steering message for a chat that is currently processing. */
  pushSteering(msg: InboundMessage): void {
    let buf = this.steering.get(msg.chatId);
    if (!buf) {
      buf = [];
      this.steering.set(msg.chatId, buf);
    }
    buf.push(msg);
  }

  /** Drain all buffered steering messages for a chat (returns and clears). */
  drainSteering(chatId: string): InboundMessage[] {
    const buf = this.steering.get(chatId);
    if (!buf || buf.length === 0) return [];
    this.steering.delete(chatId);
    return buf;
  }

  /**
   * Start outbound dispatcher — routes messages to registered handlers.
   * Run this as a background task. If no handler matches, the message is dropped
   * with a warning (the channel is not connected).
   */
  async startDispatcher(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const msg = await this.consumeOutbound(signal);
        const handler = this.handlers.get(msg.channel);
        if (handler) {
          await this.sendWithRetry(handler, msg, msg.channel);
        } else {
          if (msg.channel === 'system') {
            log.info(`Bus: system channel outbound dropped (expected — cron/heartbeat responses handled internally)`);
          } else {
            log.warn(`Bus: no handler for channel "${msg.channel}", message dropped`);
          }
        }
      } catch {
        if (signal.aborted) break;
      }
    }
  }

  /** Retry message delivery with exponential backoff (CR-BR). */
  private async sendWithRetry(handler: OutboundHandler, msg: OutboundMessage, channel: string, maxRetries = 3): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await handler(msg);
        return;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (attempt === maxRetries) {
          log.error(`Bus: handler for "${channel}" failed after ${maxRetries + 1} attempts, message to ${msg.chatId} dropped: ${errMsg}`);
          return;
        }
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        log.warn(`Bus: handler for "${channel}" failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${errMsg}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
}
