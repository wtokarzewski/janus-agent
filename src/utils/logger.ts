import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

let currentLevel: LogLevel = 'info';

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

export function debug(msg: string, ...args: unknown[]): void {
  if (shouldLog('debug')) console.log(chalk.gray(`[DEBUG] ${msg}`), ...args);
}

export function info(msg: string, ...args: unknown[]): void {
  if (shouldLog('info')) console.log(chalk.blue(`[INFO] ${msg}`), ...args);
}

export function warn(msg: string, ...args: unknown[]): void {
  if (shouldLog('warn')) console.log(chalk.yellow(`[WARN] ${msg}`), ...args);
}

export function error(msg: string, ...args: unknown[]): void {
  if (shouldLog('error')) console.error(chalk.red(`[ERROR] ${msg}`), ...args);
}
