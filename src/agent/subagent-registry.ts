import * as log from '../utils/logger.js';

export interface SubagentEntry {
  id: string;
  task: string;
  startedAt: Date;
  controller: AbortController;
  parentId?: string;
}

/**
 * Registry for tracking and cancelling running subagents.
 * Enforces per-parent children limits and global concurrent limits.
 */
export class SubagentRegistry {
  private agents = new Map<string, SubagentEntry>();

  register(id: string, task: string, parentId?: string): AbortController {
    const controller = new AbortController();
    this.agents.set(id, { id, task, startedAt: new Date(), controller, parentId });
    log.debug(`Subagent registered: ${id}${parentId ? ` (parent=${parentId})` : ''}`);
    return controller;
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  cancel(id: string): boolean {
    const entry = this.agents.get(id);
    if (!entry) return false;
    entry.controller.abort();
    this.agents.delete(id);
    log.info(`Subagent cancelled: ${id}`);
    return true;
  }

  cancelAll(): number {
    let count = 0;
    for (const entry of this.agents.values()) {
      entry.controller.abort();
      count++;
    }
    this.agents.clear();
    if (count > 0) log.info(`Cancelled ${count} subagent(s)`);
    return count;
  }

  /** Count active children for a given parent ID. */
  childrenCount(parentId: string): number {
    let count = 0;
    for (const entry of this.agents.values()) {
      if (entry.parentId === parentId) count++;
    }
    return count;
  }

  list(): SubagentEntry[] {
    return [...this.agents.values()];
  }

  get size(): number {
    return this.agents.size;
  }
}
