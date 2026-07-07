import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { JanusConfigSchema, type JanusConfig, type RawJanusConfig, type ResolvedLLM, type ResolvedProvider, type ResolvedSlot } from './schema.js';
import * as log from '../utils/logger.js';

const SUBSCRIPTION_PROVIDERS = ['claude-agent', 'codex'];

/**
 * Load config with priority: CLI flags > env vars > workspace json > user json > defaults.
 * Normalizes legacy config formats into resolved providers + slots.
 */
export async function loadConfig(overrides?: Partial<RawJanusConfig>): Promise<JanusConfig> {
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

  // Remap legacy "providers" array field to "legacyProviders" before Zod parse
  for (const source of [userConfig, workspaceConfig, envConfig, overrides ?? {}]) {
    const llm = (source as Record<string, unknown>)?.llm as Record<string, unknown> | undefined;
    if (llm && Array.isArray(llm.providers)) {
      llm.legacyProviders = llm.providers;
      delete llm.providers;
    }
  }

  const merged = deepMerge(userConfig, workspaceConfig, envConfig, overrides ?? {});

  const raw = JanusConfigSchema.parse(merged);
  const resolved = resolveLLM(raw);
  return { ...raw, resolved };
}

/**
 * Normalize any config format (new providers+slots, legacy flat, legacy providers[])
 * into a canonical ResolvedLLM structure.
 */
export function resolveLLM(config: RawJanusConfig): ResolvedLLM {
  const llm = config.llm;

  let providers: ResolvedProvider[];
  let slots: ResolvedSlot[];

  if (llm.providers && llm.slots) {
    // NEW format: providers object + slots object
    providers = Object.entries(llm.providers)
      .map(([name, entry]) => ({
        name,
        auth: entry.auth ?? inferAuth(name),
        priority: entry.priority,
        apiBase: entry.apiBase,
        logLevel: entry.logLevel,
      }))
      .sort((a, b) => a.priority - b.priority);

    slots = Object.entries(llm.slots).map(([slotName, mapping]) => ({
      name: slotName,
      entries: mapping
        ? Object.entries(mapping)
            .map(([providerName, model]) => {
              const provEntry = llm.providers![providerName];
              return {
                provider: providerName,
                model,
                priority: provEntry?.priority ?? 99,
              };
            })
            .sort((a, b) => a.priority - b.priority)
        : [], // null slot → empty entries (falls back to default)
    }));
  } else if (llm.legacyProviders && llm.legacyProviders.length > 0) {
    // LEGACY providers[] array → convert
    providers = llm.legacyProviders.map(spec => ({
      name: spec.provider,
      auth: spec.auth ?? inferAuth(spec.provider),
      priority: spec.priority ?? 0,
      apiBase: spec.apiBase,
      logLevel: spec.logLevel,
    }));
    // Deduplicate providers (same provider name → keep lowest priority)
    const seen = new Map<string, ResolvedProvider>();
    for (const p of providers) {
      const existing = seen.get(p.name);
      if (!existing || p.priority < existing.priority) seen.set(p.name, p);
    }
    providers = [...seen.values()].sort((a, b) => a.priority - b.priority);

    // Build default slot from legacy specs
    const defaultEntries = llm.legacyProviders.map(spec => ({
      provider: spec.provider,
      model: spec.model,
      priority: spec.priority ?? 0,
    })).sort((a, b) => a.priority - b.priority);

    slots = [{ name: 'default', entries: defaultEntries }];
  } else if (llm.provider) {
    // LEGACY flat config → single provider, single slot
    const providerName = llm.provider;
    providers = [{
      name: providerName,
      auth: llm.auth ?? inferAuth(providerName),
      priority: 0,
      apiBase: llm.apiBase,
    }];
    slots = [{
      name: 'default',
      entries: [{
        provider: providerName,
        model: llm.model ?? 'claude-sonnet-5',
        priority: 0,
      }],
    }];
  } else {
    // No config at all
    providers = [];
    slots = [{ name: 'default', entries: [] }];
  }

  return {
    providers,
    slots,
    maxTokens: llm.maxTokens,
    temperature: llm.temperature,
    toolTemperature: llm.toolTemperature,
    reasoningEffort: llm.reasoningEffort,
    thinking: llm.thinking,
  };
}

/** Infer auth mode from provider name */
function inferAuth(provider: string): 'api_key' | 'oauth' | 'cli' {
  if (SUBSCRIPTION_PROVIDERS.includes(provider)) return 'cli';
  return 'api_key';
}

/** Get the model for a given slot, falling back to "default" slot */
export function getSlotModel(resolved: ResolvedLLM, slotName: string): { provider: string; model: string } | null {
  // Find requested slot
  let slot = resolved.slots.find(s => s.name === slotName);
  // Fall back to default
  if (!slot || slot.entries.length === 0) {
    slot = resolved.slots.find(s => s.name === 'default');
  }
  if (!slot || slot.entries.length === 0) return null;
  // Return highest priority (lowest number) entry
  return { provider: slot.entries[0].provider, model: slot.entries[0].model };
}

/** Check if any provider is configured */
export function hasAnyProvider(resolved: ResolvedLLM): boolean {
  return resolved.providers.length > 0 && resolved.slots.some(s => s.entries.length > 0);
}

/** Check if a specific provider uses OAuth */
export function isProviderOAuth(resolved: ResolvedLLM, providerName: string): boolean {
  return resolved.providers.some(p => p.name === providerName && p.auth === 'oauth');
}

// --- Env vars ---

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

// --- File I/O ---

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

  // Backup existing config before overwriting
  const existing = await loadJSON(path);
  if (existing && Object.keys(existing).length > 0) {
    const backupPath = path + '.bak';
    await writeFile(backupPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  }

  const merged = deepMerge(existing, updates);

  // Clean up: if updating with new format (providers object + slots),
  // remove legacy fields
  const updatedLlm = (updates as Record<string, unknown>).llm as Record<string, unknown> | undefined;
  const mergedLlm = (merged as Record<string, unknown>).llm as Record<string, unknown> | undefined;
  if (updatedLlm && mergedLlm) {
    const updatingNewFormat = updatedLlm.providers && !Array.isArray(updatedLlm.providers);
    const updatingLegacy = 'provider' in updatedLlm || 'apiKey' in updatedLlm;
    const updatingLegacyArray = Array.isArray(updatedLlm.providers);

    if (updatingNewFormat) {
      // New format → remove ALL legacy fields
      delete mergedLlm.provider;
      delete mergedLlm.apiKey;
      delete mergedLlm.apiBase;
      delete mergedLlm.auth;
      delete mergedLlm.model;
      delete mergedLlm.legacyProviders;
    } else if (updatingLegacy) {
      // Legacy flat → remove new format and legacy array
      delete mergedLlm.providers;
      delete mergedLlm.slots;
      delete mergedLlm.legacyProviders;
    } else if (updatingLegacyArray) {
      // Legacy array → remove flat and new format
      delete mergedLlm.provider;
      delete mergedLlm.apiKey;
      delete mergedLlm.apiBase;
      delete mergedLlm.auth;
      delete mergedLlm.model;
      delete mergedLlm.slots;
    }
  }

  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/**
 * Watch config files for changes and reload.
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
