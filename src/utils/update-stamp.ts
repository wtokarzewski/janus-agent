/**
 * "Which build am I actually running?" — the line sent to users after an update.
 *
 * Read at startup rather than at update time, so it describes the code that is
 * running now instead of what some earlier process expected to install.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localTimestamp } from './date.js';

const execAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

export interface CommitInfo {
  hash: string;
  /** ISO 8601 with offset, as `git log --format=%cI` prints it. */
  committedAt: string;
}

export function formatUpdateStamp(version: string, commit: CommitInfo | null): string {
  const parts = [`v${version}`];
  if (!commit) return parts.join(' • ');

  parts.push(commit.hash);
  const when = new Date(commit.committedAt);
  if (!Number.isNaN(when.getTime())) parts.push(localTimestamp(when).slice(0, 16));

  return parts.join(' • ');
}

/** Current commit, or null outside a git checkout (tarball installs). */
export async function readCommitInfo(cwd: string): Promise<CommitInfo | null> {
  try {
    const { stdout } = await execAsync('git', ['log', '-1', '--format=%h|%cI'], {
      cwd,
      timeout: 5_000,
      shell: IS_WIN,
    });
    const [hash, committedAt] = stdout.trim().split('|');
    return hash && committedAt ? { hash, committedAt } : null;
  } catch {
    return null;
  }
}

export async function buildUpdateStamp(cwd: string): Promise<string> {
  const { CURRENT_VERSION } = await import('./version.js');
  return formatUpdateStamp(CURRENT_VERSION, await readCommitInfo(cwd));
}
