export type Lane = 'user' | 'cron' | 'heartbeat';

export interface InboundMessage {
  id: string;
  channel: string;
  chatId: string;
  content: string;
  author: string;
  timestamp: Date;
  contextMode?: 'full' | 'minimal';
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
}

export interface OutboundMessage {
  chatId: string;
  channel: string;
  content: string;
  timestamp: Date;
  type?: 'message' | 'chunk' | 'stream_end';
}
