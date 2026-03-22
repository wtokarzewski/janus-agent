import { AsyncQueue } from './async-queue.js';
import type { InboundMessage, OutboundMessage, Lane } from './types.js';

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
  private processingChats = new Set<string>();

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
  streamTo(channel: string, chatId: string, type: 'chunk' | 'stream_end' | 'typing', content = ''): void {
    const handler = this.handlers.get(channel);
    if (!handler) return;

    const msg: OutboundMessage = { chatId, channel, content, timestamp: new Date(), type };
    handler(msg).catch(err => {
      console.error(`Bus: stream handler for "${channel}" failed:`, err instanceof Error ? err.message : String(err));
    });
  }

  // --- Steering: mid-iteration user messages ---

  /** Mark a chat as being processed by the agent loop. */
  markProcessing(chatId: string): void {
    this.processingChats.add(chatId);
  }

  /** Clear processing state; re-queue any undrained steering messages as inbound. */
  clearProcessing(chatId: string): void {
    this.processingChats.delete(chatId);
    const pending = this.steering.get(chatId);
    if (pending && pending.length > 0) {
      this.steering.delete(chatId);
      for (const msg of pending) {
        const lane = msg.lane ?? 'user';
        const queue = this.inboundLanes.get(lane) ?? this.inboundLanes.get('user')!;
        queue.publish(msg).catch(() => {});
      }
    }
  }

  /** Check if a chat is currently being processed. */
  isProcessing(chatId: string): boolean {
    return this.processingChats.has(chatId);
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
          await handler(msg).catch(err => {
            console.error(`Bus: handler for "${msg.channel}" failed:`, err instanceof Error ? err.message : String(err));
          });
        } else {
          // System channel responses (cron/heartbeat) are handled internally by processSystemMessage() —
          // outbound messages to "system" channel are expected to be dropped here (no external subscriber).
          if (msg.channel !== 'system') {
            console.warn(`Bus: no handler for channel "${msg.channel}", message dropped`);
          }
        }
      } catch {
        if (signal.aborted) break;
      }
    }
  }
}
