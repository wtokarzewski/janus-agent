import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/agent-loop.js';
import { SubagentRegistry } from '../../src/agent/subagent-registry.js';

describe('stop command', () => {
  describe('AgentLoop.stop()', () => {
    it('returns cancelled: false when idle', () => {
      // Create a minimal AgentLoop (won't call run, so deps don't matter)
      const agent = new AgentLoop({} as any);
      const result = agent.stop();
      expect(result).toEqual({ cancelled: false });
    });

    it('aborts all iteration controllers when running', () => {
      const agent = new AgentLoop({} as any);

      // Simulate _iterationControllers being set (as run() would do)
      const controller = new AbortController();
      (agent as any)._iterationControllers.set('chat-1', controller);

      expect(controller.signal.aborted).toBe(false);
      const result = agent.stop();
      expect(result).toEqual({ cancelled: true });
      expect(controller.signal.aborted).toBe(true);
      // Controllers should be cleared
      expect((agent as any)._iterationControllers.size).toBe(0);
    });

    it('stops only the specified chatId', () => {
      const agent = new AgentLoop({} as any);
      const c1 = new AbortController();
      const c2 = new AbortController();
      (agent as any)._iterationControllers.set('chat-1', c1);
      (agent as any)._iterationControllers.set('chat-2', c2);

      const result = agent.stop('chat-1');
      expect(result).toEqual({ cancelled: true });
      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(false);
      expect((agent as any)._iterationControllers.size).toBe(1);
    });

    it('can be called multiple times safely', () => {
      const agent = new AgentLoop({} as any);
      const controller = new AbortController();
      (agent as any)._iterationControllers.set('chat-1', controller);

      agent.stop();
      // Second call when already stopped
      const result = agent.stop();
      expect(result).toEqual({ cancelled: false });
    });
  });

  describe('SubagentRegistry.cancelAll()', () => {
    it('returns 0 when no subagents', () => {
      const registry = new SubagentRegistry();
      expect(registry.cancelAll()).toBe(0);
    });

    it('cancels all registered subagents', () => {
      const registry = new SubagentRegistry();
      const c1 = registry.register('sub-1', 'task 1');
      const c2 = registry.register('sub-2', 'task 2');

      expect(c1.signal.aborted).toBe(false);
      expect(c2.signal.aborted).toBe(false);

      const count = registry.cancelAll();
      expect(count).toBe(2);
      expect(c1.signal.aborted).toBe(true);
      expect(c2.signal.aborted).toBe(true);
      expect(registry.size).toBe(0);
    });
  });
});
