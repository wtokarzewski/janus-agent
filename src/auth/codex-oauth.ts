import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { generateCodeVerifier, generateCodeChallenge } from './pkce.js';
import type { TokenStore, OAuthTokens } from './types.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
}

export function getAccountId(accessToken: string): string | undefined {
  try {
    const payload = decodeJwt(accessToken);
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return auth?.['chatgpt_account_id'] as string | undefined;
  } catch {
    return undefined;
  }
}

export async function codexLogin(store: TokenStore): Promise<void> {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomBytes(16).toString('hex');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    audience: 'https://api.openai.com/v1',
  });

  const authUrl = `${AUTH_URL}?${params}`;

  const { code } = await startCallbackServer(state);

  // Open browser after server is ready
  const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const { exec } = await import('node:child_process');
  exec(`${openCmd} "${authUrl}"`);

  console.log(`\n  Opening browser for OpenAI login...\n  URL: ${authUrl}\n`);
  console.log('  Waiting for callback on localhost:1455...\n');

  const codeValue = await code;
  const tokens = await exchangeCode(codeValue, verifier);
  const accountId = getAccountId(tokens.access_token);

  store.save('codex', { ...tokens, account_id: accountId });
  console.log('  Login successful!');
}

function startCallbackServer(expectedState: string): { code: Promise<string>; server: Server } {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname !== '/auth/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const returnedCode = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Login failed</h2><p>You can close this window.</p></body></html>');
      server.close();
      rejectCode(new Error(`OAuth error: ${error}`));
      return;
    }

    if (returnedState !== expectedState) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>State mismatch</h2><p>Possible CSRF attack. Try again.</p></body></html>');
      server.close();
      rejectCode(new Error('State mismatch'));
      return;
    }

    if (!returnedCode) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>No code received</h2></body></html>');
      server.close();
      rejectCode(new Error('No authorization code received'));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h2>Login successful!</h2><p>You can close this window and return to the terminal.</p></body></html>');
    server.close();
    resolveCode(returnedCode);
  });

  server.listen(1455, '127.0.0.1');

  return { code, server };
}

async function exchangeCode(code: string, verifier: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
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

export async function codexRefresh(store: TokenStore): Promise<OAuthTokens> {
  const existing = store.load('codex');
  if (!existing?.refresh_token) throw new Error('No Codex refresh token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: existing.refresh_token,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
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
  const accountId = getAccountId(tokens.access_token);
  const result = { ...tokens, account_id: accountId };
  store.save('codex', result);
  return result;
}

export async function getCodexToken(store: TokenStore): Promise<{ token: string; accountId?: string }> {
  const tokens = store.load('codex');
  if (!tokens) throw new Error('Not logged in to Codex — run setup with OAuth');

  if (tokens.expires_at - Date.now() < EXPIRY_BUFFER_MS) {
    const refreshed = await codexRefresh(store);
    return { token: refreshed.access_token, accountId: refreshed.account_id };
  }

  return { token: tokens.access_token, accountId: tokens.account_id };
}
