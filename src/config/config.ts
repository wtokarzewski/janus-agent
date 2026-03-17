import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { JanusConfigSchema, type JanusConfig } from './schema.js';
import * as log from '../utils/logger.js';

/**
 * Load config with priority: CLI flags > env vars > workspace json > user json > defaults
 */
export async function loadConfig(overrides?: Partial<JanusConfig>): Promise<JanusConfig> {
  // 1. Try workspace config
  const workspaceConfig = await loadJSON(resolve('.', 'janus.json'));

  // 2. Try user config (.janus/config.json in workspace)
  const userConfig = await loadJSON(resolve('.', '.janus', 'config.json'));

  // 3. Env vars
  const envConfig = loadEnvVars();

  // 4. Merge: defaults < user < workspace < env < overrides
  // If workspace or user config explicitly sets a subscription provider,
  // don't let env-var-detected API key providers override it
  const explicitProvider = (workspaceConfig?.llm as Record<string, unknown>)?.provider
    ?? (userConfig?.llm as Record<string, unknown>)?.provider;
  const isExplicitSubscription = explicitProvider === 'claude-agent' || explicitProvider === 'codex';
  const envLlm = envConfig.llm as Record<string, unknown> | undefined;
  if (isExplicitSubscription && envLlm?.provider) {
    delete envLlm.provider;
    delete envLlm.apiKey;
  }

  const merged = deepMerge(userConfig, workspaceConfig, envConfig, overrides ?? {});

  return JanusConfigSchema.parse(merged);
}

function loadEnvVars(): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Priority: OPENROUTER > ANTHROPIC > OPENAI > DEEPSEEK > GROQ
  const apiKey = process.env.OPENROUTER_API_KEY
    || process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.DEEPSEEK_API_KEY
    || process.env.GROQ_API_KEY;

  const provider = process.env.OPENROUTER_API_KEY ? 'openrouter'
    : process.env.ANTHROPIC_API_KEY ? 'anthropic'
    : process.env.OPENAI_API_KEY ? 'openai'
    : process.env.DEEPSEEK_API_KEY ? 'deepseek'
    : process.env.GROQ_API_KEY ? 'groq'
    : undefined;

  if (apiKey || provider) {
    result.llm = {
      ...(apiKey ? { apiKey } : {}),
      ...(provider ? { provider } : {}),
      ...(process.env.JANUS_MODEL ? { model: process.env.JANUS_MODEL } : {}),
      ...(process.env.JANUS_API_BASE ? { apiBase: process.env.JANUS_API_BASE } : {}),
    };
  }

  // Telegram token from env
  if (process.env.TELEGRAM_BOT_TOKEN) {
    result.telegram = { token: process.env.TELEGRAM_BOT_TOKEN };
  }

  return result;
}

async function loadJSON(path: string): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Save config updates to workspace (janus.json) or user (~/.janus/config.json).
 */
export async function saveConfig(
  updates: Record<string, unknown>,
  scope: 'workspace' | 'user' = 'workspace',
): Promise<void> {
  const path = scope === 'workspace'
    ? resolve('.', 'janus.json')
    : resolve('.', '.janus', 'config.json');

  const dir = resolve(path, '..');
  await mkdir(dir, { recursive: true });

  const existing = await loadJSON(path);
  const merged = deepMerge(existing, updates);

  // When saving providers[], clean up legacy top-level provider fields to avoid conflicts
  const llm = (merged as Record<string, unknown>).llm as Record<string, unknown> | undefined;
  if (llm?.providers && Array.isArray(llm.providers) && (llm.providers as unknown[]).length > 0) {
    delete llm.provider;
    delete llm.apiKey;
    delete llm.apiBase;
    delete llm.auth;
    delete llm.model;
  }

  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/**
 * Watch config files for changes and reload (I1).
 * Debounces rapid changes (e.g. editor save + format).
 * Returns cleanup function to stop watching.
 */
export function watchConfig(
  config: JanusConfig,
  onChange: (newConfig: JanusConfig) => void,
): () => void {
  const files = [
    resolve('.', 'janus.json'),
    resolve('.', '.janus', 'config.json'),
  ];
  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;

  for (const filePath of files) {
    try {
      const watcher = watch(filePath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(async () => {
          try {
            const newConfig = await loadConfig();
            Object.assign(config, newConfig);
            onChange(newConfig);
            log.info(`Config reloaded from ${filePath}`);
          } catch (err) {
            log.warn(`Config reload failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }, 500);
      });
      watchers.push(watcher);
    } catch {
      // File doesn't exist yet — that's fine
    }
  }

  return () => {
    if (debounce) clearTimeout(debounce);
    for (const w of watchers) w.close();
  };
}

function deepMerge(...objects: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object') {
        result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  return result;
}
