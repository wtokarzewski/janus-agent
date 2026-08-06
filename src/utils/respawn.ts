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
import { encodeRestartArgv, encodeWorkerMode } from './restart-argv.js';

/** Flags that describe *this* invocation and cannot be replayed as a restart. */
const NOT_REPLAYABLE = ['--eval', '-e', '--print', '-p'];

/**
 * Spawn options for the replacement process.
 *
 * On Windows the child must leave the console behind: the chain is
 * PowerShell → npm → node → child, and npm tears down its process tree when
 * the parent exits, so a child sharing that console dies with it — which is
 * exactly what happened after the grace period reported success. Detaching it
 * costs the inherited stdout, which the file log already covers.
 */
export function buildRespawnOptions(platform: NodeJS.Platform): {
  detached: boolean;
  stdio: 'ignore' | 'inherit';
  windowsHide?: boolean;
} {
  return platform === 'win32'
    ? { detached: true, stdio: 'ignore', windowsHide: true }
    : { detached: true, stdio: 'inherit' };
}

export interface ProcessSnapshot {
  execPath: string;
  execArgv: string[];
  argv: string[];
}

export function buildRespawnCommand(proc: ProcessSnapshot): { command: string; args: string[] } {
  return { command: proc.execPath, args: [...replayableFlags(proc), ...proc.argv.slice(1)] };
}

/**
 * Same runtime, same entry script, different subcommand — for starting a
 * sibling process (the update worker) rather than a copy of this one.
 */
export function buildWorkerCommand(proc: ProcessSnapshot, workerArgs: string[]): { command: string; args: string[] } {
  const entry = proc.argv[1];
  return {
    command: proc.execPath,
    args: [...replayableFlags(proc), ...(entry ? [entry] : []), ...workerArgs],
  };
}

function replayableFlags(proc: ProcessSnapshot): string[] {
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
  return flags;
}

/**
 * Hand the update over to a detached worker: spawn it, give it a moment to
 * prove it started, and only then let the caller exit. Unlike a self-respawn
 * this child is not the successor — it is an independent process that will
 * start the successor once the code is swapped, so it cannot die with us.
 */
export function spawnUpdateWorker(graceMs = 3000): Promise<boolean> {
  const { command, args } = buildWorkerCommand(process, ['update-worker']);
  const { key, value } = encodeRestartArgv(process.argv.slice(2));
  return spawnDetachedAndConfirm(command, args, graceMs, 'update worker', { [key]: value });
}

/** Same handover, without touching the code — for `/restart` from chat. */
export function spawnRestartWorker(graceMs = 3000): Promise<boolean> {
  const { command, args } = buildWorkerCommand(process, ['update-worker']);
  const argv = encodeRestartArgv(process.argv.slice(2));
  const mode = encodeWorkerMode('restart');
  return spawnDetachedAndConfirm(command, args, graceMs, 'restart worker', {
    [argv.key]: argv.value,
    [mode.key]: mode.value,
  });
}

/**
 * Start the replacement process and hand over. Resolves to false when the
 * child dies within `graceMs`, in which case the caller must stay alive: the
 * running process is the only one left, even if its code is now stale.
 */
export function respawnSelf(graceMs = 3000): Promise<boolean> {
  const { command, args } = buildRespawnCommand(process);
  return spawnDetachedAndConfirm(command, args, graceMs, 'replacement');
}

function spawnDetachedAndConfirm(
  command: string,
  args: string[],
  graceMs: number,
  what: string,
  extraEnv?: Record<string, string>,
): Promise<boolean> {
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
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
        ...buildRespawnOptions(process.platform),
      });

      child.on('error', (err) => {
        log.error(`self_update: ${what} failed to start: ${err.message}`);
        done(false);
      });
      child.on('exit', (code, signal) => {
        log.error(`self_update: ${what} died immediately (code=${code}, signal=${signal})`);
        done(false);
      });

      // Survived the grace period — treat it as up and let the parent go.
      setTimeout(() => {
        if (settled) return;
        child.unref();
        done(true);
      }, graceMs).unref();
    } catch (err) {
      log.error(`self_update: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      done(false);
    }
  });
}
