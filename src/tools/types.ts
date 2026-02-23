import type { ToolDefinition } from '../llm/types.js';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ContextualTool extends Tool {
  setContext(ctx: ToolContext): void;
}

export interface ToolContext {
  workspaceDir: string;
  execDenyPatterns?: string[];
  execTimeout?: number;
  maxFileSize?: number;
  // Multi-user fields
  chatId?: string;
  userId?: string;
  userToolAllow?: string[];
  userToolDeny?: string[];
  // Schema-only for now (no enforcement in this phase)
  toolPolicy?: {
    maxRecencyDays?: number;
    domainsAllow?: string[];
    domainsDeny?: string[];
    contentRating?: 'G' | 'PG' | 'PG13' | 'R';
  };
}

export function isContextualTool(tool: Tool): tool is ContextualTool {
  return 'setContext' in tool;
}

export function toolToDefinition(tool: Tool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
