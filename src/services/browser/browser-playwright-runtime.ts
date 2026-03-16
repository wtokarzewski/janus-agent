/**
 * Browser Operator — Playwright CDP runtime.
 * Replaces Chrome Extension + WS server with direct Playwright control.
 *
 * Uses launchPersistentContext for cookie/session persistence,
 * _snapshotForAI() for AI-native snapshots with element refs,
 * and aria-ref locators for actions.
 */

import { resolve } from 'node:path';
import * as log from '../../utils/logger.js';
import type { RuntimeState, BrowserCommandName, RuntimeDiagnostics } from './browser-types.js';
import { LAUNCH_TIMEOUT_MS, COMMAND_TIMEOUT_MS } from './browser-types.js';

// Consent banner detection selectors (structural, no hardcoded text)
const CONSENT_CONTAINER_SELECTOR = [
  '[id*="cookie" i]', '[id*="consent" i]', '[id*="gdpr" i]', '[id*="privacy" i]',
  '[class*="cookie" i]', '[class*="consent" i]', '[class*="gdpr" i]',
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
].join(',');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pw = any;

export class BrowserPlaywrightRuntime {
  private context: Pw = null;
  private profileDir: string;
  private chromePath: string | undefined;
  private headless: boolean;
  private _state: RuntimeState = 'idle';
  private startedAt: number | null = null;

  constructor(opts?: { profileDir?: string; chromePath?: string; headless?: boolean }) {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '';
    this.profileDir = opts?.profileDir ?? resolve(homeDir, '.janus', 'chrome-profile');
    this.chromePath = opts?.chromePath;
    this.headless = opts?.headless ?? false;
  }

  get state(): RuntimeState { return this._state; }
  get ready(): boolean { return this._state === 'ready' && this.context !== null; }

  private transitionTo(next: RuntimeState): void {
    const prev = this._state;
    if (prev === next) return;
    log.info(`Browser state: ${prev} -> ${next}`);
    this._state = next;
  }

  /** Dynamic import — Playwright is optional. */
  private async loadPlaywright(): Promise<Pw> {
    try {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      try {
        return require('playwright').chromium;
      } catch {
        return require('playwright-core').chromium;
      }
    } catch {
      throw new Error(
        'Playwright is not installed. Run: npm install playwright && npx playwright install chromium',
      );
    }
  }

  /** Ensure browser is running. Idempotent. */
  async ensureRunning(): Promise<void> {
    if (this.ready) return;

    if (this._state === 'failed') {
      this.transitionTo('idle');
    }

    this.transitionTo('launching');
    this.startedAt = Date.now();

    try {
      const chromium = await this.loadPlaywright();

      const launchOpts: Record<string, unknown> = {
        headless: this.headless,
        timeout: LAUNCH_TIMEOUT_MS,
        args: [
          '--disable-blink-features=AutomationControlled',
        ],
      };

      // Use real Chrome if available
      if (this.chromePath) {
        launchOpts.executablePath = this.chromePath;
      } else {
        launchOpts.channel = 'chrome';
      }

      log.info(`Browser: launching ${this.headless ? 'headless' : 'headed'} Chrome`);
      log.info(`Browser:   profile=${this.profileDir}`);

      this.context = await chromium.launchPersistentContext(this.profileDir, launchOpts);

      // Remove navigator.webdriver flag to avoid bot detection
      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      this.context.on('close', () => {
        log.info('Browser: context closed');
        this.context = null;
        this.transitionTo('idle');
      });

      this.transitionTo('ready');
      log.info('Browser: ready');
    } catch (err) {
      this.transitionTo('failed');
      throw err;
    }
  }

  /** Get the active page, or create one. */
  private async activePage(): Promise<Pw> {
    const pages = this.context.pages();
    if (pages.length > 0) return pages[pages.length - 1];
    return await this.context.newPage();
  }

  /** Execute a browser command. */
  async execute(command: BrowserCommandName, args: Record<string, unknown> = {}): Promise<unknown> {
    const page = await this.activePage();

    switch (command) {
      case 'ping':
        return { pong: true, url: page.url(), timestamp: Date.now() };

      case 'navigate': {
        const url = String(args.url ?? '');
        if (!url) throw new Error('navigate requires args.url');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: COMMAND_TIMEOUT_MS });
        return { url: page.url(), title: await page.title() };
      }

      case 'getCurrentUrl':
        return { url: page.url(), title: await page.title() };

      case 'snapshot': {
        const snap = await page._snapshotForAI();
        return snap.full;
      }

      case 'click': {
        const elementId = String(args.elementId ?? '');
        if (!elementId) throw new Error('click requires args.elementId');
        await page.locator(`aria-ref=${elementId}`).click({ timeout: COMMAND_TIMEOUT_MS });
        return { clicked: elementId, url: page.url() };
      }

      case 'type': {
        const elementId = String(args.elementId ?? '');
        const text = String(args.text ?? '');
        if (!elementId) throw new Error('type requires args.elementId');
        const locator = page.locator(`aria-ref=${elementId}`);
        if (args.clear) await locator.fill('');
        await locator.fill(text, { timeout: COMMAND_TIMEOUT_MS });
        return { typed: text.slice(0, 50), elementId };
      }

