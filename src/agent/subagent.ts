import { AgentLoop } from './agent-loop.js';
import type { AgentDeps } from './agent-loop.js';
import type { SubagentRegistry } from './subagent-registry.js';
import * as log from '../utils/logger.js';

export interface SubagentConfig {
  task: string;
  signal?: AbortSignal;
  /** Current spawn depth (0 = top-level agent). */
  depth?: number;
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
  const sessionKey = `sub-${Date.now()}`;
  const id = sessionKey;
  const depth = config.depth ?? 0;
  const limits = parentDeps.config.agent.subagents;

  // Depth limit — prevent recursive spawning chains
  if (depth >= limits.maxSpawnDepth) {
    log.warn(`Subagent spawn rejected: depth ${depth} >= maxSpawnDepth ${limits.maxSpawnDepth}`);
    return { id, result: `Error: Maximum spawn depth (${limits.maxSpawnDepth}) reached. Cannot spawn nested subagents.` };
  }

  // Concurrent limit — prevent resource exhaustion
  if (registry && registry.size >= limits.maxConcurrentSubagents) {
    log.warn(`Subagent spawn rejected: ${registry.size} active >= maxConcurrentSubagents ${limits.maxConcurrentSubagents}`);
    return { id, result: `Error: Maximum concurrent subagents (${limits.maxConcurrentSubagents}) reached. Wait for existing subagents to finish.` };
  }

  // Children-per-parent limit — checked via registry
  // (parentId tracking is done in spawn_agent tool)

  // Register with registry if available
  const controller = registry?.register(id, config.task);
  const signal = config.signal ?? controller?.signal;

  log.info(`Subagent spawned: "${config.task.slice(0, 80)}" (id=${id}, depth=${depth})`);

  const childAgent = new AgentLoop({
    ...parentDeps,
    config: parentDeps.config,
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

    // Extract partial progress if subagent was stopped/cancelled
    if (result === 'Stopped.' || result === 'Cancelled before start') {
      const history = await parentDeps.sessions.getHistory(sessionKey);
      const progress = history
        .filter(m => m.role === 'assistant' && typeof m.content === 'string')
        .map(m => m.content as string)
        .filter(Boolean);
      if (progress.length > 0) {
        const partial = progress.join('\n---\n').slice(0, 5000);
        log.info(`Subagent partial progress: "${config.task.slice(0, 40)}..." → ${partial.length} chars before stop`);
        return { id, result: `[Partial progress before timeout]\n${partial}\n\n[Status: ${result}]` };
      }
    }

    log.info(`Subagent finished: "${config.task.slice(0, 40)}..." → ${result.length} chars`);
    return { id, result };
  } finally {
    registry?.unregister(id);
  }
}
