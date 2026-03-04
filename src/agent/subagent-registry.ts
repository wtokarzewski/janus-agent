import * as log from '../utils/logger.js';

export interface SubagentEntry {
  id: string;
  task: string;
  startedAt: Date;
  controller: AbortController;
}

/**
 * Registry for tracking and cancelling running subagents.
 */
export class SubagentRegistry {
  private agents = new Map<string, SubagentEntry>();

  register(id: string, task: string): AbortController {
    const controller = new AbortController();
    this.agents.set(id, { id, task, startedAt: new Date(), controller });
    log.debug(`Subagent registered: ${id}`);
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

  list(): SubagentEntry[] {
    return [...this.agents.values()];
  }

  get size(): number {
    return this.agents.size;
  }
}
