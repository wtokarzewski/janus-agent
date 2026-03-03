import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OAuthTokens, TokenStore } from './types.js';

function defaultPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.janus', 'auth.json');
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
