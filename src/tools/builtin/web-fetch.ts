import type { ContextualTool, ToolContext } from '../types.js';
import * as log from '../../utils/logger.js';
import { checkSsrf } from '../../utils/ssrf-guard.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 51_200; // 50 KB
const MAX_RESPONSE_BYTES = 2_097_152; // 2 MB — abort before reading huge responses into memory
const MAX_REDIRECTS = 5;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * web_fetch tool — fetches a URL and returns structured content.
 * HTML is converted to lightweight markdown. JSON is pretty-printed.
 */
export class WebFetchTool implements ContextualTool {
  name = 'web_fetch';
  description = 'Fetch a URL and return its content. HTML is converted to markdown. JSON is pretty-printed. Use reader="jina" for cleaner text extraction from complex web pages.';
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
      reader: {
        type: 'string',
        enum: ['native', 'jina'],
        description: 'Text extraction method. "native" (default) = built-in HTML→markdown. "jina" = Jina Reader API for cleaner extraction from complex pages.',
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

    // SSRF guard — block private/internal networks (S8)
    const ssrfError = checkSsrf(url);
    if (ssrfError) return `Error: ${ssrfError}`;

    const reader = String(args.reader ?? 'native');

    // Jina Reader — clean text extraction via r.jina.ai (T1)
    if (reader === 'jina') {
      return this.fetchViaJina(url);
    }

    const headers = (args.headers && typeof args.headers === 'object')
      ? args.headers as Record<string, string>
      : {};

    log.info(`web_fetch: ${url}`);

    try {
      const { response, finalUrl } = await fetchWithRedirectLimit(url, {
        timeoutMs: this.timeoutMs,
        maxRedirects: MAX_REDIRECTS,
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          ...headers,
        },
      });

      if (!response.ok) {
        if (response.status === 403 || response.status === 429) {
          return `Error: Blocked by ${new URL(finalUrl).hostname} (HTTP ${response.status}). Do not retry this site — give the user a direct link instead.`;
        }
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      // Check Content-Length before reading body to prevent OOM
      const contentLength = Number(response.headers.get('content-length') || '0');
      if (contentLength > MAX_RESPONSE_BYTES) {
        return `Error: Response too large (${(contentLength / 1_048_576).toFixed(1)}MB). Max is ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(0)}MB.`;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      if (bytes.length > MAX_RESPONSE_BYTES) {
        return `Error: Response too large (${(bytes.length / 1_048_576).toFixed(1)}MB). Max is ${(MAX_RESPONSE_BYTES / 1_048_576).toFixed(0)}MB.`;
      }

      let truncated = false;
      let raw: string;
      if (bytes.length > this.maxBytes) {
        raw = new TextDecoder().decode(bytes.slice(0, this.maxBytes));
        truncated = true;
      } else {
        raw = new TextDecoder().decode(bytes);
      }

      let text: string;
      let extractor: string;

      if (contentType.includes('json')) {
        try {
          text = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          text = raw;
        }
        extractor = 'json';
      } else if (contentType.includes('html')) {
        text = htmlToMarkdown(raw);
        // Detect CAPTCHA / bot-blocking pages
        if (isBlockingPage(raw, text)) {
          return `Error: Blocked by ${new URL(finalUrl).hostname} (CAPTCHA or bot detection). Do not retry this site — give the user a direct link instead.`;
        }
        extractor = 'html';
      } else {
        text = raw;
        extractor = 'raw';
      }

      if (truncated) {
        text += `\n\n[Truncated: ${bytes.length} bytes total, showing first ${this.maxBytes}]`;
      }

      return JSON.stringify({
        url: finalUrl,
        status: response.status,
        extractor,
        truncated,
        length: text.length,
        text,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        return `Error: Request timed out after ${this.timeoutMs}ms`;
      }
      return `Error: ${msg}`;
    }
  }

  private async fetchViaJina(url: string): Promise<string> {
    const jinaUrl = `https://r.jina.ai/${url}`;
    log.info(`web_fetch (jina): ${url}`);
    try {
      const response = await fetch(jinaUrl, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Accept: 'text/plain' },
      });
      if (!response.ok) {
        return `Error: Jina Reader returned HTTP ${response.status}`;
      }
      let text = await response.text();
      const truncated = text.length > this.maxBytes;
      if (truncated) {
        text = text.slice(0, this.maxBytes) + `\n\n[Truncated: showing first ${this.maxBytes} chars]`;
      }
      return JSON.stringify({
        url,
        status: response.status,
        extractor: 'jina',
        truncated,
        length: text.length,
        text,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: Jina Reader failed: ${msg}`;
    }
  }
}

/** Fetch with a manual redirect limit (native fetch follows indefinitely). */
async function fetchWithRedirectLimit(
  url: string,
  opts: { timeoutMs: number; maxRedirects: number; headers: Record<string, string> },
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url;
  let redirectCount = 0;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    while (true) {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        headers: opts.headers,
        redirect: 'manual',
      });

      const location = response.headers.get('location');
      if (location && response.status >= 300 && response.status < 400) {
        redirectCount++;
        if (redirectCount > opts.maxRedirects) {
          return { response, finalUrl: currentUrl }; // return last response
        }
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }

      return { response, finalUrl: currentUrl };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Convert HTML to lightweight markdown (links, headings, lists, paragraphs). */
function htmlToMarkdown(html: string): string {
  let text = html
    // Remove script, style, noscript content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Convert links: <a href="url">text</a> → [text](url)
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => {
    const label = stripTags(body).trim();
    return label ? `[${label}](${href})` : href;
  });

  // Convert headings: <h1>text</h1> → # text
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, body) => {
    const prefix = '#'.repeat(Math.min(6, Math.max(1, Number(level))));
    return `\n${prefix} ${stripTags(body).trim()}\n`;
  });

  // Convert list items: <li>text</li> → - text
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => {
    return `\n- ${stripTags(body).trim()}`;
  });

  // Block elements → newlines
  text = text.replace(/<\/(p|div|section|article|blockquote|tr)>/gi, '\n\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Strip remaining tags
  text = stripTags(text);

  // Collapse whitespace
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Detect CAPTCHA / bot-blocking pages from raw HTML + extracted text. */
function isBlockingPage(rawHtml: string, extractedText: string): boolean {
  const htmlLower = rawHtml.toLowerCase();
  const textLower = extractedText.toLowerCase();

  // CAPTCHA indicators in HTML
  const captchaSignals = [
    'captcha', 'recaptcha', 'hcaptcha', 'cf-challenge', 'challenge-platform',
    'just a moment', 'checking your browser', 'verify you are human',
    'ray id', 'cloudflare',
  ];
  const htmlMatches = captchaSignals.filter(s => htmlLower.includes(s));
  if (htmlMatches.length >= 2) return true;

  // Very short extracted text from a full HTML page = likely blocked
  if (rawHtml.length > 5000 && extractedText.trim().length < 200) return true;

  // Direct text indicators
  if (textLower.includes('access denied') || textLower.includes('please verify')
    || textLower.includes('enable javascript and cookies')) return true;

  return false;
}
