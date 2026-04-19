/**
 * Doctor command — verify Janus installation and data integrity.
 *
 * `runDoctorChecks()` is a pure function (no console output) for testability.
 * `runDoctor()` is the CLI wrapper that prints colored results.
 */

import { existsSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import chalk from 'chalk';
import { migrations } from '../db/migrations.js';
import { isEncrypted, decryptCredentials } from '../auth/crypto.js';

export interface DoctorResult {
  name: string;
  category: 'core' | 'diagnostic';
  status: 'pass' | 'fail' | 'warn' | 'fixed' | 'info';
  message: string;
}

/**
 * Run all doctor checks against the given workspace directory.
 * Pure function — no side effects beyond auto-creating missing directories.
 */
export function runDoctorChecks(workspaceDir: string): DoctorResult[] {
  const results: DoctorResult[] = [];

  // 1. Config — check janus.json exists and is valid JSON
  results.push(checkConfig(workspaceDir));

  // 2. .janus directory
  results.push(checkDotJanus(workspaceDir));

  // 3. Database — integrity check with readonly open
  results.push(checkDatabase(workspaceDir));

  // 4. Auth — check .janus/auth.json
  results.push(checkAuth(workspaceDir));

  // 5. Directories — memory/ and sessions/, auto-create if missing
  results.push(checkDirectories(workspaceDir));

  // 6. Permissions — POSIX only, check auth.json perms
  const permResult = checkPermissions(workspaceDir);
  if (permResult) results.push(permResult);

  // 7. GWS — git workspace status (diagnostic)
  results.push(checkGws(workspaceDir));

  return results;
}

function checkConfig(workspaceDir: string): DoctorResult {
  const configPath = join(workspaceDir, 'janus.json');
  if (!existsSync(configPath)) {
    return { name: 'config', category: 'core', status: 'fail', message: 'janus.json not found' };
  }
  try {
    JSON.parse(readFileSync(configPath, 'utf-8'));
    return { name: 'config', category: 'core', status: 'pass', message: 'janus.json is valid' };
  } catch {
    return { name: 'config', category: 'core', status: 'fail', message: 'janus.json is not valid JSON' };
  }
}

function checkDotJanus(workspaceDir: string): DoctorResult {
  const dotJanusPath = join(workspaceDir, '.janus');
  if (existsSync(dotJanusPath)) {
    return { name: 'dotjanus', category: 'core', status: 'pass', message: '.janus/ directory exists' };
  }
  return { name: 'dotjanus', category: 'core', status: 'fail', message: '.janus/ directory not found' };
}

function checkDatabase(workspaceDir: string): DoctorResult {
  const dbPath = join(workspaceDir, '.janus', 'janus.db');
  if (!existsSync(dbPath)) {
    return { name: 'database', category: 'core', status: 'fail', message: 'Database file not found' };
  }
  try {
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const result = db.pragma('integrity_check', { simple: true }) as string;
      if (result !== 'ok') {
        return { name: 'database', category: 'core', status: 'fail', message: `Database integrity check failed: ${result}` };
      }

      const userVersion = db.pragma('user_version', { simple: true }) as number;
      const migrationCount = migrations.length;

      if (userVersion > migrationCount) {
        return { name: 'database', category: 'core', status: 'fail', message: `Database version ${userVersion} is newer than supported (${migrationCount}) — incompatible Janus version` };
      }
      if (userVersion < migrationCount) {
        return { name: 'database', category: 'core', status: 'warn', message: `Database version ${userVersion} has ${migrationCount - userVersion} pending migrations` };
      }

      return { name: 'database', category: 'core', status: 'pass', message: 'Database integrity check passed' };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      name: 'database',
      category: 'core',
      status: 'fail',
      message: `Database error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkAuth(workspaceDir: string): DoctorResult {
  const authPath = join(workspaceDir, '.janus', 'auth.json');
  if (!existsSync(authPath)) {
    return { name: 'auth', category: 'core', status: 'warn', message: 'auth.json not found (run setup to configure)' };
  }
  let content: string;
  try {
    content = readFileSync(authPath, 'utf-8');
    JSON.parse(content);
  } catch {
    return { name: 'auth', category: 'core', status: 'fail', message: 'auth.json is not valid JSON' };
  }

  if (isEncrypted(content)) {
    try {
      decryptCredentials(content);
      return { name: 'auth', category: 'core', status: 'pass', message: 'auth.json is encrypted and decryptable' };
    } catch {
      return { name: 'auth', category: 'core', status: 'fail', message: 'auth.json is encrypted but cannot be decrypted on this machine' };
    }
  }

  return { name: 'auth', category: 'core', status: 'pass', message: 'auth.json is valid' };
}

function checkDirectories(workspaceDir: string): DoctorResult {
  const dirs = ['memory', 'sessions'];
  const missing: string[] = [];

  for (const dir of dirs) {
    if (!existsSync(join(workspaceDir, dir))) {
      missing.push(dir);
    }
  }

  if (missing.length === 0) {
    return { name: 'directories', category: 'core', status: 'pass', message: 'All directories exist' };
  }

  for (const dir of missing) {
    mkdirSync(join(workspaceDir, dir), { recursive: true });
  }

  return {
    name: 'directories',
    category: 'core',
    status: 'fixed',
    message: `Created missing directories: ${missing.join(', ')}`,
  };
}

function checkPermissions(workspaceDir: string): DoctorResult | null {
  if (process.platform === 'win32') return null;

  const authPath = join(workspaceDir, '.janus', 'auth.json');
  if (!existsSync(authPath)) return null;

  try {
    const stats = statSync(authPath);
    const mode = stats.mode & 0o777;
    if (mode === 0o600) {
      return { name: 'permissions', category: 'core', status: 'pass', message: 'auth.json permissions are correct (600)' };
    }
    return {
      name: 'permissions',
      category: 'core',
      status: 'warn',
      message: `auth.json permissions are ${mode.toString(8)} (expected 600)`,
    };
  } catch {
    return { name: 'permissions', category: 'core', status: 'warn', message: 'Could not check auth.json permissions' };
  }
}

function checkGws(workspaceDir: string): DoctorResult {
  const gitDir = join(workspaceDir, '.git');
  if (existsSync(gitDir)) {
    return { name: 'gws', category: 'diagnostic', status: 'info', message: 'Git repository detected' };
  }
  return { name: 'gws', category: 'diagnostic', status: 'info', message: 'Not a git repository' };
}

const STATUS_ICONS: Record<DoctorResult['status'], string> = {
  pass: chalk.green('✓'),
  fail: chalk.red('✗'),
  warn: chalk.yellow('⚠'),
  fixed: chalk.blue('↻'),
  info: chalk.cyan('ℹ'),
};

/**
 * CLI wrapper — runs checks and prints colored output.
 */
export async function runDoctor(): Promise<void> {
  const results = runDoctorChecks(process.cwd());

  console.log();
  for (const r of results) {
    console.log(`  ${STATUS_ICONS[r.status]}  ${r.name}: ${r.message}`);
  }
  console.log();

  const hasCoreFailure = results.some(r => r.category === 'core' && r.status === 'fail');
  if (hasCoreFailure) {
    console.log(chalk.red('  Some core checks failed. Run `janus onboard` to initialize workspace.'));
    console.log();
    process.exit(1);
  }
}
