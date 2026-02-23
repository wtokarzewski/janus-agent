import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';

export class WriteFileTool implements ContextualTool {
  name = 'write_file';
  description = 'Write content to a file. Creates parent directories if they do not exist. Overwrites existing files.';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to workspace or absolute)' },
      content: { type: 'string', description: 'Content to write to the file' },
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

    const fullPath = resolve(this.workspaceDir, filePath);

    try {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      return `File written: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
