import { readFile, writeFile } from 'node:fs/promises';
import type { ContextualTool, ToolContext, RequestContext } from '../types.js';
import { validatePath, validateUserFileAccess } from '../validate-path.js';

interface EditPair {
  old_string: string;
  new_string: string;
}

export class EditFileTool implements ContextualTool {
  name = 'edit_file';
  description = 'Edit a file by replacing exact strings. Supports single edit (old_string/new_string) or multiple edits in one call (edits array). Each old_string must match exactly and be unique.';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      old_string: { type: 'string', description: 'The exact string to find and replace (single edit mode)' },
      new_string: { type: 'string', description: 'The replacement string (single edit mode)' },
      edits: {
        type: 'array',
        description: 'Multiple edits to apply in order (multi-edit mode). Each element has old_string and new_string.',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'The exact string to find and replace' },
            new_string: { type: 'string', description: 'The replacement string' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path'],
  };

  private workspaceDir = process.cwd();

  setContext(ctx: ToolContext): void {
    this.workspaceDir = ctx.workspaceDir;
  }

  async execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string> {
    const filePath = String(args.path ?? '');
    if (!filePath) return 'Error: No path provided';

    // Build list of edits: either from `edits` array or single old_string/new_string
    const edits = this.parseEdits(args);
    if (typeof edits === 'string') return edits; // error message

    let fullPath: string;
    try {
      fullPath = validatePath(this.workspaceDir, filePath);
      validateUserFileAccess(this.workspaceDir, fullPath, reqCtx?.userId, reqCtx?.chatId, 'write');
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      let content = await readFile(fullPath, 'utf-8');

      // Validate all edits before applying any (atomic — all or nothing)
      for (let i = 0; i < edits.length; i++) {
        const { old_string } = edits[i];
        const count = content.split(old_string).length - 1;
        if (count === 0) {
          return `Error: old_string not found in ${filePath}${edits.length > 1 ? ` (edit ${i + 1}/${edits.length})` : ''}`;
        }
        if (count > 1) {
          return `Error: old_string found ${count} times in ${filePath}${edits.length > 1 ? ` (edit ${i + 1}/${edits.length})` : ''}. Provide more context to make it unique.`;
        }
      }

      // Apply edits sequentially
      for (const { old_string, new_string } of edits) {
        content = content.replace(old_string, new_string);
      }

      await writeFile(fullPath, content, 'utf-8');
      return edits.length > 1
        ? `File edited: ${filePath} (${edits.length} edits applied)`
        : `File edited: ${filePath}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private parseEdits(args: Record<string, unknown>): EditPair[] | string {
    // Multi-edit mode
    if (Array.isArray(args.edits)) {
      const edits: EditPair[] = [];
      for (let i = 0; i < args.edits.length; i++) {
        const e = args.edits[i] as Record<string, unknown>;
        const old_string = String(e?.old_string ?? '');
        const new_string = String(e?.new_string ?? '');
        if (!old_string) return `Error: edits[${i}].old_string is empty`;
        edits.push({ old_string, new_string });
      }
      if (edits.length === 0) return 'Error: edits array is empty';
      return edits;
    }

    // Single edit mode
    const old_string = String(args.old_string ?? '');
    const new_string = String(args.new_string ?? '');
    if (!old_string) return 'Error: No old_string or edits provided';
    return [{ old_string, new_string }];
  }
}
