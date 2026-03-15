/**
 * Browser Operator — runtime manager.
 * Handles Chrome launch, extension discovery, and lifecycle.
 * Lazy: only starts when the browser tool is first called.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import * as log from '../../utils/logger.js';
import { BrowserWsServer } from './browser-ws-server.js';

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

export class BrowserRuntime {
  private wsServer: BrowserWsServer;
  private chromeProcess: ChildProcess | null = null;
  private profileDir: string;
  private extensionDir: string;
  private _started = false;

  constructor(opts?: { profileDir?: string; extensionDir?: string }) {
    this.wsServer = new BrowserWsServer();
    this.profileDir = opts?.profileDir ?? resolve(process.env.HOME ?? '~', '.janus', 'chrome-profile');
    this.extensionDir = opts?.extensionDir ?? resolve(process.cwd(), 'chrome-extension');
  }

  get started(): boolean {
    return this._started;
  }

  get server(): BrowserWsServer {
    return this.wsServer;
  }

  get ready(): boolean {
    return this.wsServer.ready;
  }

  /** Ensure browser runtime is running. Idempotent. */
  async ensureRunning(): Promise<void> {
    if (this.ready) return;

    // Start WS server if not already
    this.wsServer.start();

    // Launch Chrome if not already running
    if (!this.chromeProcess || this.chromeProcess.exitCode !== null) {
      await this.launchChrome();
    }

    // Wait for extension to connect and handshake
    await this.wsServer.waitForReady(30_000);
    this._started = true;
  }

  /** Stop everything. */
  stop(): void {
    this.wsServer.stop();
    if (this.chromeProcess && this.chromeProcess.exitCode === null) {
      this.chromeProcess.kill('SIGTERM');
      log.info('Browser: Chrome process terminated');
    }
    this.chromeProcess = null;
    this._started = false;
  }

  private async launchChrome(): Promise<void> {
    const chromePath = this.findChrome();
    if (!chromePath) {
      throw new Error('Chrome not found. Install Google Chrome or set CHROME_PATH env var.');
    }

    const extensionPath = resolve(this.extensionDir);
    const hasExtension = existsSync(resolve(extensionPath, 'manifest.json'));

    const args = [
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Load unpacked extension in dev mode
      ...(hasExtension ? [`--load-extension=${extensionPath}`] : []),
    ];

    log.info(`Browser: launching Chrome at ${chromePath}`);
    log.info(`Browser: profile=${this.profileDir}`);
    if (hasExtension) log.info(`Browser: extension=${extensionPath}`);

    this.chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });

    this.chromeProcess.unref();

    this.chromeProcess.on('error', (err) => {
      log.error(`Browser: Chrome launch failed: ${err.message}`);
    });

    this.chromeProcess.on('exit', (code) => {
      log.info(`Browser: Chrome exited with code ${code}`);
      this.chromeProcess = null;
    });

    // Give Chrome a moment to start before we expect the extension to connect
    await new Promise(r => setTimeout(r, 2000));
  }

  private findChrome(): string | null {
    // Env var override
    const envPath = process.env.CHROME_PATH;
    if (envPath && existsSync(envPath)) return envPath;

    const platform = process.platform;
    const candidates = CHROME_PATHS[platform] ?? [];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }

    // Linux: try which
    if (platform === 'linux') {
      for (const cmd of candidates) {
        try {
          const { execSync } = require('node:child_process');
          const result = execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim();
          if (result) return result;
        } catch {
          // not found
        }
      }
    }

    return null;
  }
}
