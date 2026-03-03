export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms since epoch
  account_id?: string; // Codex: chatgpt_account_id from JWT
}

export interface TokenStore {
  load(provider: string): OAuthTokens | null;
  save(provider: string, tokens: OAuthTokens): void;
  clear(provider: string): void;
}
