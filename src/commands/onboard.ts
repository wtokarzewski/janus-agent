import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = resolve(__dirname, '..', '..', 'examples');

const DEFAULT_CONFIG = JSON.stringify({
  llm: {
    model: "anthropic/claude-sonnet-4-5-20250929",
    maxTokens: 4096,
    temperature: 0.7,
  },
  agent: {
    maxIterations: 20,
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

/** Onboard command — creates workspace structure, config, and bootstrap files. */
export async function runOnboard(dir?: string): Promise<void> {
  const workspace = resolve(dir ?? '.');

  console.log(chalk.bold('\nJanus — Workspace Setup\n'));

  const created: string[] = [];
  const skipped: string[] = [];

  // Global dir (~/.janus/)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const globalDir = home ? resolve(home, '.janus') : null;

  if (globalDir) {
    await mkdir(globalDir, { recursive: true });
    await mkdir(resolve(globalDir, 'skills'), { recursive: true });

    // Global ego — agent character, same across all projects
    const egoContent = await readExample('EGO.md');
    await createIfMissing(resolve(globalDir, 'EGO.md'), egoContent, '~/.janus/EGO.md', created, skipped);
  }

  // Workspace directories
  for (const subdir of ['memory', 'sessions', 'skills']) {
    const path = resolve(workspace, subdir);
    await mkdir(path, { recursive: true });
    created.push(`${subdir}/`);
  }

  // Workspace files — per-project (templates from examples/)
  const [janusContent, agentsContent, heartbeatContent] = await Promise.all([
    readExample('JANUS.md'),
    readExample('AGENTS.md'),
    readExample('HEARTBEAT.md'),
  ]);
  await createIfMissing(resolve(workspace, 'janus.json'), DEFAULT_CONFIG, 'janus.json', created, skipped);
  await createIfMissing(resolve(workspace, 'JANUS.md'), janusContent, 'JANUS.md', created, skipped);
  await createIfMissing(resolve(workspace, 'AGENTS.md'), agentsContent, 'AGENTS.md', created, skipped);
  await createIfMissing(resolve(workspace, 'HEARTBEAT.md'), heartbeatContent, 'HEARTBEAT.md', created, skipped);

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
