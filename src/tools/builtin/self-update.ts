import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../types.js';
import * as log from '../../utils/logger.js';
import { classifyTestRun } from '../../utils/test-run-outcome.js';

const IS_WIN = process.platform === 'win32';
const execAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;
// Windows + cold cache + antivirus can push the full suite well past two minutes.
const TEST_TIMEOUT = 600_000;
// execFile buffers all output in memory; vitest easily exceeds Node's 1 MiB default.
const MAX_OUTPUT = 32 * 1024 * 1024;
export interface SelfUpdateOpts {
  workspaceDir: string;
  onBeforeRestart?: () => Promise<void>;
}

/**
 * Check and consume the post-update marker file.
 * Returns the update message if one exists, null otherwise.
 */
export function consumeUpdateMarker(workspaceDir = '.'): string | null {
  const marker = resolve(workspaceDir, '.janus', '.update-complete');
  try {
    if (!existsSync(marker)) return null;
    const content = readFileSync(marker, 'utf-8');
    unlinkSync(marker);
    return content;
  } catch {
    return null;
  }
}

/**
 * self_update tool — check for updates and apply them (git pull + npm install + restart).
 * Gated: "update" action requires user confirmation, "check" is free.
 */
export class SelfUpdateTool implements Tool {
  name = 'self_update';
  description = 'Check for or apply Janus updates. action="check" shows available updates. action="update" pulls, installs, tests, and restarts.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['check', 'update'],
        description: '"check" to see if updates are available, "update" to pull + install + restart.',
      },
      skip_tests: {
        type: 'boolean',
        description: 'Skip running tests before restart (default: false).',
      },
    },
    required: ['action'],
  };

  private workspaceDir: string;
  private onBeforeRestart?: () => Promise<void>;

  constructor(opts: SelfUpdateOpts) {
    this.workspaceDir = opts.workspaceDir;
    this.onBeforeRestart = opts.onBeforeRestart;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action ?? '');
    if (!action || !['check', 'update'].includes(action)) {
      return 'Error: action must be "check" or "update"';
    }

    // Docker detection
    if (this.isDocker()) {
      return 'Error: Running inside Docker. Update the image externally:\n  docker compose pull && docker compose up -d\n(or rebuild if using a custom Dockerfile)';
    }

    const isGit = this.isGitRepo();

    if (action === 'check') {
      return isGit ? this.checkGit() : this.checkTarball();
    }
    return isGit ? this.updateGit(!!args.skip_tests) : this.updateTarball();
  }

  private async checkGit(): Promise<string> {
    try {
      await this.git(['fetch', '--quiet']);
      const { stdout: countStr } = await this.git(['rev-list', 'HEAD..origin/main', '--count']);
      const count = parseInt(countStr.trim(), 10);

      if (count === 0) {
        return 'Already up to date.';
      }

      const { stdout: logOutput } = await this.git([
        'log', 'HEAD..origin/main', '--oneline', '--no-decorate', '-20',
      ]);

      return `${count} update(s) available:\n${logOutput.trim()}`;
    } catch (err) {
      return `Error checking for updates: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async updateGit(skipTests: boolean): Promise<string> {
    try {
      // 1. Fetch + pull — remember where we were: a pull can bring many commits,
      // so "HEAD~1" would leave the workspace on a half-reverted state.
      const { stdout: headBefore } = await this.git(['rev-parse', 'HEAD']);
      const previousHead = headBefore.trim();
      const { stdout: pullOutput } = await this.git(['pull', '--ff-only']);
      if (pullOutput.includes('Already up to date')) {
        return 'Already up to date. Nothing to do.';
      }

      // 2. Install dependencies
      log.info('self_update: running npm install...');
      await this.npm(['install', '--no-audit', '--no-fund']);

      // 3. Run tests (unless skipped)
      if (!skipTests) {
        log.info('self_update: running tests...');
        try {
          await this.npm(['test'], TEST_TIMEOUT);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (classifyTestRun(err) === 'inconclusive') {
            // Timed out or the runner never started — no verdict on the new
            // code, so keep it rather than throwing away a good update.
            log.warn(`self_update: could not run tests: ${message}`);
            return `Update pulled and installed, but the test suite did not run (${message}). `
              + 'Nothing was reverted — run "npm test" on the host, then restart Janus.';
          }
          log.error(`self_update: tests failed, reverting to ${previousHead}: ${message}`);
          await this.git(['reset', '--hard', previousHead]).catch(() => {});
          await this.npm(['install', '--no-audit', '--no-fund']).catch(() => {});
          return `Error: Tests failed after update. Reverted to ${previousHead.slice(0, 8)}.\n${message}`;
        }
      }

      // 4. Flush sessions + write marker + respawn + exit
      log.info('self_update: flushing sessions before restart...');
      if (this.onBeforeRestart) {
        await this.onBeforeRestart().catch(err => {
          log.warn(`self_update: pre-restart flush failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      // Write marker so the new process can notify the user
      const summary = pullOutput.trim();
      const updateMarker = resolve(this.workspaceDir, '.janus', '.update-complete');
      try {
        writeFileSync(updateMarker, summary, 'utf-8');
      } catch (err) {
        log.warn(`self_update: failed to write update marker: ${err instanceof Error ? err.message : String(err)}`);
      }

      log.info('self_update: respawning...');
      // Spawn a new process with the same args, then exit
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          detached: !IS_WIN,
          stdio: 'inherit',
          env: process.env,
        });
        child.unref();
        process.exit(0);
      }, 500);

      return `Updated successfully.\n${summary}\nRestarting...`;
    } catch (err) {
      return `Error during update: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async checkTarball(): Promise<string> {
    try {
      const { getLatestRelease, isNewerVersion, CURRENT_VERSION } = await import('../../utils/version.js');
      const release = await getLatestRelease();
      if (!release) {
        return 'Could not check for updates (no releases found or network error).';
      }
      if (!isNewerVersion(CURRENT_VERSION, release.version)) {
        return `Already up to date (v${CURRENT_VERSION}).`;
      }
      return `Update available: v${CURRENT_VERSION} → v${release.version} (released ${release.publishedAt})`;
    } catch (err) {
      return `Error checking for updates: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async updateTarball(): Promise<string> {
    try {
      const { getLatestRelease, isNewerVersion, CURRENT_VERSION, downloadFile } = await import('../../utils/version.js');
      const release = await getLatestRelease();
      if (!release) {
        return 'Could not check for updates (no releases found or network error).';
      }
      if (!isNewerVersion(CURRENT_VERSION, release.version)) {
        return `Already up to date (v${CURRENT_VERSION}).`;
      }

      log.info(`self_update: downloading v${release.version}...`);

      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tarballPath = join(tmpdir(), `janus-v${release.version}.tar.gz`);
      await downloadFile(release.tarballUrl, tarballPath);

      // Backup current install
      const cwd = this.workspaceDir;
      const backupDir = `${cwd}.bak`;
      const { cp, rm } = await import('node:fs/promises');
      if (existsSync(backupDir)) {
        await rm(backupDir, { recursive: true, force: true });
      }
      await cp(cwd, backupDir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('.janus') });

      // Extract over current
      log.info('self_update: extracting...');
      await execAsync('tar', ['xzf', tarballPath, '--strip-components=1', '-C', cwd], { timeout: 30_000, shell: IS_WIN });

      // Install deps
      log.info('self_update: running npm install...');
      await this.npm(['install', '--omit=dev', '--no-audit', '--no-fund']);

      // Write update marker
      const updateMarker = resolve(this.workspaceDir, '.janus', '.update-complete');
      try {
        writeFileSync(updateMarker, `Updated from v${CURRENT_VERSION} to v${release.version}`, 'utf-8');
      } catch { /* non-critical */ }

      // Cleanup tarball
      await rm(tarballPath, { force: true }).catch(() => {});

      // Flush + restart
      log.info('self_update: flushing sessions before restart...');
      if (this.onBeforeRestart) {
        await this.onBeforeRestart().catch(err => {
          log.warn(`self_update: pre-restart flush failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      log.info('self_update: respawning...');
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          detached: !IS_WIN,
          stdio: 'inherit',
          env: process.env,
        });
        child.unref();
        process.exit(0);
      }, 500);

      return `Updated from v${CURRENT_VERSION} to v${release.version}. Restarting...`;
    } catch (err) {
      return `Error during update: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private isDocker(): boolean {
    return existsSync('/.dockerenv') || process.env.DOCKER === 'true';
  }

  private isGitRepo(): boolean {
    return existsSync(`${this.workspaceDir}/.git`);
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execAsync('git', args, { cwd: this.workspaceDir, timeout: GIT_TIMEOUT, shell: IS_WIN, maxBuffer: MAX_OUTPUT });
  }

  private npm(args: string[], timeout = GIT_TIMEOUT): Promise<{ stdout: string; stderr: string }> {
    return execAsync('npm', args, { cwd: this.workspaceDir, timeout, shell: IS_WIN, maxBuffer: MAX_OUTPUT });
  }
}
