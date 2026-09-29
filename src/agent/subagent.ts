import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../tools/types.js';
import { AgentLoop } from './agent-loop.js';
import type { AgentDeps } from './agent-loop.js';
import type { SubagentRegistry } from './subagent-registry.js';
import * as log from '../utils/logger.js';

export interface SubagentConfig {
  task: string;
  parentContext?: RequestContext;
  parentId?: string;
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
  const sessionKey = `sub-${randomUUID()}`;
  const id = sessionKey;
  const parent = config.parentContext;
  if (!parent || (parentDeps.config.users.length > 0 && !parent.userId)) {
    return { id, result: 'Error: Trusted parent identity is required for delegation.' };
  }
  const depth = parent.spawnDepth ?? config.depth ?? 0;
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

  const parentId = parent.runId ?? config.parentId;
  if (registry && parentId && registry.childrenCount(parentId) >= limits.maxChildrenPerAgent) {
    return { id, result: `Error: Maximum children per agent (${limits.maxChildrenPerAgent}) reached.` };
  }
  const controller = registry?.register(id, config.task, parentId);
  const signals = [parent.signal, config.signal, controller?.signal].filter((s): s is AbortSignal => !!s);
  const signal = signals.length ? AbortSignal.any(signals) : undefined;

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
      user: parent.user ?? (parent.userId ? { userId: parent.userId } : undefined),
      scope: parent.scope,
      agentId: parent.agentId,
      parentContext: parent,
      runId: id,
      signal,
    });

    // Extract partial progress if subagent was stopped/cancelled
    if (result === 'Stopped.' || result === 'Cancelled before start') {
      const history = await parentDeps.sessions.getHistory(`${parent.agentId ?? 'main'}:system:${sessionKey}`);
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
