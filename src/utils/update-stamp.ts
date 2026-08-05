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

/**
 * Current commit, or null outside a git checkout (tarball installs).
 *
 * No shell and no pipe in the format: run through `cmd.exe`, `%h|%cI` is read
 * as a pipeline, git fails, and the stamp silently degrades to the version.
 */
export async function readCommitInfo(cwd: string): Promise<CommitInfo | null> {
  try {
    const { stdout } = await execAsync('git', ['log', '-1', '--format=%h%n%cI'], {
      cwd,
      timeout: 5_000,
    });
    const [hash, committedAt] = stdout.trim().split(/\r?\n/);
    return hash && committedAt ? { hash, committedAt } : null;
  } catch {
    return null;
  }
}

export async function buildUpdateStamp(cwd: string): Promise<string> {
  const { CURRENT_VERSION } = await import('./version.js');
  return formatUpdateStamp(CURRENT_VERSION, await readCommitInfo(cwd));
}

/**
 * Turn `git log --format=%s` output into a short bullet list.
 *
 * The marker used to carry raw `git pull` output — a full diffstat, dozens of
 * lines of file names nobody reads in a chat window. Subjects say what landed.
 */
export function formatCommitList(subjects: string, max = 5): string {
  const lines = subjects.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  const shown = lines.slice(0, max).map(l => `• ${l}`);
  const hidden = lines.length - shown.length;
  if (hidden > 0) shown.push(`…and ${hidden} more`);

  return shown.join('\n');
}
