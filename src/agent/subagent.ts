import { AgentLoop } from './agent-loop.js';
import type { AgentDeps } from './agent-loop.js';
import type { SubagentRegistry } from './subagent-registry.js';
import * as log from '../utils/logger.js';

export interface SubagentConfig {
  task: string;
  maxIterations?: number;
  signal?: AbortSignal;
}

/**
 * Spawn an isolated child agent for a subtask.
 * Uses processDirect() with a unique session key.
 * Returns the agent's response as a string.
 */
export async function spawnSubagent(
  parentDeps: AgentDeps,
  config: SubagentConfig,
  registry?: SubagentRegistry,
): Promise<{ id: string; result: string }> {
  const maxIterations = config.maxIterations ?? parentDeps.config.agent.maxSubagentIterations;
  const sessionKey = `sub-${Date.now()}`;
  const id = sessionKey;

  // Register with registry if available
  const controller = registry?.register(id, config.task);
  const signal = config.signal ?? controller?.signal;

  log.info(`Subagent spawned: "${config.task.slice(0, 80)}" (id=${id}, maxIter=${maxIterations})`);

  // Create a child config with limited iterations
  const childConfig = {
    ...parentDeps.config,
    agent: {
      ...parentDeps.config.agent,
      maxIterations,
    },
  };

  const childAgent = new AgentLoop({
    ...parentDeps,
    config: childConfig,
  });

  try {
    // Check if already cancelled
    if (signal?.aborted) {
      return { id, result: 'Cancelled before start' };
    }

    const result = await childAgent.processDirect(config.task, {
      channel: 'system',
      chatId: sessionKey,
      contextMode: 'minimal',
      signal,
    });

    log.info(`Subagent finished: "${config.task.slice(0, 40)}..." → ${result.length} chars`);
    return { id, result };
  } finally {
    registry?.unregister(id);
  }
}
