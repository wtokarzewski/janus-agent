/**
 * browser tool — headless Chromium via Playwright.
 *
 * Third escalation tier: web_search → web_fetch → browser.
 * Use when pages require JavaScript rendering, cookie walls, or SPA navigation.
 *
 * Playwright is an optional dependency — the tool returns a helpful error
 * if it's not installed.
 */

import type { Tool } from '../types.js';
import * as log from '../../utils/logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTENT_LENGTH = 100_000; // 100 KB text limit

export class BrowserTool implements Tool {
  name = 'browser';
  description =
    'Open a URL in a headless browser (Chromium). Use when web_fetch fails due to JavaScript rendering, cookie walls, or SPA pages. ' +
    'Can optionally wait for a selector, click elements, fill inputs, or take a screenshot. Returns page text content.';
  parameters = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to open.',
      },
      wait_for: {
        type: 'string',
        description: 'Optional CSS selector to wait for before extracting content (e.g. "#results", ".product-price").',
      },
      click: {
        type: 'string',
        description: 'Optional CSS selector of an element to click (e.g. cookie consent button). Executed before content extraction.',
      },
      fill: {
        type: 'object',
        description: 'Optional input to fill: { "selector": "CSS selector", "value": "text to type" }.',
        properties: {
          selector: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['selector', 'value'],
      },
      extract: {
        type: 'string',
        enum: ['text', 'html'],
        description: 'What to extract from the page: "text" (default) for readable text, "html" for raw HTML.',
      },
      timeout_ms: {
        type: 'number',
        description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`,
      },
    },
    required: ['url'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '');
    if (!url) return 'Error: No URL provided';

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: Invalid URL: ${url}`;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Error: Only http/https URLs are supported';
    }

    // Dynamic import — Playwright is optional (not in package.json)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let chromium: any;
    try {
      // Try playwright (includes browsers) first, then playwright-core (BYOB)
      // Use createRequire for ESM compatibility with optional deps
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      try {
        chromium = require('playwright').chromium;
      } catch {
        chromium = require('playwright-core').chromium;
      }
    } catch {
      return 'Error: Playwright is not installed. Run: npm install playwright && npx playwright install chromium';
    }

    const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
    const waitFor = typeof args.wait_for === 'string' ? args.wait_for : undefined;
    const clickSelector = typeof args.click === 'string' ? args.click : undefined;
    const fillSpec = args.fill && typeof args.fill === 'object' ? args.fill as { selector: string; value: string } : undefined;
    const extract = args.extract === 'html' ? 'html' : 'text';

    log.info(`browser: ${url}${waitFor ? ` (wait: ${waitFor})` : ''}`);

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      page.setDefaultTimeout(timeoutMs);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      // Click (e.g. cookie consent)
      if (clickSelector) {
        try {
          await page.click(clickSelector, { timeout: 5000 });
          // Brief wait for page to react
          await page.waitForTimeout(500);
        } catch (err) {
          log.debug(`browser: click "${clickSelector}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Fill input
      if (fillSpec?.selector && fillSpec?.value) {
        try {
          await page.fill(fillSpec.selector, fillSpec.value);
          await page.waitForTimeout(500);
        } catch (err) {
          log.debug(`browser: fill "${fillSpec.selector}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Wait for selector
      if (waitFor) {
        try {
          await page.waitForSelector(waitFor, { timeout: timeoutMs });
        } catch {
          log.debug(`browser: wait_for "${waitFor}" timed out, extracting current content`);
        }
      }

      // Extract content
      let content: string;
      if (extract === 'html') {
        content = await page.content();
      } else {
        content = await page.evaluate('document.body.innerText');
      }

      const finalUrl = page.url();
      let truncated = false;
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH);
        truncated = true;
      }

      return JSON.stringify({
        url: finalUrl,
        extract,
        truncated,
        length: content.length,
        text: content,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }
  }
}
