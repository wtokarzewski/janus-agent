/**
 * Update command — pull latest changes, install deps, run tests.
 * CLI equivalent of the self_update agent tool.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, readdir, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { getTimezone } from '../utils/date.js';

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

  // Detect install mode: git (dev) vs tarball (production)
  const isGitInstall = existsSync(`${cwd}/.git`);

  if (!isGitInstall) {
    await runTarballUpdate(cwd);
    return;
  }

  // 1. Check for updates
  console.log(chalk.blue('Checking for updates...'));
  await git(['fetch', '--quiet'], cwd);

  const { stdout: countStr } = await git(['rev-list', 'HEAD..origin/main', '--count'], cwd);
  const count = parseInt(countStr.trim(), 10);

  if (count === 0) {
    console.log(chalk.green('Already up to date.'));
    await finalizeUpdate(cwd);
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

  // 5. Post-update housekeeping (shared with the up-to-date path above)
  await finalizeUpdate(cwd);

  console.log();
  console.log(chalk.green('Update complete. Restart Janus to use the new version.'));
}

/**
 * Post-update housekeeping — runs whether or not new commits were pulled, so config
 * sync and workspace setup happen even when the repo is already up to date.
 */
async function finalizeUpdate(cwd: string): Promise<void> {
  await migrateFromHome(cwd);
  await ensureWorkspace(cwd);
  await ensureStateUncertaintySection(cwd);
  await ensureTimezone();
  syncNewConfigSections(cwd);
  await reportModelDrift();
  try {
    const { ensureGws } = await import('./onboard.js');
    await ensureGws();
  } catch {
    // Non-critical — skip silently
  }
}

/** Credentials for a provider's model-listing call, or null if we have none. */
async function listingToken(provider: string, auth?: string): Promise<{ token: string; isOAuth: boolean; accountId?: string } | null> {
  const { loadApiKey, FileTokenStore } = await import('../auth/token-store.js');

  if (auth === 'oauth') {
    const store = new FileTokenStore();
    if (provider === 'anthropic') {
      const { getAnthropicToken } = await import('../auth/anthropic-oauth.js');
      return { token: await getAnthropicToken(store), isOAuth: true };
    }
    if (provider === 'codex') {
      const { getCodexToken } = await import('../auth/codex-oauth.js');
      const { token, accountId } = await getCodexToken(store);
      return { token, isOAuth: true, accountId };
    }
    return null;
  }

  const key = loadApiKey(provider);
  return key ? { token: key, isOAuth: false } : null;
}

/**
 * Warn when a configured model is no longer served. Providers retire models on
 * their own schedule and the first symptom is otherwise a 404 mid-conversation.
 * Purely advisory — nothing is rewritten, and a provider we cannot query
 * (subscription tokens have no listing endpoint) is skipped in silence.
 */
async function reportModelDrift(): Promise<void> {
  try {
    const { loadConfig } = await import('../config/config.js');
    const { fetchAnthropicModels, fetchOpenAIModels } = await import('../llm/model-listing.js');
    const { findModelDrift } = await import('../llm/model-drift.js');

    const { resolved } = await loadConfig();
    const drift = [];

    for (const provider of resolved.providers) {
      const configured = resolved.slots
        .flatMap(s => s.entries)
        .filter(e => e.provider === provider.name)
        .map(e => e.model);
      if (configured.length === 0) continue;

      let available: string[] = [];
      try {
        const creds = await listingToken(provider.name, provider.auth);
        if (!creds) continue;
        const models = provider.name === 'anthropic' || provider.name === 'openrouter'
          ? await fetchAnthropicModels(creds.token, creds.isOAuth)
          : await fetchOpenAIModels(creds.token, creds.accountId);
        available = models.map(m => m.id);
      } catch {
        continue; // can't ask this provider — say nothing rather than guess
      }

      drift.push(...findModelDrift({ provider: provider.name, configured, available }));
    }

    if (drift.length === 0) return;

    console.log(chalk.yellow('\n  Models configured but no longer offered by the provider:'));
    for (const d of drift) {
      const hint = d.suggestion ? ` — newest available: ${d.suggestion}` : '';
      console.log(chalk.yellow(`    ${d.provider}: ${d.model}${hint}`));
    }
    console.log(chalk.gray('  Update janus.json (llm.slots) or run "npm start -- setup" to pick a current model.\n'));
  } catch {
    // Advisory step — never fail an update over it
  }
}

const STATE_UNCERTAINTY_SECTION = `## State uncertainty

When requested data is unclear, missing, or contradicts what you remember:

1. First, check \`<pinned_skill_state>\` — if the relevant file is there with content, use it as the source of truth.
2. If the file shows \`status="missing"\`, call the appropriate tool (\`read_file\`, \`list_dir\`) to verify, or ask the user.
3. If none of the above answers the question, ask the user for what you need.
4. Never explain confusion in terms of memory limits, session boundaries, agent instances, summarization, or any other internal mechanism. The user needs an answer or a question, not an explanation of how the agent works.
`;

export async function ensureStateUncertaintySection(cwd: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const agentsPath = resolve(cwd, 'AGENTS.md');
  let content: string;
  try {
    content = await readFile(agentsPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // workspace doesn't have AGENTS.md yet — onboard step handles creation
    }
    throw err;
  }
  if (content.includes('## State uncertainty')) {
    console.log('  AGENTS.md already has State uncertainty section.');
    return;
  }
  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(agentsPath, content + separator + STATE_UNCERTAINTY_SECTION, 'utf-8');
  console.log(chalk.green('  + AGENTS.md updated with State uncertainty section'));
}

