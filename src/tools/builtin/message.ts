import type { Tool } from '../types.js';
import type { MessageBus } from '../../bus/message-bus.js';

/**
 * Message tool — allows agent to send messages to specific channel:chatId.
 * Required for multi-channel: agent can reply to a different channel than the one it received from.
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

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
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

    return `Message sent to ${channel}:${chatId}`;
  }
}
