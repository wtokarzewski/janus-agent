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

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function debug(msg: string, ...args: unknown[]): void {
  if (shouldLog('debug')) console.log(chalk.gray(`[${timestamp()}] [DEBUG] ${msg}`), ...args);
}

export function info(msg: string, ...args: unknown[]): void {
  if (shouldLog('info')) console.log(chalk.blue(`[${timestamp()}] [INFO] ${msg}`), ...args);
}

export function warn(msg: string, ...args: unknown[]): void {
  if (shouldLog('warn')) console.log(chalk.yellow(`[${timestamp()}] [WARN] ${msg}`), ...args);
}

export function error(msg: string, ...args: unknown[]): void {
  if (shouldLog('error')) console.error(chalk.red(`[${timestamp()}] [ERROR] ${msg}`), ...args);
}
