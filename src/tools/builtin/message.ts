import type { Tool, RequestContext } from '../types.js';
import type { MessageBus } from '../../bus/message-bus.js';

/** Callback to inject a ghost message into the recipient's session. */
export type SessionInjector = (channel: string, chatId: string, content: string) => Promise<void>;

/**
 * Message tool — allows agent to send messages to specific channel:chatId.
 * Required for multi-channel: agent can reply to a different channel than the one it received from.
 *
 * When a sessionInjector is provided, delivered messages are also appended to the
 * recipient's session history so the agent remembers what it sent when the recipient replies.
 */
export class MessageTool implements Tool {
  name = 'message';
  description = 'Send a message to a specific channel and chat. Use this to communicate across channels or send follow-up messages.';
  parameters = {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Target channel (e.g. "cli", "telegram", "slack")' },
      chat_id: { type: 'string', description: 'Target chat ID within the channel' },
      content: { type: 'string', description: 'Message content to send' },
    },
    required: ['channel', 'chat_id', 'content'],
  };

  private bus: MessageBus;
  private injectToRecipient?: SessionInjector;

  constructor(bus: MessageBus, injectToRecipient?: SessionInjector) {
    this.bus = bus;
    this.injectToRecipient = injectToRecipient;
  }

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const channel = String(args.channel ?? '');
    const chatId = String(args.chat_id ?? '');
    const content = String(args.content ?? '');

    if (!channel) return 'Error: No channel provided';
    if (!chatId) return 'Error: No chat_id provided';
    if (!content) return 'Error: No content provided';

    await this.bus.publishOutbound({
      channel,
      chatId,
      content,
      timestamp: new Date(),
    });

    reqCtx?.sentTargets?.push({ channel, chatId });

    // Inject ghost message into recipient's session so the agent remembers
    // what it sent when the recipient replies later.
    // Skip if target is the same chat (no cross-session needed) or system channel.
    if (this.injectToRecipient && channel !== 'system' && reqCtx?.chatId !== chatId) {
      try {
        await this.injectToRecipient(channel, chatId, content);
      } catch {
        // Non-fatal — the message was still delivered
      }
    }

    return `Message sent to ${channel}:${chatId}`;
  }
}
