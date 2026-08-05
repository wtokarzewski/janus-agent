/**
 * Restarting Janus in place, after an update applied itself.
 *
 * The subtlety is `execArgv`: tsx injects its loader there (`--require
 * .../preflight.cjs --import .../loader.mjs`), not through NODE_OPTIONS.
 * Respawning with `argv.slice(1)` alone produces a plain `node src/index.ts`,
 * which dies on the first import — the update lands, the process exits, and
 * nothing comes back up.
 */

import { spawn } from 'node:child_process';
import * as log from './logger.js';

/** Flags that describe *this* invocation and cannot be replayed as a restart. */
const NOT_REPLAYABLE = ['--eval', '-e', '--print', '-p'];

export interface ProcessSnapshot {
  execPath: string;
  execArgv: string[];
  argv: string[];
}

export function buildRespawnCommand(proc: ProcessSnapshot): { command: string; args: string[] } {
  const flags: string[] = [];
  for (let i = 0; i < proc.execArgv.length; i++) {
    const flag = proc.execArgv[i];
    if (NOT_REPLAYABLE.includes(flag)) {
      i++; // skip its value too
      continue;
    }
    if (NOT_REPLAYABLE.some(f => flag.startsWith(`${f}=`))) continue;
    flags.push(flag);
  }

  return { command: proc.execPath, args: [...flags, ...proc.argv.slice(1)] };
}

/**
 * Start the replacement process and hand over. Resolves to false when the
 * child dies within `graceMs`, in which case the caller must stay alive: the
 * running process is the only one left, even if its code is now stale.
 */
export function respawnSelf(graceMs = 3000): Promise<boolean> {
  const { command, args } = buildRespawnCommand(process);

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const child = spawn(command, args, {
        cwd: process.cwd(),
        detached: process.platform !== 'win32',
        stdio: 'inherit',
        env: process.env,
      });

      child.on('error', (err) => {
        log.error(`self_update: respawn failed to start: ${err.message}`);
        done(false);
      });
      child.on('exit', (code, signal) => {
        log.error(`self_update: respawned process died immediately (code=${code}, signal=${signal})`);
        done(false);
      });

      // Survived the grace period — treat it as up and let the parent go.
      setTimeout(() => {
        if (settled) return;
        child.unref();
        done(true);
      }, graceMs).unref();
    } catch (err) {
      log.error(`self_update: respawn failed: ${err instanceof Error ? err.message : String(err)}`);
      done(false);
    }
  });
}
