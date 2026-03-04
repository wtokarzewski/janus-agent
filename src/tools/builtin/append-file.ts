import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';
import { validatePath } from '../validate-path.js';

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

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const content = String(args.content ?? '');
    if (!filePath) return 'Error: No path provided';

    let fullPath: string;
    try {
      fullPath = validatePath(this.workspaceDir, filePath);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      await mkdir(dirname(fullPath), { recursive: true });
      await appendFile(fullPath, content, 'utf-8');
      return `Content appended to: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
