import type { ContextualTool, ToolContext } from '../types.js';
import * as log from '../../utils/logger.js';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESULTS = 5;

/**
 * web_search tool — searches the web using Brave Search API.
 * Returns top results with title, URL, and snippet.
 */
export class WebSearchTool implements ContextualTool {
  name = 'web_search';
  description = 'Search the web using Brave Search. Returns top 5 results with title, URL, and snippet. Requires BRAVE_API_KEY.';
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

  private apiKey: string;
  private timeoutMs = 10_000;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

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

    log.info(`web_search: "${query}" (count=${count})`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const url = `${BRAVE_SEARCH_URL}?q=${encodeURIComponent(query)}&count=${count}`;
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
      });

      clearTimeout(timer);

      if (!response.ok) {
        return `Error: Brave Search API returned HTTP ${response.status}`;
      }

      const data = await response.json() as BraveSearchResponse;
      const results = data.web?.results ?? [];

      if (results.length === 0) {
        return 'No results found.';
      }

      const formatted = results.map((r, i) => {
        const snippet = r.description
          ? r.description.replace(/<\/?[^>]+>/g, '') // strip HTML
          : '';
        return `${i + 1}. ${r.title}\n   ${r.url}\n   ${snippet}`;
      }).join('\n\n');

      return formatted;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        return `Error: Search timed out after ${this.timeoutMs}ms`;
      }
      return `Error: ${msg}`;
    }
  }
}

interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description?: string;
    }>;
  };
}
