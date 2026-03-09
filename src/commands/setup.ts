/**
 * Interactive setup wizard — configures LLM provider on first run or via /config.
 *
 * Two auth modes:
 * - API Key: existing providers (OpenRouter, Anthropic, OpenAI, DeepSeek, Groq)
 * - Subscription: Claude Code Max or ChatGPT Plus/Pro via official SDKs
 *
 * After primary provider setup, optionally configures a fallback provider.
 * Model selection fetches available models from the provider API when possible.
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

    let primary: ProviderSetupResult;

    if (mode === '1') {
      primary = await setupApiKey(rl);
    } else {
      primary = await setupSubscription(rl);
    }

    // Ask about fallback provider
    console.log('\n  Add a fallback provider? (used when primary is overloaded)');
    console.log('  1. Yes');
    console.log('  2. No\n');

    const fallbackChoice = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

    if (fallbackChoice === '1') {
      const fallback = await setupFallbackProvider(rl, primary);
      // Save as multi-provider config
      await saveConfig({
        llm: {
          providers: [
            { name: 'primary', ...primary, priority: 0 },
            { name: 'fallback', ...fallback, priority: 1 },
          ],
        },
      });
    } else {
      // Save as single provider config
      const config: Record<string, unknown> = { llm: { provider: primary.provider, model: primary.model } };
      if (primary.apiKey) (config.llm as Record<string, unknown>).apiKey = primary.apiKey;
      if (primary.auth) (config.llm as Record<string, unknown>).auth = primary.auth;
      await saveConfig(config);
    }

    console.log(chalk.green('\n  ✓ Configuration saved to janus.json\n'));
  } finally {
    if (!io) rl.close();
  }
}

interface ProviderSetupResult {
  provider: string;
  model: string;
  apiKey?: string;
  auth?: string;
}

async function setupApiKey(rl: ReadlineIO): Promise<ProviderSetupResult> {
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

  // Try fetching models from API
  const model = await pickModelFromApi(rl, provider, apiKey, false, defaultModel);

  return { provider, model, apiKey };
}

async function setupSubscription(rl: ReadlineIO): Promise<ProviderSetupResult> {
  console.log('\n  Which subscription?');
  console.log('  1. Claude Code (Anthropic Max plan)');
  console.log('  2. ChatGPT (OpenAI Plus/Pro)\n');

  const subChoice = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

  console.log('\n  Auth method?');
  console.log('  1. OAuth (login in browser — recommended)');
  console.log('  2. CLI (requires claude/codex CLI installed)\n');

  const authChoice = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

  if (authChoice === '1') {
    if (subChoice === '1') {
      return await setupAnthropicOAuth(rl);
    } else {
      return await setupCodexOAuth(rl);
    }
  } else {
    if (subChoice === '1') {
      return await setupClaudeAgent(rl);
    } else {
      return await setupCodex(rl);
    }
  }
}

async function setupFallbackProvider(rl: ReadlineIO, primary: ProviderSetupResult): Promise<ProviderSetupResult> {
  const options: { label: string; setup: () => Promise<ProviderSetupResult> }[] = [];

  // Don't offer the same provider type as fallback
  if (primary.provider !== 'anthropic') {
    options.push({ label: 'Anthropic OAuth', setup: () => setupAnthropicOAuth(rl) });
  }
  if (primary.provider !== 'codex') {
    options.push({ label: 'OpenAI (Codex) OAuth', setup: () => setupCodexOAuth(rl) });
  }
  options.push({ label: 'API Key', setup: () => setupApiKey(rl) });

  console.log('\n  Fallback provider type?');
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}. ${options[i].label}`);
  }
  console.log('');

  const valid = options.map((_, i) => String(i + 1));
  const choice = await askChoice(rl, `  Select [1-${options.length}]: `, valid);

  return await options[parseInt(choice, 10) - 1].setup();
}

async function setupClaudeAgent(rl: ReadlineIO): Promise<ProviderSetupResult> {
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

  // CLI subscription uses short names
  console.log('\n  Model?');
  console.log('  1. sonnet (recommended)');
  console.log('  2. opus');
  console.log('  3. haiku\n');

  const modelChoice = await askChoice(rl, '  Select [1-3]: ', ['1', '2', '3']);
  const modelMap: Record<string, string> = { '1': 'claude-sonnet-4-6', '2': 'claude-opus-4-6', '3': 'claude-haiku-4-5-20251001' };
  const model = modelMap[modelChoice];

  return { provider: 'claude-agent', model };
}

async function setupCodex(rl: ReadlineIO): Promise<ProviderSetupResult> {
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

  // Codex CLI uses specific model names
  console.log('\n  Model?');
  console.log('  1. gpt-5.3-codex (recommended)');
  console.log('  2. gpt-5.2-codex');
  console.log('  3. gpt-5-codex-mini\n');

  const modelChoice = await askChoice(rl, '  Select [1-3]: ', ['1', '2', '3']);
  const modelMap: Record<string, string> = { '1': 'gpt-5.3-codex', '2': 'gpt-5.2-codex', '3': 'gpt-5-codex-mini' };
  const model = modelMap[modelChoice];

  return { provider: 'codex', model };
}

async function setupAnthropicOAuth(rl: ReadlineIO): Promise<ProviderSetupResult> {
  const { FileTokenStore } = await import('../auth/token-store.js');
  const { anthropicLogin, getAnthropicToken } = await import('../auth/anthropic-oauth.js');

  const store = new FileTokenStore();
  await anthropicLogin(store, rl);

  console.log(chalk.green('  ✓ Authenticated via OAuth'));

  // Fetch models from API using the new token
  let token: string;
  try {
    token = await getAnthropicToken(store);
  } catch {
    token = '';
  }

  const model = await pickModelFromApi(rl, 'anthropic', token, true, 'claude-sonnet-4-6');
  return { provider: 'anthropic', auth: 'oauth', model };
}

async function setupCodexOAuth(rl: ReadlineIO): Promise<ProviderSetupResult> {
  const { FileTokenStore } = await import('../auth/token-store.js');
  const { codexLogin, getCodexToken } = await import('../auth/codex-oauth.js');

  const store = new FileTokenStore();
  await codexLogin(store);

  console.log(chalk.green('  ✓ Authenticated via OAuth'));

  // Fetch models from API using the new token
  let token = '';
  try {
    const result = await getCodexToken(store);
    token = result.token;
  } catch {
    // token stays empty, will fall back to manual input
  }

  const model = await pickModelFromApi(rl, 'openai', token, false, 'o3');
  return { provider: 'codex', auth: 'oauth', model };
}

/**
 * Try to fetch models from provider API and let user pick.
 * Falls back to manual input if fetch fails.
 */
