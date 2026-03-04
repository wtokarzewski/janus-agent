import type { ContextualTool, ToolContext } from '../types.js';
import * as log from '../../utils/logger.js';

const DDG_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 5;

/**
 * web_search tool (DuckDuckGo fallback) — free, no API key required.
 * Scrapes DuckDuckGo HTML results page.
 */
export class WebSearchDDGTool implements ContextualTool {
  name = 'web_search';
  description = 'Search the web using DuckDuckGo. Returns top 5 results with title, URL, and snippet. No API key required.';
  parameters = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query.',
      },
      count: {
        type: 'number',
        description: 'Number of results to return (1-5, default: 5).',
      },
    },
    required: ['query'],
  };

  private timeoutMs = 10_000;

  setContext(ctx: ToolContext): void {
    this.timeoutMs = ctx.webFetchTimeoutMs ?? 10_000;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    if (!query) return 'Error: No search query provided';

    const count = Math.min(
      Math.max(typeof args.count === 'number' ? args.count : MAX_RESULTS, 1),
      MAX_RESULTS,
    );

    log.info(`web_search [ddg]: "${query}" (count=${count})`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(DDG_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Janus-Agent/1.0',
        },
        body: `q=${encodeURIComponent(query)}`,
      });

      clearTimeout(timer);

      if (!response.ok) {
        return `Error: DuckDuckGo returned HTTP ${response.status}`;
      }

      const html = await response.text();
      const results = parseDDGResults(html, count);

      if (results.length === 0) {
        return 'No results found.';
      }

      return results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      ).join('\n\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        return `Error: Search timed out after ${this.timeoutMs}ms`;
      }
      return `Error: ${msg}`;
    }
  }
}

interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDDGResults(html: string, count: number): DDGResult[] {
  const results: DDGResult[] = [];

  // Match result blocks: <a class="result__a" href="...">title</a> ... <a class="result__snippet">snippet</a>
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = resultRegex.exec(html)) !== null && results.length < count) {
    const rawUrl = match[1];
    const title = stripTags(match[2]).trim();
    const snippet = stripTags(match[3]).trim();

    // DDG wraps URLs in a redirect — extract the actual URL
    const url = extractDDGUrl(rawUrl);
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

function extractDDGUrl(raw: string): string {
  // DDG format: //duckduckgo.com/l/?uddg=<encoded_url>&...
  const uddgMatch = raw.match(/uddg=([^&]+)/);
  if (uddgMatch) {
    try { return decodeURIComponent(uddgMatch[1]); } catch { /* fallback */ }
  }
  // Direct URL
  if (raw.startsWith('http')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
