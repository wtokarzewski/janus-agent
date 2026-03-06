import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../types.js';
import * as log from '../../utils/logger.js';

const IS_WIN = process.platform === 'win32';
const execAsync = promisify(execFile);
const GIT_TIMEOUT = 30_000;
const UPDATE_MARKER = resolve(process.env.HOME || '.', '.janus', '.update-complete');

export interface SelfUpdateOpts {
  workspaceDir: string;
  onBeforeRestart?: () => Promise<void>;
}

/**
 * Check and consume the post-update marker file.
 * Returns the update message if one exists, null otherwise.
 */
export function consumeUpdateMarker(): string | null {
  try {
    if (!existsSync(UPDATE_MARKER)) return null;
    const content = readFileSync(UPDATE_MARKER, 'utf-8');
    unlinkSync(UPDATE_MARKER);
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

    // Git repo check
    if (!this.isGitRepo()) {
      return 'Error: Not a git repository. Cannot auto-update without git.';
    }

    if (action === 'check') return this.check();
    return this.update(!!args.skip_tests);
  }

  private async check(): Promise<string> {
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

  private async update(skipTests: boolean): Promise<string> {
    try {
      // 1. Fetch + pull
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
          await this.npm(['test'], 120_000);
        } catch (err) {
          // Tests failed — revert
          log.error(`self_update: tests failed, reverting: ${err instanceof Error ? err.message : String(err)}`);
          await this.git(['reset', '--hard', 'HEAD~1']).catch(() => {});
          await this.npm(['install', '--no-audit', '--no-fund']).catch(() => {});
          return `Error: Tests failed after update. Reverted to previous version.\n${err instanceof Error ? err.message : String(err)}`;
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
      try {
        writeFileSync(UPDATE_MARKER, summary, 'utf-8');
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

  private isDocker(): boolean {
    return existsSync('/.dockerenv') || process.env.DOCKER === 'true';
  }

  private isGitRepo(): boolean {
    return existsSync(`${this.workspaceDir}/.git`);
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execAsync('git', args, { cwd: this.workspaceDir, timeout: GIT_TIMEOUT, shell: IS_WIN });
  }

  private npm(args: string[], timeout = GIT_TIMEOUT): Promise<{ stdout: string; stderr: string }> {
    return execAsync('npm', args, { cwd: this.workspaceDir, timeout, shell: IS_WIN });
  }
}
