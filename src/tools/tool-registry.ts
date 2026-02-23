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
    return Array.from(this.tools.values()).map(toolToDefinition);
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Return name + description for each tool (for system prompt). */
  summaries(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map(t => ({
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

    log.debug(`Executing tool: ${name}`, args);

    try {
      const result = await tool.execute(args);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Tool "${name}" failed: ${msg}`);
      return `Error: ${msg}`;
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
