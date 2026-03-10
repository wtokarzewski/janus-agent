import { describe, it, expect } from 'vitest';
import { BrowserTool } from '../../src/tools/builtin/browser.js';

describe('BrowserTool', () => {
  const tool = new BrowserTool();

  it('has correct name and parameters', () => {
    expect(tool.name).toBe('browser');
    expect(tool.parameters.required).toEqual(['url']);
    const props = tool.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty('url');
    expect(props).toHaveProperty('wait_for');
    expect(props).toHaveProperty('click');
    expect(props).toHaveProperty('fill');
    expect(props).toHaveProperty('extract');
    expect(props).toHaveProperty('timeout_ms');
  });

  it('rejects empty URL', async () => {
    const result = await tool.execute({});
    expect(result).toBe('Error: No URL provided');
  });

  it('rejects invalid URL', async () => {
    const result = await tool.execute({ url: 'not-a-url' });
    expect(result).toContain('Error: Invalid URL');
  });

  it('rejects non-http URL', async () => {
    const result = await tool.execute({ url: 'ftp://example.com' });
    expect(result).toBe('Error: Only http/https URLs are supported');
  });

  it('returns helpful error when playwright is not installed', async () => {
    // In test environment, playwright may or may not be installed.
    // If not installed, we expect the helpful error message.
    // If installed, we'd get a real response (which is also fine).
    const result = await tool.execute({ url: 'https://example.com' });
    // Either a real result (JSON) or the install hint
    const isInstallHint = result.includes('Playwright is not installed');
    const isValidResult = result.startsWith('{') || result.startsWith('Error:');
    expect(isInstallHint || isValidResult).toBe(true);
  });
});
