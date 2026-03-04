import type { ContextualTool, ToolContext } from '../types.js';
import * as log from '../../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 51_200; // 50 KB

/**
 * web_fetch tool — fetches a URL and returns the text content.
 * HTML tags are stripped to plain text. Respects configurable timeout and size limits.
 */
export class WebFetchTool implements ContextualTool {
  name = 'web_fetch';
  description = 'Fetch a URL and return its text content. HTML is stripped to plain text. Use for reading web pages, APIs, documentation.';
  parameters = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch.',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers (e.g. {"Accept": "application/json"}).',
      },
    },
    required: ['url'],
  };

  private timeoutMs = DEFAULT_TIMEOUT_MS;
  private maxBytes = DEFAULT_MAX_BYTES;

  setContext(ctx: ToolContext): void {
    this.timeoutMs = ctx.webFetchTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = ctx.webFetchMaxBytes ?? DEFAULT_MAX_BYTES;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    if (!url) return 'Error: No URL provided';

    try {
      new URL(url);
    } catch {
      return `Error: Invalid URL: ${url}`;
    }

    const headers = (args.headers && typeof args.headers === 'object')
      ? args.headers as Record<string, string>
      : {};

    log.info(`web_fetch: ${url}`);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Janus-Agent/1.0',
          ...headers,
        },
        redirect: 'follow',
      });

      clearTimeout(timer);

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let text: string;
      if (bytes.length > this.maxBytes) {
        text = new TextDecoder().decode(bytes.slice(0, this.maxBytes));
        text += `\n\n[Truncated: ${bytes.length} bytes total, showing first ${this.maxBytes}]`;
      } else {
        text = new TextDecoder().decode(bytes);
      }

      // Strip HTML tags if content is HTML
      if (contentType.includes('html')) {
        text = stripHtml(text);
      }

      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        return `Error: Request timed out after ${this.timeoutMs}ms`;
      }
      return `Error: ${msg}`;
    }
  }
}

/** Simple HTML → plain text (strip tags, decode basic entities, collapse whitespace). */
function stripHtml(html: string): string {
  return html
    // Remove script and style content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Block-level tags → newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
