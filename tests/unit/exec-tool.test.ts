import { describe, it, expect } from 'vitest';
import { ExecTool } from '../../src/tools/builtin/exec.js';

describe('ExecTool', () => {
  function makeTool(opts: { timeout?: number } = {}): ExecTool {
    const tool = new ExecTool();
    tool.setContext({
      workspaceDir: process.cwd(),
      execTimeout: opts.timeout ?? 5000,
    });
    return tool;
  }

  it('runs a simple command', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: 'echo hello' });
    expect(result.trim()).toBe('hello');
  });

  it('captures stderr', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: 'echo err >&2' });
    expect(result.trim()).toBe('err');
  });

  it('captures both stdout and stderr', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: 'echo out && echo err >&2' });
    expect(result).toContain('out');
    expect(result).toContain('err');
  });

  it('returns error for empty command', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: '' });
    expect(result).toBe('Error: No command provided');
  });

  it('blocks denied patterns', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: 'rm -rf /' });
    expect(result).toContain('blocked by safety rules');
  });

  it('times out and kills process group', async () => {
    const tool = makeTool({ timeout: 500 });
    const result = await tool.execute({ command: 'sleep 60' });
    expect(result).toContain('timed out');
  }, 10_000);

  it('returns no output marker for silent commands', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: 'true' });
    expect(result).toBe('(no output)');
  });

  it('restricts working_dir to workspace', async () => {
    const tool = makeTool();
    const result = await tool.execute({ command: 'pwd', working_dir: '../../' });
    expect(result).toContain('working_dir must be inside workspace');
  });
});
