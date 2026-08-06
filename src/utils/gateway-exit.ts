/**
 * Wait for the gateway to be gone before touching its files.
 *
 * The update worker starts while the gateway is still shutting down (flushing
 * sessions takes seconds). Swapping the source tree under a running process is
 * how you get half-loaded modules, so the worker waits for the instance lock to
 * clear first.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPidAlive } from './instance-lock.js';

const POLL_MS = 250;

function recordedPid(workspaceDir: string): number | null {
  try {
    const raw = readFileSync(resolve(workspaceDir, '.janus', 'gateway.pid'), 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // no lock file — nothing to wait for
  }
}

/** True once no gateway is running; false if one is still alive at the deadline. */
export async function waitForGatewayExit(workspaceDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const pid = recordedPid(workspaceDir);
    if (pid === null || !isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
