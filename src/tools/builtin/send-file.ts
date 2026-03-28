import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ContextualTool, ToolContext, RequestContext } from '../types.js';
import type { MessageBus } from '../../bus/message-bus.js';
import { validatePath, validateUserFileAccess } from '../validate-path.js';

/**
 * Send a file to a specific channel and chat.
 * Uses Telegram's sendDocument/sendPhoto/sendAudio/sendVideo APIs.
 */
export class SendFileTool implements ContextualTool {
  name = 'send_file';
  description = 'Send a file to a specific channel and chat. Use for sharing documents, photos, audio, or video files with users.';
  parameters = {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Target channel (e.g. "telegram", "cli")' },
      chat_id: { type: 'string', description: 'Target chat ID within the channel' },
      path: { type: 'string', description: 'Path to the file (relative to workspace or absolute)' },
      file_type: {
        type: 'string',
        enum: ['document', 'photo', 'audio', 'video', 'voice'],
        description: 'Type of file — affects how it is displayed. "voice" sends as Telegram voice bubble (OGG Opus). Default: document',
      },
      caption: { type: 'string', description: 'Optional caption for the file' },
    },
    required: ['channel', 'chat_id', 'path'],
  };

  private bus: MessageBus;
  private workspaceDir = process.cwd();
  private maxFileSize = 50_000_000; // 50 MB (Telegram limit)

  constructor(bus: MessageBus) {
    this.bus = bus;
  }

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
  }

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const channel = String(args.channel ?? '');
    const chatId = String(args.chat_id ?? '');
    const filePath = String(args.path ?? '');
    const fileType = String(args.file_type ?? 'document') as 'document' | 'photo' | 'audio' | 'video' | 'voice';
    const caption = args.caption ? String(args.caption) : '';

    if (!channel) return 'Error: No channel provided';
    if (!chatId) return 'Error: No chat_id provided';
    if (!filePath) return 'Error: No path provided';

    let fullPath: string;
    try {
      fullPath = validatePath(this.workspaceDir, filePath);
      validateUserFileAccess(this.workspaceDir, fullPath, reqCtx?.userId, reqCtx?.chatId, 'read');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const fileInfo = await stat(fullPath);
      if (fileInfo.isDirectory()) return 'Error: Path is a directory, not a file';
      if (fileInfo.size > this.maxFileSize) {
        return `Error: File too large (${(fileInfo.size / 1_000_000).toFixed(1)}MB). Telegram limit is 50MB.`;
      }
      if (fileInfo.size === 0) return 'Error: File is empty';
    } catch {
      return `Error: File not found: ${filePath}`;
    }

    await this.bus.publishOutbound({
      channel,
      chatId,
      content: caption,
      timestamp: new Date(),
      filePath: fullPath,
      fileType,
    });

    return `File "${basename(fullPath)}" sent to ${channel}:${chatId}`;
  }
}
