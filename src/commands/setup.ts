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
import { loadConfig, saveConfig } from '../config/config.js';
import { getTimezone } from '../utils/date.js';

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

    // Detect existing primary provider
    const existingPrimary = await detectExistingPrimary();

    if (opts?.reconfigure && existingPrimary) {
      console.log(chalk.gray(`  Current primary: ${existingPrimary.provider} (${existingPrimary.model})\n`));
      console.log('  What do you want to configure?');
      console.log('  1. Everything from scratch');
      console.log('  2. Add/replace fallback only\n');

      const scope = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

      if (scope === '2') {
        const fallback = await setupFallbackProvider(rl, existingPrimary);
        const timezone = await setupTimezone(rl);
        await saveConfig({
          llm: {
            providers: {
              [existingPrimary.provider]: buildProviderEntry(existingPrimary, 0),
              [fallback.provider]: buildProviderEntry(fallback, 1),
            },
            slots: {
              default: {
                [existingPrimary.provider]: existingPrimary.model,
                [fallback.provider]: fallback.model,
              },
              background: null,
            },
          },
          timezone,
        });
        console.log(chalk.green('\n  ✓ Fallback provider saved to janus.json\n'));
        await verifyProvider(fallback);
        return;
      }
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

    const timezone = await setupTimezone(rl);

    let fallback: ProviderSetupResult | null = null;

    if (fallbackChoice === '1') {
      fallback = await setupFallbackProvider(rl, primary);
      await saveConfig({
        llm: {
          providers: {
            [primary.provider]: buildProviderEntry(primary, 0),
            [fallback.provider]: buildProviderEntry(fallback, 1),
          },
          slots: {
            default: {
              [primary.provider]: primary.model,
              [fallback.provider]: fallback.model,
            },
            background: null,
          },
        },
        timezone,
      });
    } else {
      await saveConfig({
        llm: {
          providers: {
            [primary.provider]: buildProviderEntry(primary, 0),
          },
          slots: {
            default: { [primary.provider]: primary.model },
            background: null,
          },
        },
        timezone,
      });
    }

    console.log(chalk.green('\n  ✓ Configuration saved to janus.json\n'));

    // Verify both — the fallback exists for the moment the primary fails, so it
    // is the last provider that should go untested.
    await verifyProvider(primary);
    if (fallback) await verifyProvider(fallback);
  } finally {
    if (!io) rl.close();
  }
}

/**
 * Detect existing primary provider from config.
 * Checks multi-provider (providers[]) first, then single-provider fields.
 */
async function detectExistingPrimary(): Promise<ProviderSetupResult | null> {
  try {
    const config = await loadConfig();
    const { resolved } = config;

    // Use resolved providers — works for all config formats
    if (resolved.providers.length > 0 && resolved.slots.length > 0) {
      const defaultSlot = resolved.slots.find(s => s.name === 'default');
      if (defaultSlot && defaultSlot.entries.length > 0) {
        const primary = defaultSlot.entries[0];
        const rp = resolved.providers.find(p => p.name === primary.provider);
        return {
          provider: primary.provider,
          model: primary.model,
          ...(rp?.auth ? { auth: rp.auth } : {}),
        };
      }
    }

    // Legacy single-provider fallback
    if (config.llm.provider) {
      return {
        provider: config.llm.provider,
        model: config.llm.model ?? 'claude-sonnet-5',
        ...(config.llm.apiKey ? { apiKey: config.llm.apiKey } : {}),
      };
    }

    return null;
  } catch {
    return null;
  }
}

interface ProviderSetupResult {
  provider: string;
  model: string;
  apiKey?: string;
  auth?: string;
}

