import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OAuthTokens, TokenStore } from './types.js';
import { encryptCredentials, decryptCredentials } from './crypto.js';
import * as log from '../utils/logger.js';

function defaultPath(): string {
  return join('.', '.janus', 'auth.json');
}

/** Read and decrypt auth.json, returning parsed data. */
function readAuthData(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  const decrypted = decryptCredentials(raw);
  return JSON.parse(decrypted);
}

/** Encrypt and write auth.json with 0o600 permissions. */
function writeAuthData(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const plain = JSON.stringify(data, null, 2) + '\n';
  const encrypted = encryptCredentials(plain);
  writeFileSync(path, encrypted, { mode: 0o600 });
}

export class FileTokenStore implements TokenStore {
  private path: string;

  constructor(path?: string) {
    this.path = path ?? defaultPath();
    this.migrateIfNeeded();
  }

  /** Auto-encrypt legacy plain-text auth.json on first load. */
  private migrateIfNeeded(): void {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed._encrypted) {
        log.info('Migrating auth.json to encrypted format (AES-256-GCM)');
        writeAuthData(this.path, parsed);
      }
    } catch {
      // file doesn't exist or invalid — skip
    }
  }

  load(provider: string): OAuthTokens | null {
    try {
      const data = readAuthData(this.path);
      return (data[provider] as OAuthTokens) ?? null;
    } catch {
      return null;
    }
  }

  save(provider: string, tokens: OAuthTokens): void {
    let data: Record<string, unknown> = {};
    try {
      data = readAuthData(this.path);
    } catch {
      // file doesn't exist yet
    }
    data[provider] = tokens;
    writeAuthData(this.path, data);
  }

  clear(provider: string): void {
    let data: Record<string, unknown> = {};
    try {
      data = readAuthData(this.path);
    } catch {
      return;
    }
    delete data[provider];
    writeAuthData(this.path, data);
  }
}

/**
 * Check all OAuth tokens and return providers whose tokens expire within `withinMs`.
 * Used by proactive token refresh (OD-C) to keep fallback providers alive.
 */
export function getExpiringProviders(withinMs = 3_600_000): string[] {
  const path = defaultPath();
  try {
    const data = readAuthData(path) as Record<string, unknown>;
    const now = Date.now();
    const expiring: string[] = [];
    for (const [provider, entry] of Object.entries(data)) {
      if (entry && typeof entry === 'object' && 'expires_at' in entry && 'refresh_token' in entry) {
        const expiresAt = (entry as OAuthTokens).expires_at;
        if (expiresAt && expiresAt - now < withinMs) {
          expiring.push(provider);
        }
      }
    }
    return expiring;
  } catch {
    return [];
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
    data = readAuthData(path);
  } catch {
    // file doesn't exist yet
  }
  data[provider] = { type: 'api_key', key: apiKey };
  writeAuthData(path, data);
}

/**
 * Load an API key from auth.json.
 * Returns the key string or null if not found.
 */
export function loadApiKey(provider: string): string | null {
  try {
    const data = readAuthData(defaultPath()) as Record<string, unknown>;
    const entry = data[provider] as Record<string, unknown> | undefined;
    if (!entry) return null;
    // API key entry
    if (entry.type === 'api_key') return entry.key as string;
    // OAuth token — return access_token as API key
    if (entry.access_token) return entry.access_token as string;
    return null;
  } catch {
    return null;
  }
}
