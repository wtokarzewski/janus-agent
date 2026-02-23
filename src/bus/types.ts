export interface InboundMessage {
  id: string;
  channel: string;
  chatId: string;
  content: string;
  author: string;
  timestamp: Date;
  contextMode?: 'full' | 'minimal';
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
}

export interface OutboundMessage {
  chatId: string;
  channel: string;
  content: string;
  timestamp: Date;
  type?: 'message' | 'chunk' | 'stream_end';
}
