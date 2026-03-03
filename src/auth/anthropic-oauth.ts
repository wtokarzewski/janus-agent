import { randomBytes } from 'node:crypto';
import { generateCodeVerifier, generateCodeChallenge } from './pkce.js';
import type { TokenStore, OAuthTokens } from './types.js';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

interface ReadlineIO {
  question(prompt: string): Promise<string>;
}

export async function anthropicLogin(store: TokenStore, io: ReadlineIO): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `${AUTH_URL}?${params}`;

  // Open browser
  const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const { exec } = await import('node:child_process');
  exec(`${openCmd} "${authUrl}"`);

  console.log(`\n  Opening browser for Anthropic login...\n  URL: ${authUrl}\n`);
  console.log('  After authorizing, copy the code from the callback page.');
  console.log('  The code looks like: <code>#<state>\n');

  const raw = (await io.question('  Paste code#state: ')).trim();

  // Parse code and state from "code#state" format
  const hashIdx = raw.lastIndexOf('#');
  if (hashIdx === -1) throw new Error('Invalid format — expected code#state');

  const code = raw.slice(0, hashIdx);
  const returnedState = raw.slice(hashIdx + 1);
  if (returnedState !== state) throw new Error('State mismatch — possible CSRF attack');

  const tokens = await exchangeCode(code, returnedState, verifier);
  store.save('anthropic', tokens);
}

async function exchangeCode(code: string, state: string, verifier: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function anthropicRefresh(store: TokenStore): Promise<OAuthTokens> {
  const existing = store.load('anthropic');
  if (!existing?.refresh_token) throw new Error('No Anthropic refresh token');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: existing.refresh_token,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  store.save('anthropic', tokens);
  return tokens;
}

export async function getAnthropicToken(store: TokenStore): Promise<string> {
  const tokens = store.load('anthropic');
  if (!tokens) throw new Error('Not logged in to Anthropic — run setup with OAuth');

  if (tokens.expires_at - Date.now() < EXPIRY_BUFFER_MS) {
    const refreshed = await anthropicRefresh(store);
    return refreshed.access_token;
  }

  return tokens.access_token;
}
