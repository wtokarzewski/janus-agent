import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OAuthTokens, TokenStore } from './types.js';

function defaultPath(): string {
  return join('.', '.janus', 'auth.json');
}

export class FileTokenStore implements TokenStore {
  private path: string;

  constructor(path?: string) {
    this.path = path ?? defaultPath();
  }

  load(provider: string): OAuthTokens | null {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf-8'));
      return data[provider] ?? null;
    } catch {
      return null;
    }
  }

  save(provider: string, tokens: OAuthTokens): void {
    let data: Record<string, OAuthTokens> = {};
    try {
      data = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      // file doesn't exist yet
    }
    data[provider] = tokens;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }

  clear(provider: string): void {
    let data: Record<string, OAuthTokens> = {};
    try {
      data = JSON.parse(readFileSync(this.path, 'utf-8'));
    } catch {
      return;
    }
    delete data[provider];
    writeFileSync(this.path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
}

/**
 * Save an API key to auth.json (credentials separated from config).
 * Stored as { type: "api_key", key: "..." } alongside OAuth tokens.
 */
export function saveApiKey(provider: string, apiKey: string): void {
  const path = defaultPath();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // file doesn't exist yet
  }
  data[provider] = { type: 'api_key', key: apiKey };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Load an API key from auth.json.
 * Returns the key string or null if not found.
 */
export function loadApiKey(provider: string): string | null {
  try {
    const data = JSON.parse(readFileSync(defaultPath(), 'utf-8'));
    const entry = data[provider];
    if (!entry) return null;
    // API key entry
    if (entry.type === 'api_key') return entry.key;
    // OAuth token — return access_token as API key
    if (entry.access_token) return entry.access_token;
    return null;
  } catch {
    return null;
  }
}
