/**
 * Cross-platform shell configuration and process tree killing.
 *
 * Shell resolution order:
 * 1. Windows: Git Bash in known locations → bash.exe on PATH → cmd.exe fallback
 * 2. Unix: /bin/bash → bash on PATH → sh fallback
 */

import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

let cachedShellConfig: { shell: string; args: string[] } | null = null;

function findBashOnPath(): string | null {
  try {
    const cmd = IS_WIN ? 'where' : 'which';
    const arg = IS_WIN ? 'bash.exe' : 'bash';
    const result = spawnSync(cmd, [arg], { encoding: 'utf-8', timeout: 5000 });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.trim().split(/\r?\n/)[0];
      if (first && (!IS_WIN || existsSync(first))) return first;
    }
  } catch { /* not found */ }
  return null;
}

export function getShellConfig(): { shell: string; args: string[] } {
  if (cachedShellConfig) return cachedShellConfig;

  if (IS_WIN) {
    // Try Git Bash in known locations
    const candidates: string[] = [];
    const pf = process.env.ProgramFiles;
    if (pf) candidates.push(`${pf}\\Git\\bin\\bash.exe`);
    const pfx86 = process.env['ProgramFiles(x86)'];
    if (pfx86) candidates.push(`${pfx86}\\Git\\bin\\bash.exe`);

    for (const p of candidates) {
      if (existsSync(p)) {
        cachedShellConfig = { shell: p, args: ['-c'] };
        return cachedShellConfig;
      }
    }

    // Search bash.exe on PATH (Cygwin, MSYS2, WSL)
    const bashOnPath = findBashOnPath();
    if (bashOnPath) {
      cachedShellConfig = { shell: bashOnPath, args: ['-c'] };
      return cachedShellConfig;
    }

    // Fallback to cmd.exe
    cachedShellConfig = { shell: process.env.ComSpec ?? 'cmd.exe', args: ['/c'] };
    return cachedShellConfig;
  }

  // Unix: /bin/bash → bash on PATH → sh
  if (existsSync('/bin/bash')) {
    cachedShellConfig = { shell: '/bin/bash', args: ['-c'] };
    return cachedShellConfig;
  }

  const bashOnPath = findBashOnPath();
  if (bashOnPath) {
    cachedShellConfig = { shell: bashOnPath, args: ['-c'] };
    return cachedShellConfig;
  }

  cachedShellConfig = { shell: 'sh', args: ['-c'] };
  return cachedShellConfig;
}

/**
 * Kill a process and all its children (cross-platform).
 * Windows: taskkill /F /T /PID
 * Unix: SIGTERM to process group, fallback SIGKILL after grace period
 */
export function killProcessTree(pid: number, opts?: { graceMs?: number }): void {
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (IS_WIN) {
    try {
      spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
      });
    } catch { /* ignore */ }
    return;
  }

  // Unix: SIGTERM to process group
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }

  // Fallback SIGKILL after grace period
  const graceMs = Math.max(0, Math.min(60_000, opts?.graceMs ?? 3000));
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }, graceMs).unref();
}
