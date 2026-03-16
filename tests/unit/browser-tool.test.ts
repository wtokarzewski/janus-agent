import { describe, it, expect } from 'vitest';
import { BrowserOperatorTool } from '../../src/tools/builtin/browser-operator.js';

describe('BrowserOperatorTool', () => {
  const tool = new BrowserOperatorTool();

  it('has correct name and parameters', () => {
    expect(tool.name).toBe('browser');
    expect(tool.parameters.required).toEqual(['command']);
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('command');
    expect(props).toHaveProperty('args');
  });

  it('rejects unknown command', async () => {
    const result = await tool.execute({ command: 'invalidCmd' });
    expect(result).toContain('Error: Unknown browser command');
    expect(result).toContain('invalidCmd');
  });

  it('returns status without launching runtime', async () => {
    const result = await tool.execute({ command: 'status' });
    const status = JSON.parse(result);
    expect(status.runtimeState).toBe('idle');
  });

  it('closeBrowser resets failure counter when not running', async () => {
    const result = await tool.execute({ command: 'closeBrowser' });
    expect(result).toBe('Browser is not running. Failure counter reset.');
  });

  it('lists all valid commands in description', () => {
    expect(tool.description).toContain('snapshot');
    expect(tool.description).toContain('navigate');
    expect(tool.description).toContain('click');
    expect(tool.description).toContain('dismissCookies');
  });
});
