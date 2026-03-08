/**
 * Update command — pull latest changes, install deps, run tests.
 * CLI equivalent of the self_update agent tool.
 */

import { existsSync } from 'node:fs';
import { cp, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
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

async function ensureWorkspace(cwd: string): Promise<void> {
  console.log(chalk.blue('Ensuring workspace files...'));
  try {
    const { ensureBootstrapFiles } = await import('./onboard.js');
    const created: string[] = [];
    const skipped: string[] = [];
    await ensureBootstrapFiles(cwd, created, skipped);
    if (created.length > 0) {
      for (const f of created) {
        console.log(chalk.green(`  + ${f}`));
      }
    } else {
      console.log('  All workspace files up to date.');
    }
  } catch (err) {
    console.log(chalk.yellow(`  Skipped: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * One-time migration: move files from ~/.janus/ to workspace .janus/.
 * Copies files that don't exist in workspace yet, skips existing ones.
 */
async function migrateFromHome(cwd: string): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return;

  const homeJanus = resolve(home, '.janus');
  const wsJanus = resolve(cwd, '.janus');

  // Skip if no HOME .janus/ or if HOME IS the workspace (same dir)
  if (!existsSync(homeJanus)) return;
  if (resolve(homeJanus) === resolve(wsJanus)) return;

  let migrated = 0;

  // Single files to migrate
  const files = ['auth.json', 'config.json', 'EGO.md', 'history'];
  for (const file of files) {
    const src = resolve(homeJanus, file);
    const dest = resolve(wsJanus, file);
    if (existsSync(src) && !existsSync(dest)) {
      await mkdir(wsJanus, { recursive: true });
      await cp(src, dest);
      migrated++;
      console.log(chalk.green(`  Migrated: ~/.janus/${file} → .janus/${file}`));
    }
  }

  // Directories to migrate (users/, skills/)
  const dirs = ['users', 'skills'];
  for (const dir of dirs) {
    const src = resolve(homeJanus, dir);
    const dest = resolve(wsJanus, dir);
    if (!existsSync(src)) continue;

    let entries: string[];
    try {
      entries = await readdir(src);
    } catch {
      continue;
    }
    if (entries.length === 0) continue;

    // Merge: copy entries that don't exist in dest
    await mkdir(dest, { recursive: true });
    for (const entry of entries) {
      const srcEntry = resolve(src, entry);
      const destEntry = resolve(dest, entry);
      if (!existsSync(destEntry)) {
        await cp(srcEntry, destEntry, { recursive: true });
        migrated++;
        console.log(chalk.green(`  Migrated: ~/.janus/${dir}/${entry} → .janus/${dir}/${entry}`));
      }
    }
  }

  if (migrated > 0) {
    console.log(chalk.blue(`Migrated ${migrated} item(s) from ~/.janus/ to workspace .janus/`));
    console.log(chalk.gray('  You can safely delete ~/.janus/ after verifying.'));
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
    await migrateFromHome(cwd);
    await ensureWorkspace(cwd);
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

  // 5. Migrate files from ~/.janus/ to workspace .janus/ (one-time)
  await migrateFromHome(cwd);

  // 6. Ensure per-user directories exist
  await ensureWorkspace(cwd);

  console.log();
  console.log(chalk.green('Update complete. Restart Janus to use the new version.'));
}
