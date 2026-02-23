import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';

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

    const fullPath = resolve(this.workspaceDir, filePath);

    try {
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
