import { AsyncQueue } from './async-queue.js';
import type { InboundMessage, OutboundMessage } from './types.js';

export type OutboundHandler = (msg: OutboundMessage) => Promise<void>;

/**
 * MessageBus — decouples channels from agent loop.
 *
 * Channels register handlers via registerHandler(channelName, handler).
 * startDispatcher() runs a background loop that routes OutboundMessages to the right handler.
 */
export class MessageBus {
  private inbound: AsyncQueue<InboundMessage>;
  private outbound: AsyncQueue<OutboundMessage>;
  private handlers = new Map<string, OutboundHandler>();

  constructor(maxSize = 100) {
    this.inbound = new AsyncQueue<InboundMessage>(maxSize);
    this.outbound = new AsyncQueue<OutboundMessage>(maxSize);
  }

  publishInbound(msg: InboundMessage, signal?: AbortSignal): Promise<void> {
    return this.inbound.publish(msg, signal);
  }

  consumeInbound(signal?: AbortSignal): Promise<InboundMessage> {
    return this.inbound.consume(signal);
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

  /** Stream a chunk directly to a channel handler, bypassing the queue. */
  streamTo(channel: string, chatId: string, type: 'chunk' | 'stream_end', content = ''): void {
    const handler = this.handlers.get(channel);
    if (!handler) return;

    const msg: OutboundMessage = { chatId, channel, content, timestamp: new Date(), type };
    handler(msg).catch(err => {
      console.error(`Bus: stream handler for "${channel}" failed:`, err instanceof Error ? err.message : String(err));
    });
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
          console.warn(`Bus: no handler for channel "${msg.channel}", message dropped`);
        }
      } catch {
        if (signal.aborted) break;
      }
    }
  }
}
