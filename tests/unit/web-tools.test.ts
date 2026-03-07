import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getCache, setCache } from '../../src/tools/builtin/web-cache.js';

describe('web-cache', () => {
  it('returns null for missing key', () => {
    expect(getCache('nonexistent-key-12345')).toBeNull();
  });

  it('stores and retrieves a value', () => {
    setCache('test-cache-key-1', 'hello');
    expect(getCache('test-cache-key-1')).toBe('hello');
  });

  it('is case-insensitive', () => {
    setCache('Test-Key-CI', 'value');
    expect(getCache('test-key-ci')).toBe('value');
    expect(getCache('TEST-KEY-CI')).toBe('value');
  });

  it('returns null after TTL expires', () => {
    vi.useFakeTimers();
    setCache('ttl-test-key', 'data', 1000);
    expect(getCache('ttl-test-key')).toBe('data');

    vi.advanceTimersByTime(1001);
    expect(getCache('ttl-test-key')).toBeNull();
    vi.useRealTimers();
  });

  it('does not store when ttl is 0', () => {
    setCache('zero-ttl-key', 'data', 0);
    expect(getCache('zero-ttl-key')).toBeNull();
  });
});

describe('htmlToMarkdown', () => {
  // We need to import the private function indirectly through the tool
  // Instead, we test via the WebFetchTool with mocked fetch

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function fetchHtml(html: string): Promise<string> {
    const { WebFetchTool } = await import('../../src/tools/builtin/web-fetch.js');
    const tool = new WebFetchTool();

    // Mock fetch to return our HTML
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(html).buffer),
    });

    const result = await tool.execute({ url: 'https://example.com' });
    return JSON.parse(result).text;
  }

  it('converts links to markdown', async () => {
    const text = await fetchHtml('<a href="https://example.com">Click here</a>');
    expect(text).toContain('[Click here](https://example.com)');
  });

  it('converts headings to markdown', async () => {
    const text = await fetchHtml('<h1>Title</h1><h2>Subtitle</h2>');
    expect(text).toContain('# Title');
    expect(text).toContain('## Subtitle');
  });

  it('converts list items', async () => {
    const text = await fetchHtml('<ul><li>First</li><li>Second</li></ul>');
    expect(text).toContain('- First');
    expect(text).toContain('- Second');
  });

  it('strips script and style tags', async () => {
    const text = await fetchHtml('<script>alert("xss")</script><style>body{}</style><p>Content</p>');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('body{}');
    expect(text).toContain('Content');
  });

  it('decodes HTML entities', async () => {
    const text = await fetchHtml('<p>A &amp; B &lt; C &gt; D</p>');
    expect(text).toContain('A & B < C > D');
  });
});

describe('WebFetchTool', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns structured JSON output', async () => {
    const { WebFetchTool } = await import('../../src/tools/builtin/web-fetch.js');
    const tool = new WebFetchTool();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('Hello world').buffer),
    });

    const result = await tool.execute({ url: 'https://example.com' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('url');
    expect(parsed).toHaveProperty('status', 200);
    expect(parsed).toHaveProperty('extractor', 'raw');
    expect(parsed).toHaveProperty('truncated', false);
    expect(parsed).toHaveProperty('length');
    expect(parsed).toHaveProperty('text', 'Hello world');
  });

  it('pretty-prints JSON responses', async () => {
    const { WebFetchTool } = await import('../../src/tools/builtin/web-fetch.js');
    const tool = new WebFetchTool();

    const jsonBody = JSON.stringify({ key: 'value' });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(jsonBody).buffer),
    });

    const result = await tool.execute({ url: 'https://api.example.com/data' });
    const parsed = JSON.parse(result);
    expect(parsed.extractor).toBe('json');
    expect(parsed.text).toContain('"key": "value"');
  });

  it('rejects non-http URLs', async () => {
    const { WebFetchTool } = await import('../../src/tools/builtin/web-fetch.js');
    const tool = new WebFetchTool();
    const result = await tool.execute({ url: 'file:///etc/passwd' });
    expect(result).toContain('Only http/https');
  });

  it('rejects oversized Content-Length', async () => {
    const { WebFetchTool } = await import('../../src/tools/builtin/web-fetch.js');
    const tool = new WebFetchTool();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain', 'content-length': '10000000' }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const result = await tool.execute({ url: 'https://example.com/huge' });
    expect(result).toContain('too large');
  });

  it('follows redirects up to limit', async () => {
    const { WebFetchTool } = await import('../../src/tools/builtin/web-fetch.js');
    const tool = new WebFetchTool();

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (callCount <= 3) {
        return Promise.resolve({
          ok: false,
          status: 302,
          statusText: 'Found',
          headers: new Headers({ location: `https://example.com/redirect-${callCount}` }),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('Final').buffer),
      });
    });

    const result = await tool.execute({ url: 'https://example.com/start' });
    const parsed = JSON.parse(result);
    expect(parsed.text).toBe('Final');
    expect(parsed.url).toContain('redirect-3');
  });
});