/** Build a provider entry for the new config format */
function buildProviderEntry(result: ProviderSetupResult, priority: number): Record<string, unknown> {
  const entry: Record<string, unknown> = { priority };
  if (result.auth) entry.auth = result.auth;
  return entry;
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
    '1': { name: 'openrouter', defaultModel: 'anthropic/claude-sonnet-5' },
    '2': { name: 'anthropic', defaultModel: 'claude-sonnet-5' },
    '3': { name: 'openai', defaultModel: 'gpt-5.6-terra' },
    '4': { name: 'deepseek', defaultModel: 'deepseek-chat' },
    '5': { name: 'groq', defaultModel: 'llama-3.3-70b-versatile' },
  };

  const { name: provider, defaultModel } = providerMap[providerChoice];

  const apiKey = await askNonEmpty(rl, '  API Key: ');

  // Save API key to auth.json (credentials separated from config)
  const { saveApiKey } = await import('../auth/token-store.js');
  saveApiKey(provider, apiKey);

  // Try fetching models from API
  const model = await pickModelFromApi(rl, provider, apiKey, false, defaultModel);

  return { provider, model };
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
  const primaryKey = `${primary.provider}:${primary.auth ?? 'api_key'}`;

  // Offer all auth options, excluding the exact same provider+auth combo as primary
  const all: { key: string; label: string; setup: () => Promise<ProviderSetupResult> }[] = [
    { key: 'anthropic:oauth', label: 'Anthropic OAuth', setup: () => setupAnthropicOAuth(rl) },
    { key: 'codex:oauth', label: 'OpenAI (Codex) OAuth', setup: () => setupCodexOAuth(rl) },
    { key: 'claude-agent:cli', label: 'Claude Code CLI', setup: () => setupClaudeAgent(rl) },
    { key: 'codex:cli', label: 'Codex CLI', setup: () => setupCodex(rl) },
    { key: ':api_key', label: 'API Key', setup: () => setupApiKey(rl) },
  ];

  const options = all.filter(o => o.key !== primaryKey);

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
  console.log('  3. haiku');
  console.log('  4. fable\n');

  const modelChoice = await askChoice(rl, '  Select [1-4]: ', ['1', '2', '3', '4']);
  const modelMap: Record<string, string> = {
    '1': 'claude-sonnet-5',
    '2': 'claude-opus-5',
    '3': 'claude-haiku-4-5-20251001',
    '4': 'claude-fable-5',
  };
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
  console.log('  1. gpt-5.6-terra (recommended — balanced)');
  console.log('  2. gpt-5.6-sol (flagship, most expensive)');
  console.log('  3. gpt-5.6-luna (fast, cheapest)');
  console.log('  4. gpt-5.5\n');

  const modelChoice = await askChoice(rl, '  Select [1-4]: ', ['1', '2', '3', '4']);
  const modelMap: Record<string, string> = {
    '1': 'gpt-5.6-terra',
    '2': 'gpt-5.6-sol',
    '3': 'gpt-5.6-luna',
    '4': 'gpt-5.5',
  };
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

  const model = await pickModelFromApi(rl, 'anthropic', token, true, 'claude-sonnet-5');
  return { provider: 'anthropic', auth: 'oauth', model };
}

async function setupCodexOAuth(rl: ReadlineIO): Promise<ProviderSetupResult> {
  const { FileTokenStore } = await import('../auth/token-store.js');
  const { codexLogin, getCodexToken } = await import('../auth/codex-oauth.js');

  const store = new FileTokenStore();
  await codexLogin(store);

  console.log(chalk.green('  ✓ Authenticated via OAuth'));

  // Try fetching models with ChatGPT OAuth token + accountId header.
  // Falls back to curated list if the API rejects the token.
  let token = '';
  let accountId: string | undefined;
  try {
    const result = await getCodexToken(store);
    token = result.token;
    accountId = result.accountId;
  } catch {
    // token stays empty, will fall back to curated list
  }

  const model = await pickModelFromApi(rl, 'codex', token, false, 'gpt-5.6-terra', accountId);
  return { provider: 'codex', auth: 'oauth', model };
}

