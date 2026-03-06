import { describe, it, expect } from 'vitest';
import { SelfUpdateTool } from '../../src/tools/builtin/self-update.js';

describe('SelfUpdateTool', () => {
  function makeTool(overrides?: Partial<{ workspaceDir: string; onBeforeRestart: () => Promise<void> }>): SelfUpdateTool {
    return new SelfUpdateTool({
      workspaceDir: overrides?.workspaceDir ?? process.cwd(),
      onBeforeRestart: overrides?.onBeforeRestart,
    });
  }

  it('rejects invalid action', async () => {
    const tool = makeTool();
    const result = await tool.execute({ action: 'invalid' });
    expect(result).toContain('Error: action must be');
  });

  it('rejects missing action', async () => {
    const tool = makeTool();
    const result = await tool.execute({});
    expect(result).toContain('Error: action must be');
  });

  it('check returns update count from current repo', async () => {
    // This runs against the actual janus-agent repo — should succeed
    const tool = makeTool();
    const result = await tool.execute({ action: 'check' });
    // Could be "Already up to date." or "N update(s) available"
    expect(result).toMatch(/up to date|update\(s\) available/i);
  });

  it('detects Docker environment via env var', async () => {
    const origDocker = process.env.DOCKER;
    process.env.DOCKER = 'true';
    try {
      const tool = makeTool();
      const result = await tool.execute({ action: 'check' });
      expect(result).toContain('Docker');
    } finally {
      if (origDocker === undefined) {
        delete process.env.DOCKER;
      } else {
        process.env.DOCKER = origDocker;
      }
    }
  });

  it('returns error for non-git directory', async () => {
    const tool = makeTool({ workspaceDir: '/tmp' });
    const result = await tool.execute({ action: 'check' });
    expect(result).toContain('Not a git repository');
  });

  it('has correct tool metadata', () => {
    const tool = makeTool();
    expect(tool.name).toBe('self_update');
    expect(tool.parameters.required).toContain('action');
  });
});