/** Auto-detect timezone and add to config if missing. */
async function ensureTimezone(): Promise<void> {
  try {
    const { loadConfig, saveConfig } = await import('../config/config.js');
    const config = await loadConfig();
    if (config.timezone) return; // already set

    const tz = getTimezone();
    if (!tz) return;

    await saveConfig({ timezone: tz });
    console.log(chalk.green(`  + timezone: ${tz} (auto-detected, saved to janus.json)`));
  } catch {
    // Non-critical — skip silently
  }
}

async function runTarballUpdate(cwd: string): Promise<void> {
  const { getLatestRelease, isNewerVersion, CURRENT_VERSION, downloadFile } = await import('../utils/version.js');

  console.log(chalk.blue(`Current version: ${CURRENT_VERSION}`));
  console.log(chalk.blue('Checking for updates...'));

  const release = await getLatestRelease();
  if (!release) {
    console.log(chalk.yellow('Could not check for updates (no releases found or network error).'));
    return;
  }

  if (!isNewerVersion(CURRENT_VERSION, release.version)) {
    console.log(chalk.green(`Already up to date (v${CURRENT_VERSION}).`));
    return;
  }

  console.log(chalk.yellow(`Update available: v${CURRENT_VERSION} → v${release.version}`));

  // Download tarball to temp
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tarballPath = join(tmpdir(), `janus-v${release.version}.tar.gz`);
  console.log(chalk.blue(`Downloading v${release.version}...`));
  await downloadFile(release.tarballUrl, tarballPath);

  // Backup current install
  const backupDir = `${cwd}.bak`;
  const { cp: cpAsync, rm } = await import('node:fs/promises');
  if (existsSync(backupDir)) {
    await rm(backupDir, { recursive: true, force: true });
  }
  console.log(chalk.blue('Creating backup...'));
  await cpAsync(cwd, backupDir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('.janus') });

  // Extract tarball over current install
  console.log(chalk.blue('Extracting update...'));
  await execAsync('tar', ['xzf', tarballPath, '--strip-components=1', '-C', cwd], { timeout: 30_000 });

  // Install dependencies
  console.log(chalk.blue('Installing dependencies...'));
  try {
    await npm(['install', '--omit=dev', '--no-audit', '--no-fund'], cwd);
  } catch (err) {
    console.error(chalk.red('npm install failed. Restoring backup...'));
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    await cpAsync(backupDir, cwd, { recursive: true }).catch(() => {});
    console.error(chalk.red('Restored from backup.'));
    process.exit(1);
  }

  // Verify new version
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
    console.log(chalk.green(`Updated to v${pkg.version}.`));
  } catch {
    console.log(chalk.green('Update applied.'));
  }

  // Cleanup
  await rm(tarballPath, { force: true }).catch(() => {});
  console.log(chalk.gray('Backup kept at: ' + backupDir));
  console.log(chalk.green('Update complete. Restart Janus to use the new version.'));
}

/**
 * Add top-level sections present in `example` but missing from `config`.
 * Add-only: existing sections are never overwritten (preserves secrets like the
 * Telegram token, model choices, allowlists). Example values are deep-cloned so the
 * source object is never aliased. Pure — does no I/O.
 */
export function mergeMissingTopLevelSections(
  config: Record<string, unknown>,
  example: Record<string, unknown>,
): { merged: Record<string, unknown>; added: string[] } {
  const merged: Record<string, unknown> = {};
  const added: string[] = [];
  // 1. Walk example order: keep the user's existing value, or add the example default.
  for (const key of Object.keys(example)) {
    if (key in config) {
      merged[key] = config[key];
    } else {
      merged[key] = structuredClone(example[key]);
      added.push(key);
    }
  }
  // 2. Append config-only keys (not in example) at the end, preserving their order.
  for (const key of Object.keys(config)) {
    if (!(key in merged)) {
      merged[key] = config[key];
    }
  }
  return { merged, added };
}

/**
 * Sync janus.json with new top-level sections from janus.default.json (the minimal
 * baseline). NOT janus.example.json — that's a full showcase incl. example
 * agents/bindings/users which must never be injected into a real config. New baseline
 * feature sections (e.g. `logging`) are added with their default values, so the user
 * never hand-edits JSON after an update. Existing values are untouched; janus.json.bak
 * is written first.
 */
function syncNewConfigSections(cwd: string): void {
  try {
    const defaultsPath = resolve(cwd, 'janus.default.json');
    const configPath = resolve(cwd, 'janus.json');
    if (!existsSync(defaultsPath) || !existsSync(configPath)) return;

    const defaults = JSON.parse(readFileSync(defaultsPath, 'utf-8')) as Record<string, unknown>;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

    const { merged, added } = mergeMissingTopLevelSections(config, defaults);
    if (added.length === 0) return;

    // Back up first — janus.json holds secrets.
    writeFileSync(`${configPath}.bak`, readFileSync(configPath, 'utf-8'), 'utf-8');
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
    console.log(chalk.green(`  Added new config section(s) to janus.json: ${added.join(', ')} (backup: janus.json.bak)`));
  } catch {
    // Non-critical
  }
}
