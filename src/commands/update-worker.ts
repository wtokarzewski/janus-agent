/**
 * Update worker — the process that updates Janus while Janus is not running.
 *
 * A dying process is a terrible place to start its successor: on Windows the
 * replacement shares npm's process tree and dies with it, and everywhere else
 * it is racing its own shutdown. So the gateway hands over instead: it spawns
 * this worker detached, exits, and this worker — which nobody is about to kill
 * — swaps the code and starts a fresh gateway.
 *
 * Its one hard rule: whatever happens to the update, a gateway must be running
 * when this process ends.
 */

import { spawn } from 'node:child_process';
import * as log from '../utils/logger.js';
import { waitForGatewayExit } from '../utils/gateway-exit.js';
import { buildRespawnCommand, buildRespawnOptions } from '../utils/respawn.js';
import { restartArgvFromEnv, workerModeFromEnv } from '../utils/restart-argv.js';

/** How long to let the old gateway finish flushing before touching its files. */
const GATEWAY_EXIT_TIMEOUT_MS = 60_000;

export async function runUpdateWorker(opts: { workspaceDir?: string } = {}): Promise<void> {
  const workspaceDir = opts.workspaceDir ?? process.cwd();
  log.info('update-worker: waiting for the gateway to exit...');

  const gone = await waitForGatewayExit(workspaceDir, GATEWAY_EXIT_TIMEOUT_MS);
  if (!gone) {
    // Updating underneath a live gateway risks half-loaded modules; the running
    // instance is healthier than a broken one, so leave it alone.
    log.error('update-worker: gateway is still running after 60s — aborting the update, nothing was changed.');
    return;
  }

  const mode = workerModeFromEnv(process.env);
  if (mode === 'restart') {
    // A plain restart from chat: same handover, no code changes.
    log.info('update-worker: restart requested — skipping the update');
    startGateway();
    return;
  }

  try {
    const { runUpdate } = await import('./update.js');
    await runUpdate({ throwOnFailure: true });
    log.info('update-worker: update finished');
  } catch (err) {
    log.error(`update-worker: update failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    startGateway();
  }
}

/** Start a gateway and let it outlive this worker. */
function startGateway(): void {
  // Replay how the gateway was actually started — `gateway --token-debug` must
  // come back with its flags, not as a bare default.
  const gatewayArgv = restartArgvFromEnv(process.env);
  const { command, args } = buildRespawnCommand({
    execPath: process.execPath,
    execArgv: process.execArgv,
    // argv[1] is this same entry script; the worker subcommand is replaced.
    argv: [process.execPath, process.argv[1], ...gatewayArgv],
  });

  log.info(`update-worker: starting the gateway (${gatewayArgv.join(' ')})`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    ...buildRespawnOptions(process.platform),
  });
  child.unref();
}
