import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLevel: LogLevel = 'info';

/**
 * Patterns that look like tokens/secrets in log output.
 * Applied to all log messages automatically (CR-T).
 */
const LOG_SECRET_PATTERNS: RegExp[] = [
  // Telegram bot tokens: 123456789:AABBccdd...
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  // API keys with common prefixes
  /\b(sk-|pk-|ghp_|gho_|ghs_|xoxb-|xoxp-|sk-ant-|sk-proj-)[A-Za-z0-9_\-.]{10,}/g,
  // AWS access keys
  /\bAKIA[A-Z0-9]{12,}/g,
  // JWT tokens
  /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
];

function maskSecrets(msg: string): string {
  let result = msg;
  for (const re of LOG_SECRET_PATTERNS) {
    result = result.replace(re, (match) => {
      if (match.length <= 8) return '****';
      return `${match.slice(0, 4)}***${match.slice(-4)}`;
    });
  }
  return result;
}

const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return levels[level] >= levels[currentLevel];
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function debug(msg: string, ...args: unknown[]): void {
  if (shouldLog('debug')) console.log(chalk.gray(`[${timestamp()}] [DEBUG] ${maskSecrets(msg)}`), ...args);
}

export function info(msg: string, ...args: unknown[]): void {
  if (shouldLog('info')) console.log(chalk.blue(`[${timestamp()}] [INFO] ${maskSecrets(msg)}`), ...args);
}

export function warn(msg: string, ...args: unknown[]): void {
  if (shouldLog('warn')) console.log(chalk.yellow(`[${timestamp()}] [WARN] ${maskSecrets(msg)}`), ...args);
}

export function error(msg: string, ...args: unknown[]): void {
  if (shouldLog('error')) console.error(chalk.red(`[${timestamp()}] [ERROR] ${maskSecrets(msg)}`), ...args);
}

// ---------- Token debug logging ----------

let _tokenDebug = false;

/** Enable token debug output (--token-debug flag). */
export function enableTokenDebug(): void {
  _tokenDebug = true;
}

/** Check whether token debug is enabled. */
export function tokenDebugEnabled(): boolean {
  return _tokenDebug;
}

/**
 * Log per-LLM-call token breakdown.
 *
 * Format:
 * [TOKEN] chat | anthropic claude-sonnet-4-6 | in:48200 out:1250 | cache_read:41000 cache_write:7200 | hit:85%
 *
 * The usage parameter type is inlined to avoid circular dependency with llm/types.
 */
export function logTokenUsage(
  purpose: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  provider?: string,
  model?: string,
): void {
  if (!_tokenDebug) return;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const denominator = usage.promptTokens + cacheRead + cacheWrite;
  const hitRate = denominator > 0 ? Math.round((cacheRead / denominator) * 100) : 0;

  const providerModel = provider && model
    ? `${provider} ${model}`
    : provider ?? model ?? 'unknown';

  const cacheMiss = cacheWrite > 5000 && cacheRead === 0 ? ' \u26a0 CACHE MISS' : '';

  const line = `[TOKEN] ${purpose.padEnd(10)}| ${providerModel.padEnd(30)}| in:${String(usage.promptTokens).padEnd(6)}out:${String(usage.completionTokens).padEnd(6)}| cache_read:${String(cacheRead).padEnd(6)}cache_write:${String(cacheWrite).padEnd(6)}| hit:${hitRate}%${cacheMiss}`;
  console.log(line);
}
