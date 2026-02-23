import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import chalk from 'chalk';

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

const DEFAULT_EGO = `# Ego

You are Janus — a universal AI agent. You are helpful, thorough, and honest.

## Personality
- You explain what you're doing and why
- You ask for clarification when tasks are ambiguous
- You prefer small, focused changes over big rewrites
- You show your work and reason step by step

## Principles
- Read before editing
- Test after changing
- Commit with clear messages
- Don't guess — verify
`;

const DEFAULT_PROJECT = `# JANUS.md

<!-- Project-specific instructions for Janus in this repository -->
<!-- This file is committed to git — your team shares the same instructions -->

## Overview
<!-- What this project does, tech stack, key conventions -->

## Rules
<!-- Coding style, naming conventions, testing requirements -->
`;

const DEFAULT_AGENTS = `# AGENTS.md

<!-- Agent behavior rules for this workspace -->
<!-- Customize how Janus works in this project -->

## Role
You help with any task — programming, research, writing, planning, and more.

## Rules
- Use tools to accomplish tasks, don't just describe what you would do
- Read files before editing them
- Prefer small, focused changes
- If a task is unclear, ask for clarification
- Show your work — explain what you're doing and why

## Communication
- Be concise and direct
- Explain reasoning when making decisions
- Ask before making large changes
`;

const DEFAULT_HEARTBEAT = `# HEARTBEAT.md

<!-- Autonomous tasks Janus can perform periodically -->
<!-- Uncomment and customize tasks as needed -->

<!-- ## Tasks -->

<!-- ### Check for uncommitted changes -->
<!-- schedule: every 30m -->
<!-- action: Run git status and remind about uncommitted work -->

<!-- ### Review TODOs -->
<!-- schedule: daily -->
<!-- action: Scan for TODO/FIXME comments and summarize -->
`;

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
    await createIfMissing(resolve(globalDir, 'EGO.md'), DEFAULT_EGO, '~/.janus/EGO.md', created, skipped);
  }

  // Workspace directories
  for (const subdir of ['memory', 'sessions', 'skills']) {
    const path = resolve(workspace, subdir);
    await mkdir(path, { recursive: true });
    created.push(`${subdir}/`);
  }

  // Workspace files — per-project
  await createIfMissing(resolve(workspace, 'janus.json'), DEFAULT_CONFIG, 'janus.json', created, skipped);
  await createIfMissing(resolve(workspace, 'JANUS.md'), DEFAULT_PROJECT, 'JANUS.md', created, skipped);
  await createIfMissing(resolve(workspace, 'AGENTS.md'), DEFAULT_AGENTS, 'AGENTS.md', created, skipped);
  await createIfMissing(resolve(workspace, 'HEARTBEAT.md'), DEFAULT_HEARTBEAT, 'HEARTBEAT.md', created, skipped);

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
