import type { Tool, RequestContext } from '../types.js';
import type { MessageBus } from '../../bus/message-bus.js';

/**
 * React to a message with an emoji in the current conversation. Channel-agnostic:
 * publishes a 'reaction' outbound message; the channel decides how to render it.
 */
export class ReactTool implements Tool {
  name = 'react';
  description =
    'React with an emoji to a message in the current conversation (Telegram). ' +
    'Defaults to the message you are answering. Use standard reactions such as 👍 👎 ❤️ 🔥 👏 😁 🤔 🙏 👌 🎉. ' +
    'A reaction can be the whole answer — then reply with no text.';
  parameters = {
    type: 'object',
    properties: {
      emoji: { type: 'string', description: 'A single emoji, e.g. "👍"' },
      message_id: { type: 'number', description: 'Optional: react to this message ID instead of the current one' },
    },
    required: ['emoji'],
  };

  constructor(private bus: MessageBus) {}

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const emoji = typeof args.emoji === 'string' ? args.emoji.trim() : '';
    if (!emoji) return 'Error: No emoji provided';

    if (!reqCtx?.channel || !reqCtx.chatId || reqCtx.channelMessageId === undefined) {
      return 'Error: Reactions are only available when answering a chat message (e.g. Telegram)';
    }

    const reactTo = typeof args.message_id === 'number' ? args.message_id : reqCtx.channelMessageId;

    await this.bus.publishOutbound({
      channel: reqCtx.channel,
      chatId: reqCtx.chatId,
      content: emoji,
      timestamp: new Date(),
      type: 'reaction',
      reactTo,
    });
    return `Reacted ${emoji}`;
  }
}
