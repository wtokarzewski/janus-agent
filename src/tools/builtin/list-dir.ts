import { readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';

export class ListDirTool implements ContextualTool {
  name = 'list_dir';
  description = 'List files and directories in a given path. Shows type (file/dir) and size for each entry.';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (default: workspace root)' },
    },
    required: [],
  };

  private workspaceDir = process.cwd();

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const dirPath = String(args.path ?? '.');
    const fullPath = resolve(this.workspaceDir, dirPath);

    try {
      const entries = await readdir(fullPath);
      const lines: string[] = [];

      for (const entry of entries.sort()) {
        if (entry.startsWith('.') && entry !== '..') continue; // skip hidden

        try {
          const s = await stat(join(fullPath, entry));
          const type = s.isDirectory() ? 'dir ' : 'file';
          const size = s.isDirectory() ? '' : ` (${formatSize(s.size)})`;
          lines.push(`${type} ${entry}${size}`);
        } catch {
          lines.push(`???? ${entry}`);
        }
      }

      return lines.length > 0 ? lines.join('\n') : '(empty directory)';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
