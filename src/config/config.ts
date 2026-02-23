import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JanusConfigSchema, type JanusConfig } from './schema.js';

/**
 * Load config with priority: CLI flags > env vars > workspace json > user json > defaults
 */
export async function loadConfig(overrides?: Partial<JanusConfig>): Promise<JanusConfig> {
  // 1. Try workspace config
  const workspaceConfig = await loadJSON(resolve('.', 'janus.json'));

  // 2. Try user config
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const userConfig = await loadJSON(resolve(home, '.janus', 'config.json'));

  // 3. Env vars
  const envConfig = loadEnvVars();

  // 4. Merge: defaults < user < workspace < env < overrides
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
    : resolve(process.env.HOME || process.env.USERPROFILE || '', '.janus', 'config.json');

  const dir = resolve(path, '..');
  await mkdir(dir, { recursive: true });

  const existing = await loadJSON(path);
  const merged = deepMerge(existing, updates);
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
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
