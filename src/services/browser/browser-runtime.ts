/**
 * Browser Operator — runtime manager.
 * Handles Chrome launch, extension discovery, and lifecycle.
 * Lazy: only starts when the browser tool is first called.
 *
 * Delegates runtime state to BrowserWsServer's state machine.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import * as log from '../../utils/logger.js';
import { BrowserWsServer } from './browser-ws-server.js';
import { LAUNCH_TIMEOUT_MS, HANDSHAKE_TIMEOUT_MS } from './browser-types.js';
import type { RuntimeState, RuntimeDiagnostics } from './browser-types.js';

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
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
};

export class BrowserRuntime {
  private wsServer: BrowserWsServer;
  private chromeProcess: ChildProcess | null = null;
  private profileDir: string;
  private extensionDir: string;
  private chromePath: string | undefined;

  constructor(opts?: { profileDir?: string; extensionDir?: string; chromePath?: string }) {
    this.wsServer = new BrowserWsServer();
    const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '';
    this.profileDir = opts?.profileDir ?? resolve(homeDir, '.janus', 'chrome-profile');
    this.extensionDir = opts?.extensionDir ?? resolve(process.cwd(), 'chrome-extension');
    this.chromePath = opts?.chromePath;
  }

  /** Runtime state from the WS server's state machine. */
  get state(): RuntimeState {
    return this.wsServer.runtimeState;
  }

  get server(): BrowserWsServer {
    return this.wsServer;
  }

  get ready(): boolean {
    return this.wsServer.ready;
  }

  /** Get runtime diagnostics for status command. */
  getStatus(): RuntimeDiagnostics {
    return this.wsServer.getStatus();
  }

  /** Ensure browser runtime is running. Idempotent. */
  async ensureRunning(): Promise<void> {
    if (this.ready) return;

    // Start WS server if not already — may fail with EADDRINUSE if previous
    // session's server is still running. In that case, retry once after a delay
    // (the old server may be shutting down).
    this.wsServer.start();

    // If WS server failed to bind (EADDRINUSE), wait briefly and retry once
    if (this.wsServer.runtimeState === 'idle' && !this.wsServer.ready) {
      log.info('Browser: WS server port busy, retrying in 1s...');
      await new Promise<void>(r => setTimeout(r, 1000));
      this.wsServer.start();
    }

    // Launch Chrome if not already running
    if (!this.chromeProcess || this.chromeProcess.exitCode !== null) {
      await this.launchChrome();
    }

    // Wait for extension to connect and handshake
    await this.wsServer.waitForReady(HANDSHAKE_TIMEOUT_MS);
  }

  /** Stop everything. */
  stop(): void {
    this.wsServer.stop();
    if (this.chromeProcess && this.chromeProcess.exitCode === null) {
      this.chromeProcess.kill('SIGTERM');
      log.info('Browser: Chrome process terminated');
    }
    this.chromeProcess = null;
  }

  private async launchChrome(): Promise<void> {
    const chromePath = this.chromePath ?? this.findChrome();
    if (!chromePath) {
      throw new Error(
        'Chrome not found. Install Google Chrome or set CHROME_PATH env var.\n'
        + '  macOS:   brew install --cask google-chrome\n'
        + '  Linux:   apt install google-chrome-stable\n'
        + '  Manual:  export CHROME_PATH=/path/to/chrome',
      );
    }

    const extensionPath = resolve(this.extensionDir);
    const hasManifest = existsSync(resolve(extensionPath, 'manifest.json'));
    const hasBuilt = existsSync(resolve(extensionPath, 'dist', 'background.js'));

    if (!hasManifest) {
      throw new Error(
        `Browser extension not found at ${extensionPath}\n`
        + '  Run: cd chrome-extension && npm install && npm run build',
      );
    }

    if (!hasBuilt) {
      throw new Error(
        `Browser extension not built (dist/background.js missing)\n`
        + '  Run: cd chrome-extension && npm run build',
      );
    }

    // Profile is created automatically by Chrome if it doesn't exist
    const profileExists = existsSync(this.profileDir);
    if (!profileExists) {
      log.info(`Browser: creating new Janus Chrome profile at ${this.profileDir}`);
    }

    const args = [
      `--user-data-dir=${this.profileDir}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];

    log.info(`Browser: launching Chrome`);
    log.info(`Browser:   binary=${chromePath}`);
    log.info(`Browser:   profile=${this.profileDir}${profileExists ? '' : ' (new)'}`);
    log.info(`Browser:   extension=${extensionPath}`);

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

    // Give Chrome time to start before expecting extension connection
    await new Promise<void>(r => setTimeout(r, Math.min(LAUNCH_TIMEOUT_MS, 2000)));
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
