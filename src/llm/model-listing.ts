/**
 * Fetch available models from LLM provider APIs.
 * Used by setup wizard to let users pick from live model lists.
 */

/** Non-chat model prefixes to filter out from OpenAI listings. */
const OPENAI_EXCLUDE_PREFIXES = [
  'tts-', 'dall-e-', 'whisper-', 'text-embedding-', 'text-moderation-',
  'davinci-', 'babbage-', 'curie-', 'ada-', 'chatgpt-4o-latest',
];

export interface ModelInfo {
  id: string;
  name: string;
}

/** Trailing YYYYMMDD snapshot suffix — a release date, not a version bump. */
const SNAPSHOT_DATE = /-\d{8}$/;

/**
 * Split an ID into the family it belongs to and its version.
 *
 * Structural, so no model names live in this file: everything before the first
 * numeric segment is the family (`claude-opus`, `gpt`), the numeric segments are
 * the version (`4-8` → [4, 8], `5.6` → [5, 6]), and whatever trails them is a
 * variant of that same version (`sol`, `mini`).
 */
function parseModelId(id: string): { family: string; version: number[]; variant: string } {
  const base = id.replace(SNAPSHOT_DATE, '');
  const parts = base.split(/[-.]/);
  const firstNumeric = parts.findIndex(p => /^\d+$/.test(p));
  if (firstNumeric === -1) return { family: base, version: [], variant: '' };

  const version: number[] = [];
  let i = firstNumeric;
  for (; i < parts.length && /^\d+$/.test(parts[i]); i++) version.push(Number(parts[i]));

  return {
    family: parts.slice(0, firstNumeric).join('-'),
    version,
    variant: parts.slice(i).join('-'),
  };
}

/** Compare version arrays element by element; a longer prefix-equal one wins. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Reduce a provider's model list to the current generation: for each family,
 * keep only the entries at its highest version. Siblings that share that
 * version (Sol/Terra/Luna) all survive; superseded releases drop out.
 *
 * Providers happily list every model an account can still reach, which buries
 * the current ones. Unversioned IDs pass through untouched, and the wizard
 * always offers manual entry for anything deliberately older.
 */
export function keepLatestPerFamily(models: ModelInfo[]): ModelInfo[] {
  const parsed = models.map(m => ({ model: m, ...parseModelId(m.id) }));

  const best = new Map<string, number[]>();
  for (const { family, version } of parsed) {
    const current = best.get(family);
    if (!current || compareVersions(version, current) > 0) best.set(family, version);
  }

  const seen = new Set<string>();
  const kept: ModelInfo[] = [];
  for (const { model, family, version, variant } of parsed) {
    if (compareVersions(version, best.get(family)!) !== 0) continue;
    // A dated snapshot and its bare alias are the same model listed twice.
    const key = `${family}:${version.join('.')}:${variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(model);
  }
  return kept;
}

/**
 * Fetch models from Anthropic API.
 * Returns models sorted by newest first (API default).
 */
export async function fetchAnthropicModels(token: string, isOAuth: boolean): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };
  if (isOAuth) {
    headers['authorization'] = `Bearer ${token}`;
    headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
  } else {
    headers['x-api-key'] = token;
  }

  const res = await fetch('https://api.anthropic.com/v1/models?limit=50', { headers });
  if (!res.ok) return [];

  const data = await res.json() as { data: { id: string; display_name: string }[] };
  return keepLatestPerFamily(data.data.map(m => ({ id: m.id, name: m.display_name })));
}

/**
 * Fetch models from OpenAI API.
 * Filters out non-chat models and sorts by creation date (newest first).
 * When accountId is provided (ChatGPT OAuth), includes the chatgpt-account-id header.
 */
export async function fetchOpenAIModels(token: string, accountId?: string): Promise<ModelInfo[]> {
  const headers: Record<string, string> = {
    'authorization': `Bearer ${token}`,
  };
  if (accountId) {
    headers['chatgpt-account-id'] = accountId;
  }

  const res = await fetch('https://api.openai.com/v1/models', { headers });
  if (!res.ok) return [];

  const data = await res.json() as { data: { id: string; created: number }[] };

  const chatModels = data.data
    .filter(m => !OPENAI_EXCLUDE_PREFIXES.some(p => m.id.startsWith(p)))
    .sort((a, b) => b.created - a.created)
    .map(m => ({ id: m.id, name: m.id }));

  return keepLatestPerFamily(chatModels).slice(0, 20);
}
