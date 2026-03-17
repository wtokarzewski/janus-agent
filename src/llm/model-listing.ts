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
  return data.data.map(m => ({ id: m.id, name: m.display_name }));
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

  return data.data
    .filter(m => !OPENAI_EXCLUDE_PREFIXES.some(p => m.id.startsWith(p)))
    .sort((a, b) => b.created - a.created)
    .slice(0, 20)
    .map(m => ({ id: m.id, name: m.id }));
}