async function pickModelFromApi(
  rl: ReadlineIO,
  provider: string,
  token: string,
  isOAuth: boolean,
  defaultModel: string,
): Promise<string> {
  if (!token) {
    const input = await rl.question(`  Model [${defaultModel}]: `);
    return input.trim() || defaultModel;
  }

  console.log(chalk.gray('\n  Fetching available models...'));

  try {
    const { fetchAnthropicModels, fetchOpenAIModels } = await import('../llm/model-listing.js');

    let models: { id: string; name: string }[];
    if (provider === 'anthropic' || provider === 'openrouter') {
      models = await fetchAnthropicModels(token, isOAuth);
    } else {
      models = await fetchOpenAIModels(token);
    }

    if (models.length === 0) {
      console.log(chalk.yellow('  Could not fetch models.'));
      const input = await rl.question(`  Model [${defaultModel}]: `);
      return input.trim() || defaultModel;
    }

    console.log('\n  Available models:');
    const display = models.slice(0, 15);
    for (let i = 0; i < display.length; i++) {
      const label = display[i].name !== display[i].id
        ? `${display[i].name} (${display[i].id})`
        : display[i].id;
      console.log(`  ${i + 1}. ${label}`);
    }
    console.log(`  0. Enter manually\n`);

    const valid = [...display.map((_, i) => String(i + 1)), '0'];
    const choice = await askChoice(rl, '  Select: ', valid);

    if (choice === '0') {
      const input = await rl.question(`  Model [${defaultModel}]: `);
      return input.trim() || defaultModel;
    }

    return display[parseInt(choice, 10) - 1].id;
  } catch {
    console.log(chalk.yellow('  Could not fetch models.'));
    const input = await rl.question(`  Model [${defaultModel}]: `);
    return input.trim() || defaultModel;
  }
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
