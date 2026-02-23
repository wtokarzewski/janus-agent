/**
 * Interactive setup wizard — configures LLM provider on first run or via /config.
 *
 * Two auth modes:
 * - API Key: existing providers (OpenRouter, Anthropic, OpenAI, DeepSeek, Groq)
 * - Subscription: Claude Code Max or ChatGPT Plus/Pro via official SDKs
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { saveConfig } from '../config/config.js';

export interface SetupOptions {
  reconfigure?: boolean;
}

interface ReadlineIO {
  question(prompt: string): Promise<string>;
  close(): void;
}

function createReadline(): ReadlineIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    question: (prompt: string) => new Promise<string>(resolve => rl.question(prompt, resolve)),
    close: () => rl.close(),
  };
}

export async function runSetup(opts?: SetupOptions, io?: ReadlineIO): Promise<void> {
  const rl = io ?? createReadline();

  try {
    console.log(chalk.bold('\n  Janus — Setup\n'));

    if (opts?.reconfigure) {
      console.log(chalk.gray('  Reconfiguring LLM provider.\n'));
    }

    console.log('  How do you want to connect to AI?');
    console.log('  1. API Key (pay per token)');
    console.log('  2. Subscription (use existing plan)\n');

    const mode = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

    if (mode === '1') {
      await setupApiKey(rl);
    } else {
      await setupSubscription(rl);
    }

    console.log(chalk.green('\n  ✓ Configuration saved to janus.json\n'));
  } finally {
    if (!io) rl.close();
  }
}

async function setupApiKey(rl: ReadlineIO): Promise<void> {
  console.log('\n  Provider?');
  console.log('  1. OpenRouter');
  console.log('  2. Anthropic');
  console.log('  3. OpenAI');
  console.log('  4. DeepSeek');
  console.log('  5. Groq\n');

  const providerChoice = await askChoice(rl, '  Select [1-5]: ', ['1', '2', '3', '4', '5']);

  const providerMap: Record<string, { name: string; defaultModel: string }> = {
    '1': { name: 'openrouter', defaultModel: 'anthropic/claude-sonnet-4-5-20250929' },
    '2': { name: 'anthropic', defaultModel: 'claude-sonnet-4-5-20250929' },
    '3': { name: 'openai', defaultModel: 'gpt-4o' },
    '4': { name: 'deepseek', defaultModel: 'deepseek-chat' },
    '5': { name: 'groq', defaultModel: 'llama-3.3-70b-versatile' },
  };

  const { name: provider, defaultModel } = providerMap[providerChoice];

  const apiKey = await askNonEmpty(rl, '  API Key: ');
  const modelInput = await rl.question(`  Model [${defaultModel}]: `);
  const model = modelInput.trim() || defaultModel;

  await saveConfig({ llm: { provider, apiKey, model } });
}

async function setupSubscription(rl: ReadlineIO): Promise<void> {
  console.log('\n  Which subscription?');
  console.log('  1. Claude Code (Anthropic Max plan)');
  console.log('  2. ChatGPT (OpenAI Plus/Pro)\n');

  const subChoice = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

  if (subChoice === '1') {
    await setupClaudeAgent(rl);
  } else {
    await setupCodex(rl);
  }
}

async function setupClaudeAgent(rl: ReadlineIO): Promise<void> {
  console.log('\n  Checking Claude Code authentication...');

  let authenticated = await checkClaudeAuth();

  if (!authenticated) {
    console.log(chalk.yellow('  ✗ Not logged in.'));
    console.log(chalk.gray('    Run in another terminal: claude login'));
    await rl.question('    Press Enter when done...');

    authenticated = await checkClaudeAuth();
    if (!authenticated) {
      console.log(chalk.red('  ✗ Still not authenticated. Please run "claude login" and try again.'));
      throw new Error('Claude Code authentication failed');
    }
  }

  console.log(chalk.green('  ✓ Authenticated'));

  console.log('\n  Model?');
  console.log('  1. sonnet (recommended)');
  console.log('  2. opus');
  console.log('  3. haiku\n');

  const modelChoice = await askChoice(rl, '  Select [1-3]: ', ['1', '2', '3']);
  const modelMap: Record<string, string> = { '1': 'sonnet', '2': 'opus', '3': 'haiku' };
  const model = modelMap[modelChoice];

  await saveConfig({ llm: { provider: 'claude-agent', model } });
}

async function setupCodex(rl: ReadlineIO): Promise<void> {
  console.log('\n  Checking Codex authentication...');

  let authenticated = await checkCodexAuth();

  if (!authenticated) {
    console.log(chalk.yellow('  ✗ Not logged in.'));
    console.log(chalk.gray('    Run in another terminal: codex login'));
    await rl.question('    Press Enter when done...');

    authenticated = await checkCodexAuth();
    if (!authenticated) {
      console.log(chalk.red('  ✗ Still not authenticated. Please run "codex login" and try again.'));
      throw new Error('Codex authentication failed');
    }
  }

  console.log(chalk.green('  ✓ Authenticated'));

  console.log('\n  Model?');
  console.log('  1. o3 (recommended)');
  console.log('  2. o4-mini');
  console.log('  3. gpt-4o\n');

  const modelChoice = await askChoice(rl, '  Select [1-3]: ', ['1', '2', '3']);
  const modelMap: Record<string, string> = { '1': 'o3', '2': 'o4-mini', '3': 'gpt-4o' };
  const model = modelMap[modelChoice];

  await saveConfig({ llm: { provider: 'codex', model } });
}

async function checkClaudeAuth(): Promise<boolean> {
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const q = query({ prompt: 'ping', options: { maxTurns: 1, allowedTools: [] } as never });
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') return true;
      if (msg.type === 'result' && msg.subtype === 'success') return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function checkCodexAuth(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    return new Promise<boolean>(resolve => {
      execFile('codex', ['login', 'status'], (err) => {
        resolve(!err);
      });
    });
  } catch {
    return false;
  }
}

async function askChoice(rl: ReadlineIO, prompt: string, valid: string[]): Promise<string> {
  while (true) {
    const answer = (await rl.question(prompt)).trim();
    if (valid.includes(answer)) return answer;
    console.log(chalk.red(`  Invalid choice. Enter one of: ${valid.join(', ')}`));
  }
}

async function askNonEmpty(rl: ReadlineIO, prompt: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(prompt)).trim();
    if (answer) return answer;
    console.log(chalk.red('  Value cannot be empty.'));
  }
}
