/**
 * Gateway instance lock — prevents two gateways from running against the same
 * workspace. Two live instances share the SQLite cron table: whichever polls
 * first marks a job as run, so the other never fires it. If the "winner" is a
 * half-dead process (channels gone, lanes stuck), every reminder it claims is
 * silently lost. The lock makes that state impossible to enter unnoticed.
 */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as log from './logger.js';

const RETRY_INTERVAL_MS = 2_000;

export function lockFilePath(workspaceDir: string): string {
  return resolve(workspaceDir, '.janus', 'gateway.pid');
}

/** Check whether a PID refers to a live process (EPERM = alive, no access). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface LockResult {
  acquired: boolean;
  /** PID of the live holder when acquisition failed. */
  holderPid?: number;
}

/**
 * Try to acquire the gateway lock. A stale lock (dead PID, unreadable file)
 * is taken over. A live holder is retried for `waitMs` — self_update respawns
 * the new process a moment before the old one exits — then reported back so
 * the caller can refuse to start.
 */
export async function acquireInstanceLock(
  workspaceDir: string,
  opts?: { waitMs?: number; pid?: number },
): Promise<LockResult> {
  const path = lockFilePath(workspaceDir);
  const myPid = opts?.pid ?? process.pid;
  const waitMs = opts?.waitMs ?? 30_000;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const holder = await readLockHolder(path);
    if (holder === null || holder === myPid || !isPidAlive(holder)) {
      if (holder !== null && holder !== myPid) {
        log.warn(`Gateway lock: stale lock from dead pid ${holder}, taking over`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, String(myPid), 'utf-8');
      return { acquired: true };
    }

    if (Date.now() >= deadline) {
      return { acquired: false, holderPid: holder };
    }
    log.info(`Gateway lock: pid ${holder} still running, waiting for it to exit...`);
    await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
  }
}

/** Release the lock if this process still owns it. */
export async function releaseInstanceLock(workspaceDir: string, pid?: number): Promise<void> {
  const path = lockFilePath(workspaceDir);
  const myPid = pid ?? process.pid;
  const holder = await readLockHolder(path);
  if (holder === myPid) {
    await unlink(path).catch(() => {});
  }
}

async function readLockHolder(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, 'utf-8')).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
