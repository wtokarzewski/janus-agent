import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as readline from 'node:readline';
import chalk from 'chalk';
import type { UserProfile } from '../config/schema.js';

const execAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); }));
}

/** Run a command interactively (inherits stdin/stdout for browser OAuth flow). */
function runInteractive(bin: string, args: string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(bin, args, { stdio: 'inherit', shell: IS_WIN });
    child.on('close', code => resolve(code ?? 1));
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(__dirname, '..', '..', 'examples');

const DEFAULT_CONFIG = JSON.stringify({
  llm: {
    model: "anthropic/claude-sonnet-4-5-20250929",
    maxTokens: 4096,
    temperature: 0.7,
  },
  agent: {
    summarizationThreshold: 20,
  },
  workspace: {
    dir: ".",
    memoryDir: "memory",
    sessionsDir: "sessions",
    skillsDir: "skills",
  },
}, null, 2) + '\n';

async function readExample(filename: string): Promise<string> {
  return readFile(resolve(EXAMPLES_DIR, filename), 'utf-8');
}

/**
 * Ensure workspace bootstrap files exist (non-destructive).
 * Creates missing files from examples/ templates.
 * Called by both onboard and update commands.
 */
/**
 * Ensure workspace bootstrap files exist (non-destructive).
 * Creates missing config/bootstrap files + per-user dirs.
 * Called by the update command after pull/install.
 */
export async function ensureBootstrapFiles(
  workspace: string,
  created?: string[],
  skipped?: string[],
): Promise<void> {
  const c = created ?? [];
  const s = skipped ?? [];

  // Workspace .janus/ dir
  const janusDir = resolve(workspace, '.janus');
  await mkdir(janusDir, { recursive: true });
  const egoContent = await readExample('EGO.md');
  await createIfMissing(resolve(janusDir, 'EGO.md'), egoContent, '.janus/EGO.md', c, s);

  // Workspace bootstrap files (from examples/ templates)
  const [janusContent, agentsContent, heartbeatContent] = await Promise.all([
    readExample('JANUS.md'),
    readExample('AGENTS.md'),
    readExample('HEARTBEAT.md'),
  ]);
  await createIfMissing(resolve(workspace, 'JANUS.md'), janusContent, 'JANUS.md', c, s);
  await createIfMissing(resolve(workspace, 'AGENTS.md'), agentsContent, 'AGENTS.md', c, s);
  await createIfMissing(resolve(workspace, 'HEARTBEAT.md'), heartbeatContent, 'HEARTBEAT.md', c, s);

  // Per-user directories
  await setupUserDirs(workspace, undefined, c, s);
}

/** Onboard command — creates workspace structure, config, and bootstrap files. */
export async function runOnboard(dir?: string): Promise<void> {
  const workspace = resolve(dir ?? '.');

  console.log(chalk.bold('\nJanus — Workspace Setup\n'));

  const created: string[] = [];
  const skipped: string[] = [];

  // Workspace directories (onboard-only, not needed for update)
  for (const subdir of ['memory', 'sessions', 'skills']) {
    const path = resolve(workspace, subdir);
    await mkdir(path, { recursive: true });
    created.push(`${subdir}/`);
  }

  // Workspace .janus/skills + agents dirs
  await mkdir(resolve(workspace, '.janus', 'skills'), { recursive: true });
  await mkdir(resolve(workspace, '.janus', 'agents'), { recursive: true });

  // janus.json (onboard-only — update shouldn't create config)
  await createIfMissing(resolve(workspace, 'janus.json'), DEFAULT_CONFIG, 'janus.json', created, skipped);

  // Bootstrap files + per-user dirs (shared with update)
  await ensureBootstrapFiles(workspace, created, skipped);

  // Report
  console.log(chalk.green('Created:'));
  for (const f of created) {
    console.log(chalk.green(`  + ${f}`));
  }
  if (skipped.length > 0) {
    console.log(chalk.yellow('\nSkipped (already exist):'));
    for (const f of skipped) {
      console.log(chalk.yellow(`  ~ ${f}`));
    }
  }

  // Check Google Workspace CLI auth
  await ensureGws();

  console.log(chalk.bold('\nWorkspace ready!'));
  console.log(chalk.gray('Set your API key: export OPENROUTER_API_KEY=sk-...'));
  console.log(chalk.gray('Then run: npm start\n'));
}

const DEFAULT_PROFILE = `## Preferences
<!-- Auto-updated by Janus when learning your preferences -->
`;

/**
 * Create .janus/users/{id}/ directories and default PROFILE.md for each user.
 * Called by both onboard and update commands.
 */
export async function setupUserDirs(
  workspace: string,
  users?: UserProfile[],
  created?: string[],
  skipped?: string[],
): Promise<void> {
  // Load users from config if not provided
  let userList = users ?? [];
  if (userList.length === 0) {
    try {
      const { loadConfig } = await import('../config/config.js');
      const config = await loadConfig();
      userList = config.users;
    } catch {
      return;
    }
  }

  for (const user of userList) {
    const userDir = resolve(workspace, '.janus', 'users', user.id);
    await mkdir(userDir, { recursive: true });

    const profilePath = resolve(userDir, 'PROFILE.md');
    const profileContent = `# ${user.name}\n\n${DEFAULT_PROFILE}`;
    await createIfMissing(
      profilePath,
      profileContent,
      `.janus/users/${user.id}/PROFILE.md`,
      created ?? [],
      skipped ?? [],
    );
  }
}

/**
 * Check if gws (Google Workspace CLI) is installed and authenticated.
 * Prints setup instructions if not configured.
 * Called by both onboard and update commands.
 */
export async function ensureGws(): Promise<void> {
  // Check if gws binary is available (installed via optionalDependencies)
  const gwsBin = resolve('node_modules', '.bin', IS_WIN ? 'gws.cmd' : 'gws');
  try {
    await access(gwsBin);
  } catch {
    console.log(chalk.yellow('\n  Google Workspace CLI (gws) not found — skipping.'));
    console.log(chalk.gray('  Run: npm install @googleworkspace/cli'));
    return;
  }

  // Check if already authenticated
  if (process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE || process.env.GOOGLE_WORKSPACE_CLI_TOKEN) {
    console.log(chalk.green('  Google Workspace: authenticated (env credentials)'));
    return;
  }

  // Try a real API call — this catches both "no OAuth client" and "not logged in"
  try {
    await execAsync(gwsBin, ['calendar', 'calendarList', 'list', '--page-limit', '1'], {
      timeout: 15_000,
      shell: IS_WIN,
    });
    console.log(chalk.green('  Google Workspace: authenticated'));
    return;
  } catch {
    // Not working — offer setup
  }

  console.log(chalk.yellow('\n  Google Workspace: not configured.'));
  const answer = await ask('  Set up Google Workspace now? [y/N] ');
  if (answer.toLowerCase() !== 'y') {
    console.log(chalk.gray('  Skipped. Run later: npx gws auth setup\n'));
    return;
  }

  // Step 1: try gws auth setup (requires gcloud)
  console.log(chalk.blue('\n  Running: gws auth setup'));
  console.log(chalk.gray('  This will create a GCP project, enable APIs, and open browser for login.\n'));
  const setupCode = await runInteractive(gwsBin, ['auth', 'setup']);

  if (setupCode !== 0) {
    console.log(chalk.yellow('\n  gws auth setup failed (gcloud may not be installed).'));
    console.log(chalk.bold('  Manual setup:'));
    console.log(chalk.gray('    1. Create a GCP project: https://console.cloud.google.com/projectcreate'));
    console.log(chalk.gray('    2. Enable APIs: Gmail, Calendar, Drive, Sheets, Docs, People'));
    console.log(chalk.gray('    3. OAuth consent screen → External → add yourself as test user'));
    console.log(chalk.gray('    4. Credentials → Create OAuth client ID → Desktop app'));
    console.log(chalk.gray('    5. Download JSON → save to ~/.config/gws/client_secret.json'));
    console.log(chalk.gray('  After manual setup, run: npx gws auth login -s drive,gmail,calendar,sheets,docs,contacts\n'));
    return;
  }

  // Step 2: login with scopes
  console.log(chalk.blue('\n  Running: gws auth login -s drive,gmail,calendar,sheets,docs,contacts'));
  console.log(chalk.gray('  This will open a browser for Google OAuth consent.\n'));
  const loginCode = await runInteractive(gwsBin, ['auth', 'login', '-s', 'drive,gmail,calendar,sheets,docs,contacts']);
  if (loginCode === 0) {
    console.log(chalk.green('\n  Google Workspace: authenticated'));
  } else {
    console.log(chalk.yellow('\n  Login failed. Run later: npx gws auth login -s drive,gmail,calendar,sheets,docs,contacts\n'));
  }
}

async function createIfMissing(
  path: string,
  content: string,
  label: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  try {
    await access(path);
    skipped.push(label);
  } catch {
    await writeFile(path, content, 'utf-8');
    created.push(label);
  }
}
