import type { Tool } from '../types.js';
import type { AgentDeps } from '../../agent/agent-loop.js';
import type { SubagentRegistry } from '../../agent/subagent-registry.js';
import { spawnSubagent } from '../../agent/subagent.js';

/**
 * spawn_agent tool — allows the agent to spawn isolated child agents for subtasks.
 * Enforces depth, children-per-parent, and concurrent subagent limits.
 */
export class SpawnAgentTool implements Tool {
  name = 'spawn_agent';
  description = 'Spawn an isolated child agent to handle a subtask. The child agent has its own session and works until the task is complete. Use for independent subtasks that can be delegated (research, file analysis, etc.). Returns subagent ID + result.';
  parameters = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task description for the child agent. Be specific and self-contained — the child has no access to the parent conversation.',
      },
    },
    required: ['task'],
  };

  private deps: AgentDeps;
  private registry?: SubagentRegistry;
  private depth: number;
  private parentId?: string;

  constructor(deps: AgentDeps, registry?: SubagentRegistry, depth = 0, parentId?: string) {
    this.deps = deps;
    this.registry = registry;
    this.depth = depth;
    this.parentId = parentId;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const task = String(args.task ?? '');
    if (!task) return 'Error: No task provided';

    const limits = this.deps.config.agent.subagents;

    // Children-per-parent limit
    if (this.registry && this.parentId) {
      const childCount = this.registry.childrenCount(this.parentId);
      if (childCount >= limits.maxChildrenPerAgent) {
        return `Error: Maximum children per agent (${limits.maxChildrenPerAgent}) reached. Wait for existing subagents to finish.`;
      }
    }

    try {
      const { id, result } = await spawnSubagent(
        this.deps,
        { task, depth: this.depth },
        this.registry,
      );
      return `[subagent:${id}]\n${result}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: Subagent failed: ${msg}`;
    }
  }
}
