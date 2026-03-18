import type { ToolDefinition } from '../llm/types.js';

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** If true, only users listed in config.ownerIds can use this tool. */
  ownerOnly?: boolean;
  execute(args: Record<string, unknown>, reqCtx?: RequestContext): Promise<string>;
}

export interface ContextualTool extends Tool {
  setContext(ctx: ToolContext): void;
}

export interface ToolContext {
  workspaceDir: string;
  execDenyPatterns?: string[];
  execTimeout?: number;
  maxFileSize?: number;
  // Web tools
  webFetchTimeoutMs?: number;
  webFetchMaxBytes?: number;
  cronDepth?: number;
  // Browser operator
  browserChromePath?: string;
  browserProfileDir?: string;
  browserHeadless?: boolean;
}

/** Per-request context — passed to execute(), not shared across lanes. */
export interface RequestContext {
  chatId?: string;
  userId?: string;
  /** Whether the current user is an owner (has elevated privileges). */
  isOwner?: boolean;
  /** User IDs of family members (set when in a family group chat). */
  familyUserIds?: string[];
  userToolAllow?: string[];
  userToolDeny?: string[];
  toolPolicy?: {
    maxRecencyDays?: number;
    domainsAllow?: string[];
    domainsDeny?: string[];
    contentRating?: 'G' | 'PG' | 'PG13' | 'R';
  };
  /** Tracks where the message tool sent during this turn (for dedup). */
  sentTargets?: Array<{ channel: string; chatId: string }>;
  /** Recent conversation messages (for cron context injection). */
  recentMessages?: string[];
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
