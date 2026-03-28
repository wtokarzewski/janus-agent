/**
 * Strip leaked LLM control tokens from user-facing text.
 *
 * Models sometimes leak training artifacts such as <|endoftext|>,
 * <|im_start|>, [INST], <s>, </s> etc. into their output.
 * This function removes them before the text reaches the user.
 */

const CONTROL_TOKEN_RE =
  // <|...|> family (GPT, Qwen, DeepSeek, Mistral, etc.)
  /<\|[a-z_/]+\|>/gi;

const BRACKET_TAG_RE =
  // [INST], [/INST], [SYS], [/SYS], <<SYS>>, <</SYS>>
  /\[\/?(INST|SYS)\]|<<\/?(SYS)>>/gi;

const SENTENCE_TAG_RE =
  // <s>, </s> (sentence boundary markers)
  /<\/?s>/gi;

/**
 * Strip invisible Unicode characters that can bypass security regex patterns.
 * Removes zero-width spaces, joiners, Mongolian vowel separator, etc.
 */
const INVISIBLE_UNICODE_RE =
  /[\u200B-\u200F\u2028-\u202F\u2060-\u2069\u180E\uFEFF\u00AD]/g;

export function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE_UNICODE_RE, '');
}

export function stripControlTokens(text: string): string {
  return text
    .replace(CONTROL_TOKEN_RE, '')
    .replace(BRACKET_TAG_RE, '')
    .replace(SENTENCE_TAG_RE, '')
    .trim();
}

/**
 * Redact likely secrets/API keys from tool output before sending to LLM.
 *
 * Patterns detected:
 * - KEY=value assignments where value looks like a secret (20+ alphanumeric chars)
 * - Bearer tokens in auth headers
 * - Common API key prefixes (sk-, pk-, ghp_, gho_, xoxb-, etc.)
 * - AWS-style keys (AKIA...)
 * - Base64 JWT tokens (eyJ...)
 */
const SECRET_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // KEY="longvalue" or KEY=longvalue (env-file style)
  { re: /\b([A-Z][A-Z0-9_]{2,})=(["']?)([A-Za-z0-9+/=_\-.]{20,})\2/g,
    replacement: '$1=$2[REDACTED]$2' },
  // Bearer tokens
  { re: /\b(Bearer\s+)[A-Za-z0-9+/=_\-.]{20,}/gi,
    replacement: '$1[REDACTED]' },
  // Common API key prefixes (Stripe, GitHub, Slack, OpenAI, Anthropic, etc.)
  { re: /\b(sk-|pk-|ghp_|gho_|ghs_|ghu_|xoxb-|xoxp-|xoxa-|sk-ant-|sk-proj-)[A-Za-z0-9_\-.]{10,}/g,
    replacement: '[REDACTED]' },
  // AWS access keys (AKIA...)
  { re: /\b(AKIA[A-Z0-9]{12,})/g,
    replacement: '[REDACTED]' },
  // JWT tokens (eyJ...)
  { re: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
    replacement: '[REDACTED_JWT]' },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { re, replacement } of SECRET_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}

/**
 * Mask a token for log output — show first and last 4 chars only.
 * E.g. "sk-1234567890abcdef" → "sk-1***cdef"
 */
export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}