      case 'pressKey': {
        const key = String(args.key ?? '');
        if (!key) throw new Error('pressKey requires args.key');
        await page.keyboard.press(key);
        return { pressed: key };
      }

      case 'scroll': {
        const deltaY = Number(args.deltaY ?? 500);
        await page.mouse.wheel(0, deltaY);
        return { scrolled: deltaY };
      }

      case 'waitFor':
        return await this.handleWaitFor(page, args);

      case 'extractText': {
        const text = await page.evaluate('document.body.innerText');
        const maxLen = 50_000;
        return {
          text: text.length > maxLen ? text.slice(0, maxLen) : text,
          truncated: text.length > maxLen,
          url: page.url(),
        };
      }

      case 'screenshot': {
        const buffer = await page.screenshot({ type: 'png', fullPage: false });
        return { base64: buffer.toString('base64'), mimeType: 'image/png' };
      }

      case 'dismissCookies':
        return await this.handleDismissCookies(page);

      case 'openTab': {
        const url = String(args.url ?? 'about:blank');
        const newPage = await this.context.newPage();
        if (url !== 'about:blank') {
          await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: COMMAND_TIMEOUT_MS });
        }
        return { url: newPage.url(), pageIndex: this.context.pages().indexOf(newPage) };
      }

      case 'focusTab': {
        const tabId = Number(args.tabId ?? -1);
        const pages = this.context.pages();
        if (tabId < 0 || tabId >= pages.length) throw new Error(`Tab ${tabId} not found. Available: 0-${pages.length - 1}`);
        await pages[tabId].bringToFront();
        return { focused: tabId, url: pages[tabId].url() };
      }

      case 'closeTab': {
        const tabId = Number(args.tabId ?? -1);
        const pages = this.context.pages();
        if (tabId < 0 || tabId >= pages.length) throw new Error(`Tab ${tabId} not found`);
        await pages[tabId].close();
        return { closed: tabId, remainingTabs: this.context.pages().length };
      }

      case 'closeBrowser':
        await this.stop();
        return { closed: true };

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private async handleWaitFor(page: Pw, args: Record<string, unknown>): Promise<unknown> {
    const type = String(args.type ?? 'domStable');
    const timeoutMs = Number(args.timeoutMs ?? COMMAND_TIMEOUT_MS);

    switch (type) {
      case 'urlMatches': {
        const pattern = String(args.pattern ?? '');
        await page.waitForURL(`**/*${pattern}*`, { timeout: timeoutMs });
        return { matched: true, url: page.url() };
      }
      case 'textVisible': {
        const text = String(args.text ?? '');
        await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: timeoutMs });
        return { visible: true, text };
      }
      case 'elementExists': {
        const selector = args.text ? `text=${args.text}` : String(args.selector ?? 'body');
        await page.locator(selector).first().waitFor({ state: 'attached', timeout: timeoutMs });
        return { exists: true };
      }
      case 'domStable': {
        const stableForMs = Number(args.stableForMs ?? 1000);
        await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
        await page.waitForTimeout(stableForMs);
        return { stable: true, url: page.url() };
      }
      case 'timeoutOnly': {
        await page.waitForTimeout(timeoutMs);
        return { waited: timeoutMs };
      }
      default:
        throw new Error(`Unknown waitFor type: ${type}`);
    }
  }

  private async handleDismissCookies(page: Pw): Promise<unknown> {
    // Execute structural consent detection in the page context.
    // Uses a string function to avoid TS DOM type errors (runs in browser).
    const result = await page.evaluate(`(selector => {
      function isOverlay(el) {
        const style = getComputedStyle(el);
        return style.position === 'fixed'
          || style.position === 'sticky'
          || parseInt(style.zIndex, 10) > 100;
      }
      function isVisible(el) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const containers = document.querySelectorAll(selector);
      for (const container of containers) {
        if (!isOverlay(container) || !isVisible(container)) continue;
        const buttons = [...container.querySelectorAll('button, a, [role="button"]')]
          .filter(b => isVisible(b));
        if (buttons.length === 0) continue;
        const sorted = buttons
          .map(btn => ({ btn, area: btn.getBoundingClientRect().width * btn.getBoundingClientRect().height }))
          .sort((a, b) => b.area - a.area);
        const target = sorted[0].btn;
        target.click();
        return {
          dismissed: true,
          clicked: (target.textContent || '').trim().slice(0, 60),
          containerId: container.id || container.className.toString().slice(0, 40),
        };
      }
      return { dismissed: false, reason: 'No consent overlay detected' };
    })(${JSON.stringify(CONSENT_CONTAINER_SELECTOR)})`);

    // Brief wait for banner to disappear
    if (result.dismissed) {
      await page.waitForTimeout(500);
    }
    return result;
  }

  /** Get runtime diagnostics. */
  getStatus(): RuntimeDiagnostics {
    return {
      runtimeState: this._state,
      pageCount: this.context ? this.context.pages().length : 0,
      activeUrl: this.context?.pages()?.at(-1)?.url() ?? null,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /** Stop browser and clean up. */
  async stop(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // Already closed
      }
      this.context = null;
    }
    this.transitionTo('idle');
    this.startedAt = null;
    log.info('Browser: stopped');
  }
}
