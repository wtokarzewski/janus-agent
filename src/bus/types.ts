export type Lane = 'user' | 'cron' | 'heartbeat';

export interface ImageAttachment {
  /** Base64-encoded image data. */
  data: string;
  /** MIME type: image/jpeg, image/png, image/gif, image/webp. */
  mimeType: string;
}

export interface InboundMessage {
  id: string;
  channel: string;
  chatId: string;
  content: string;
  author: string;
  timestamp: Date;
  contextMode?: 'full' | 'minimal' | 'background';
  cronDepth?: number;
  user?: {
    userId: string;
    name?: string;
    channelUserId?: string;
    channelUsername?: string;
  };
  scope?: {
    kind: 'user' | 'family';
    id: string;
  };
  lane?: Lane;
  /** Telegram forum topic ID (message_thread_id). Only set for forum-enabled supergroups. */
  topicId?: number;
  /** Images attached to this message (photos from Telegram, etc.). */
  images?: ImageAttachment[];
  /** Text of the message being replied to (e.g. Telegram reply-to). */
  replyContext?: string;
  /** Whether this message originated from voice transcription (for auto-TTS replies). */
  isVoice?: boolean;
  /** Resolved agent ID (set during processing, not by channels). */
  agentId?: string;
  /** Channel-specific routing metadata for binding resolution.
   *  Telegram: { topicId }. Discord: { guildId }. Slack: { teamId }. */
  routingMeta?: Record<string, string | number>;
}

export interface OutboundMessage {
  chatId: string;
  channel: string;
  content: string;
  timestamp: Date;
  type?: 'message' | 'chunk' | 'stream_end' | 'typing' | 'typing_stop';
  /** Absolute path to file for send_file tool. */
  filePath?: string;
  /** How to send the file (affects Telegram API method). */
  fileType?: 'document' | 'photo' | 'audio' | 'video' | 'voice';
  /** When true, the text content should also be sent as a voice message (TTS). */
  voiceReply?: boolean;
}
