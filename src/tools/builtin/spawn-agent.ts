import type { Tool } from '../types.js';
import type { AgentDeps } from '../../agent/agent-loop.js';
import type { SubagentRegistry } from '../../agent/subagent-registry.js';
import { spawnSubagent } from '../../agent/subagent.js';

/**
 * spawn_agent tool — allows the agent to spawn isolated child agents for subtasks.
 * The child agent gets its own session and limited iterations.
 */
export class SpawnAgentTool implements Tool {
  name = 'spawn_agent';
  description = 'Spawn an isolated child agent to handle a subtask. The child agent has its own session and limited iterations. Use for independent subtasks that can be delegated (research, file analysis, etc.). Returns subagent ID + result.';
  parameters = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task description for the child agent. Be specific and self-contained — the child has no access to the parent conversation.',
      },
      max_iterations: {
        type: 'number',
        description: 'Maximum LLM iterations for the child agent. Default: 5.',
      },
    },
    required: ['task'],
  };

  private deps: AgentDeps;
  private registry?: SubagentRegistry;

  constructor(deps: AgentDeps, registry?: SubagentRegistry) {
    this.deps = deps;
    this.registry = registry;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const task = String(args.task ?? '');
    if (!task) return 'Error: No task provided';

    const maxIterations = typeof args.max_iterations === 'number' ? args.max_iterations : undefined;

    try {
      const { id, result } = await spawnSubagent(this.deps, { task, maxIterations }, this.registry);
      return `[subagent:${id}]\n${result}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: Subagent failed: ${msg}`;
    }
  }
}
