import { describe, it, expect } from 'vitest';
import { SubagentRegistry } from '../../src/agent/subagent-registry.js';

describe('SubagentRegistry', () => {
  it('should register and unregister agents', () => {
    const registry = new SubagentRegistry();
    registry.register('sub-1', 'task 1');
    expect(registry.size).toBe(1);
    registry.unregister('sub-1');
    expect(registry.size).toBe(0);
  });

  it('should cancel a specific agent', () => {
    const registry = new SubagentRegistry();
    const ctrl = registry.register('sub-1', 'task 1');
    expect(ctrl.signal.aborted).toBe(false);
    const cancelled = registry.cancel('sub-1');
    expect(cancelled).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('should cancel all agents', () => {
    const registry = new SubagentRegistry();
    const ctrl1 = registry.register('sub-1', 'task 1');
    const ctrl2 = registry.register('sub-2', 'task 2');
    const count = registry.cancelAll();
    expect(count).toBe(2);
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('should track children per parent', () => {
    const registry = new SubagentRegistry();
    registry.register('sub-1', 'task 1', 'parent-a');
    registry.register('sub-2', 'task 2', 'parent-a');
    registry.register('sub-3', 'task 3', 'parent-b');

    expect(registry.childrenCount('parent-a')).toBe(2);
    expect(registry.childrenCount('parent-b')).toBe(1);
    expect(registry.childrenCount('parent-c')).toBe(0);
  });

  it('should decrease children count on unregister', () => {
    const registry = new SubagentRegistry();
    registry.register('sub-1', 'task 1', 'parent-a');
    registry.register('sub-2', 'task 2', 'parent-a');
    expect(registry.childrenCount('parent-a')).toBe(2);

    registry.unregister('sub-1');
    expect(registry.childrenCount('parent-a')).toBe(1);
  });

  it('should list all agents', () => {
    const registry = new SubagentRegistry();
    registry.register('sub-1', 'research', 'parent-a');
    registry.register('sub-2', 'analyze');
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list[0].task).toBe('research');
    expect(list[0].parentId).toBe('parent-a');
    expect(list[1].parentId).toBeUndefined();
  });

  it('should return false when cancelling non-existent agent', () => {
    const registry = new SubagentRegistry();
    expect(registry.cancel('non-existent')).toBe(false);
  });
});
