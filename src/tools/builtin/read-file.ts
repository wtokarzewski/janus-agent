import { readFile, stat } from 'node:fs/promises';
import type { ContextualTool, ToolContext } from '../types.js';
import { validatePath } from '../validate-path.js';

export class ReadFileTool implements ContextualTool {
  name = 'read_file';
  description = 'Read the contents of a file. Returns the full content or an error if the file does not exist.';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to workspace or absolute)' },
    },
    required: ['path'],
  };

  private workspaceDir = process.cwd();
  private maxSize = 1_048_576;

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
    if (ctx.maxFileSize) this.maxSize = ctx.maxFileSize;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    if (!filePath) return 'Error: No path provided';

    let fullPath: string;
    try {
      fullPath = validatePath(this.workspaceDir, filePath);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      // Check file size before reading to prevent OOM on huge files
      const fileInfo = await stat(fullPath);
      if (fileInfo.size > this.maxSize * 2) {
        return `Error: File too large (${(fileInfo.size / 1_048_576).toFixed(1)}MB). Max readable size is ${(this.maxSize / 1_048_576).toFixed(1)}MB.`;
      }

      const content = await readFile(fullPath, 'utf-8');
      if (content.length > this.maxSize) {
        return content.slice(0, this.maxSize) + '\n... (file truncated)';
      }
      return content || '(empty file)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
