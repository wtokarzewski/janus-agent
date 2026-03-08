/**
 * Update command — pull latest changes, install deps, run tests.
 * CLI equivalent of the self_update agent tool.
 */

import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';

const execAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const TIMEOUT = 30_000;
const TEST_TIMEOUT = 120_000;

function git(args: string[], cwd: string) {
  return execAsync('git', args, { cwd, timeout: TIMEOUT, shell: IS_WIN });
}

function npm(args: string[], cwd: string, timeout = TIMEOUT) {
  return execAsync('npm', args, { cwd, timeout, shell: IS_WIN });
}

async function ensureUserDirs(cwd: string): Promise<void> {
  console.log(chalk.blue('Setting up user directories...'));
  try {
    const { setupUserDirs } = await import('./onboard.js');
    const created: string[] = [];
    await setupUserDirs(cwd, undefined, created);
    if (created.length > 0) {
      for (const f of created) {
        console.log(chalk.green(`  + ${f}`));
      }
    } else {
      console.log('  All user directories up to date.');
    }
  } catch {
    // Config might not exist yet — skip silently
  }
}

export async function runUpdate(opts: { skipTests?: boolean } = {}): Promise<void> {
  const cwd = process.cwd();

  // Docker check
  if (existsSync('/.dockerenv') || process.env.DOCKER === 'true') {
    console.error(chalk.red('Running inside Docker. Update the image externally:'));
    console.error('  docker compose pull && docker compose up -d');
    process.exit(1);
  }

  // Git check
  if (!existsSync(`${cwd}/.git`)) {
    console.error(chalk.red('Not a git repository. Cannot auto-update without git.'));
    process.exit(1);
  }

  // 1. Check for updates
  console.log(chalk.blue('Checking for updates...'));
  await git(['fetch', '--quiet'], cwd);

  const { stdout: countStr } = await git(['rev-list', 'HEAD..origin/main', '--count'], cwd);
  const count = parseInt(countStr.trim(), 10);

  if (count === 0) {
    console.log(chalk.green('Already up to date.'));
    await ensureUserDirs(cwd);
    return;
  }

  const { stdout: logOutput } = await git(
    ['log', 'HEAD..origin/main', '--oneline', '--no-decorate', '-20'],
    cwd,
  );
  console.log(chalk.yellow(`${count} update(s) available:`));
  console.log(logOutput.trim());
  console.log();

  // 2. Pull
  console.log(chalk.blue('Pulling changes...'));
  const { stdout: pullOutput } = await git(['pull', '--ff-only'], cwd);
  console.log(pullOutput.trim());

  // 3. Install deps
  console.log(chalk.blue('Installing dependencies...'));
  await npm(['install', '--no-audit', '--no-fund'], cwd);
  console.log(chalk.green('Dependencies installed.'));

  // 4. Run tests
  if (opts.skipTests) {
    console.log(chalk.yellow('Skipping tests (--skip-tests).'));
  } else {
    console.log(chalk.blue('Running tests...'));
    try {
      const { stdout } = await npm(['test'], cwd, TEST_TIMEOUT);
      // Show last few lines (summary)
      const lines = stdout.trim().split('\n');
      const summary = lines.slice(-5).join('\n');
      console.log(summary);
    } catch (err) {
      console.error(chalk.red('Tests failed after update. Reverting...'));
      await git(['reset', '--hard', 'HEAD~1'], cwd).catch(() => {});
      await npm(['install', '--no-audit', '--no-fund'], cwd).catch(() => {});
      console.error(chalk.red('Reverted to previous version.'));
      process.exit(1);
    }
  }

  // 5. Ensure per-user directories exist
  await ensureUserDirs(cwd);

  console.log();
  console.log(chalk.green('Update complete. Restart Janus to use the new version.'));
}