/** Curated fallback models for Codex OAuth when API fetch fails. */
const CODEX_FALLBACK_MODELS: { id: string; name: string }[] = [
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (balanced)' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (flagship)' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (fast)' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
];

/**
 * Try to fetch models from provider API and let user pick.
 * Falls back to curated list (codex) or manual input if fetch fails.
 */
async function pickModelFromApi(
  rl: ReadlineIO,
  provider: string,
  token: string,
  isOAuth: boolean,
  defaultModel: string,
  accountId?: string,
): Promise<string> {
  if (!token) {
    // No token — use curated list for codex, manual input for others
    if (provider === 'codex') {
      return pickFromList(rl, CODEX_FALLBACK_MODELS, defaultModel);
    }
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
      models = await fetchOpenAIModels(token, accountId);
    }

    if (models.length === 0) {
      console.log(chalk.yellow('  Could not fetch models from API.'));
      if (provider === 'codex') {
        return pickFromList(rl, CODEX_FALLBACK_MODELS, defaultModel);
      }
      const input = await rl.question(`  Model [${defaultModel}]: `);
      return input.trim() || defaultModel;
    }

    return pickFromList(rl, models, defaultModel);
  } catch {
    console.log(chalk.yellow('  Could not fetch models from API.'));
    if (provider === 'codex') {
      return pickFromList(rl, CODEX_FALLBACK_MODELS, defaultModel);
    }
    const input = await rl.question(`  Model [${defaultModel}]: `);
    return input.trim() || defaultModel;
  }
}

/** Display a model list and let user pick, with manual entry option. */
async function pickFromList(
  rl: ReadlineIO,
  models: { id: string; name: string }[],
  defaultModel: string,
): Promise<string> {
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

/** Auto-detect timezone and confirm with user. Returns IANA timezone string. */
async function setupTimezone(rl: ReadlineIO): Promise<string> {
  const detected = getTimezone() ?? 'UTC';
  console.log(`\n  Detected timezone: ${chalk.bold(detected)}`);
  console.log('  1. Confirm');
  console.log('  2. Change\n');

  const choice = await askChoice(rl, '  Select [1-2]: ', ['1', '2']);

  if (choice === '1') return detected;

  const tz = await askNonEmpty(rl, '  IANA timezone (e.g. Europe/Warsaw, America/New_York): ');
  // Validate the timezone
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return tz;
  } catch {
    console.log(chalk.yellow(`  ⚠ Invalid timezone "${tz}", using ${detected}`));
    return detected;
  }
}

/**
 * Verify that the configured provider actually works by sending a test request.
 * Non-blocking — logs warning on failure, doesn't throw.
 */
async function verifyProvider(result: ProviderSetupResult): Promise<void> {
  console.log(chalk.gray('  Verifying connection...'));

  try {
    const { createProvider } = await import('../llm/openai-compatible-provider.js');
    const { FileTokenStore } = await import('../auth/token-store.js');

    const isOAuth = result.auth === 'oauth';
    const tokenStore = isOAuth ? new FileTokenStore() : undefined;

    const provider = await createProvider({
      provider: result.provider,
      apiKey: result.apiKey ?? '',
      model: result.model,
      auth: result.auth as 'api_key' | 'oauth' | 'cli' | undefined,
      tokenStore,
    });

    const response = await provider.chat({
      model: result.model,
      messages: [
        { role: 'system', content: 'Respond with OK.' },
        { role: 'user', content: 'ping' },
      ],
      maxTokens: 16,
    });

    if (response.content) {
      console.log(chalk.green(`  ✓ Provider "${result.provider}" responds (model: ${result.model})`));
    } else {
      console.log(chalk.yellow(`  ⚠ Provider responded but with empty content`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`  ✗ Provider verification failed: ${msg}`));
    console.log(chalk.yellow('  Config saved but provider may not work. Check credentials and try again.'));
    console.log(chalk.gray(`  Backup saved to janus.json.bak`));
  }
}
