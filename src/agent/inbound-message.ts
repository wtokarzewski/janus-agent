import type { InboundMessage } from '../bus/types.js';
import type { LLMMessage } from '../llm/types.js';

/** Keep input conversion identical for the initial message and mid-turn additions. */
export function toUserMessage(msg: InboundMessage, prefix = ''): LLMMessage {
  let text = msg.replyContext ? `[Reply to ${msg.replyContext}]\n\n${msg.content}` : msg.content;
  if (msg.scope?.kind === 'family' || msg.channelMessageId !== undefined) {
    const source = JSON.stringify({
      id: msg.id, messageId: msg.channelMessageId,
      sender: msg.user?.userId ?? msg.author, name: msg.user?.name,
    });
    text = `[Message source: ${source}]\n${text}`;
  }
  if (prefix) text = `${prefix}\n\n${text}`;
  return {
    role: 'user',
    content: msg.images?.length ? [
      { type: 'text', text },
      ...msg.images.map(image => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mimeType, data: image.data },
      })),
    ] : text,
  };
}

export function sameSteeringIdentity(active: InboundMessage, next: InboundMessage): boolean {
  return active.channel === next.channel && active.chatId === next.chatId
    && active.topicId === next.topicId
    && active.user?.userId === next.user?.userId
    && (active.user?.userId !== undefined || active.author === next.author)
    && active.scope?.kind === next.scope?.kind && active.scope?.id === next.scope?.id;
}
