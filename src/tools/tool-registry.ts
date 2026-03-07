import type { ToolDefinition } from '../llm/types.js';
import type { Tool, ToolContext } from './types.js';
import type { PatternGate } from '../gates/pattern-gate.js';
import type { GateService } from '../gates/types.js';
import { isContextualTool, toolToDefinition } from './types.js';
import * as log from '../utils/logger.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private gate?: { patterns: PatternGate; service: GateService };
  private currentContext?: ToolContext;

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      log.warn(`Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
    log.debug(`Registered tool: ${tool.name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toolToDefinition);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Return name + description for each tool (for system prompt). */
  summaries(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(t => ({
        name: t.name,
        description: t.description,
      }));
  }

  setGate(patterns: PatternGate, service: GateService): void {
    this.gate = { patterns, service };
    log.debug('Gate system enabled');
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: Unknown tool "${name}". Available tools: ${this.names().join(', ')}`;
    }

    // Per-user allow/deny enforcement
    if (this.currentContext?.userToolAllow && !this.currentContext.userToolAllow.includes(name)) {
      log.info(`Tool "${name}" blocked: not in user allow list`);
      return `Error: Tool "${name}" is not available for this user.`;
    }
    if (this.currentContext?.userToolDeny?.includes(name)) {
      log.info(`Tool "${name}" blocked: in user deny list`);
      return `Error: Tool "${name}" is not available for this user.`;
    }
    // TODO: toolPolicy enforcement (maxRecencyDays, domainsAllow, domainsDeny, contentRating)

    // Gate check — ask user for confirmation before destructive actions
    if (this.gate && this.gate.patterns.shouldGate(name, args)) {
      const action = this.gate.patterns.formatAction(name, args);
      log.info(`Gate triggered: ${action}`);

      const allowed = await this.gate.service.confirm({ tool: name, action, args, chatId: this.currentContext?.chatId });
      if (!allowed) {
        log.info(`Gate denied: ${action}`);
        return `Action denied by user: ${action}`;
      }
      log.info(`Gate approved: ${action}`);
    }

    // Coerce args to match tool schema types (LLMs sometimes return "5" instead of 5)
    const coerced = coerceToolArgs(args, tool.parameters);

    log.debug(`Executing tool: ${name}`, coerced);

    try {
      const result = await tool.execute(coerced);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Tool "${name}" failed: ${msg}`);
      return `Error: ${msg}\n\n[Analyze the error above. Try a different approach if the same command failed before.]`;
    }
  }

  setContext(ctx: ToolContext): void {
    this.currentContext = ctx;
    for (const tool of this.tools.values()) {
      if (isContextualTool(tool)) {
        tool.setContext(ctx);
      }
    }
  }
}

/**
 * Coerce tool arguments to match the expected schema types.
 * LLMs sometimes return "5" (string) when the schema expects number,
 * or "true" (string) when it expects boolean.
 */
function coerceToolArgs(
  args: Record<string, unknown>,
  schema?: { properties?: Record<string, { type?: string }> },
): Record<string, unknown> {
  if (!schema?.properties) return args;

  const result = { ...args };
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in result) || result[key] == null) continue;
    const val = result[key];
    const expectedType = prop.type;

    if (expectedType === 'number' || expectedType === 'integer') {
      if (typeof val === 'string') {
        const n = Number(val);
        if (!Number.isNaN(n)) result[key] = n;
      }
    } else if (expectedType === 'boolean') {
      if (val === 'true') result[key] = true;
      else if (val === 'false') result[key] = false;
    }
  }
  return result;
}
