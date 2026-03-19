import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { UserProfile } from '../config/schema.js';

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

  // Workspace .janus/skills dir
  await mkdir(resolve(workspace, '.janus', 'skills'), { recursive: true });

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
