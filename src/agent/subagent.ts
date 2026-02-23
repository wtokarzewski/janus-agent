import { AgentLoop } from './agent-loop.js';
import type { AgentDeps } from './agent-loop.js';
import * as log from '../utils/logger.js';

export interface SubagentConfig {
  task: string;
  maxIterations?: number;
}

/**
 * Spawn an isolated child agent for a subtask.
 * Uses processDirect() with a unique session key.
 * Returns the agent's response as a string.
 */
export async function spawnSubagent(
  parentDeps: AgentDeps,
  config: SubagentConfig,
): Promise<string> {
  const maxIterations = config.maxIterations ?? parentDeps.config.agent.maxSubagentIterations;
  const sessionKey = `sub-${Date.now()}`;

  log.info(`Subagent spawned: "${config.task.slice(0, 80)}" (maxIter=${maxIterations})`);

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

  const result = await childAgent.processDirect(config.task, {
    channel: 'system',
    chatId: sessionKey,
    contextMode: 'minimal',
  });

  log.info(`Subagent finished: "${config.task.slice(0, 40)}..." → ${result.length} chars`);
  return result;
}
