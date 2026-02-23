import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContextualTool, ToolContext } from '../types.js';

export class EditFileTool implements ContextualTool {
  name = 'edit_file';
  description = 'Edit a file by replacing a specific string with a new string. The old_string must match exactly (including whitespace/indentation).';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      old_string: { type: 'string', description: 'The exact string to find and replace' },
      new_string: { type: 'string', description: 'The replacement string' },
    },
    required: ['path', 'old_string', 'new_string'],
  };

  private workspaceDir = process.cwd();

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = String(args.path ?? '');
    const oldString = String(args.old_string ?? '');
    const newString = String(args.new_string ?? '');
    if (!filePath) return 'Error: No path provided';
    if (!oldString) return 'Error: No old_string provided';

    const fullPath = resolve(this.workspaceDir, filePath);

    try {
      const content = await readFile(fullPath, 'utf-8');

      const count = content.split(oldString).length - 1;
      if (count === 0) {
        return `Error: old_string not found in ${filePath}`;
      }
      if (count > 1) {
        return `Error: old_string found ${count} times in ${filePath}. Provide more context to make it unique.`;
      }

      const newContent = content.replace(oldString, newString);
      await writeFile(fullPath, newContent, 'utf-8');
      return `File edited: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
