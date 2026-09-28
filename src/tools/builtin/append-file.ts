import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContextualTool, ToolContext, RequestContext } from '../types.js';
import { validatePath, validateUserFileAccess } from '../validate-path.js';

export class AppendFileTool implements ContextualTool {
  name = 'append_file';
  description = 'Append content to a file. Creates the file and parent directories if they do not exist.';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to workspace or absolute)' },
      content: { type: 'string', description: 'Content to append to the file' },
    },
    required: ['path', 'content'],
  };

  private workspaceDir = process.cwd();
  private onFileChanged?: ToolContext['onFileChanged'];

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
    this.onFileChanged = ctx.onFileChanged;
  }

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const filePath = String(args.path ?? '');
    const content = String(args.content ?? '');
    if (!filePath) return 'Error: No path provided';

    let fullPath: string;
    try {
      fullPath = validatePath(this.workspaceDir, filePath);
      validateUserFileAccess(this.workspaceDir, fullPath, reqCtx?.userId, reqCtx?.chatId, 'write');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      await mkdir(dirname(fullPath), { recursive: true });
      await appendFile(fullPath, content, 'utf-8');
      await this.onFileChanged?.(fullPath);
      return `Content appended to: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
