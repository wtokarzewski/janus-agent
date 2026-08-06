/**
 * How the gateway was started, carried across the update.
 *
 * The worker starts the new gateway, so it has to know how the old one was
 * launched — `gateway --token-debug` must come back as `gateway --token-debug`,
 * not a bare default. Passed through the environment rather than as arguments,
 * because the CLI parser would try to interpret the flags as its own.
 */
const ENV_KEY = 'JANUS_RESTART_ARGV';

export function encodeRestartArgv(argv: string[]): { key: string; value: string } {
  return { key: ENV_KEY, value: JSON.stringify(argv) };
}

export function restartArgvFromEnv(env: Record<string, string | undefined>): string[] {
  const raw = env[ENV_KEY];
  if (!raw) return ['gateway'];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(a => typeof a === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through to the default
  }
  return ['gateway'];
}

/** What the worker was started for. */
export type WorkerMode = 'update' | 'restart';

const MODE_KEY = 'JANUS_WORKER_MODE';

export function encodeWorkerMode(mode: WorkerMode): { key: string; value: string } {
  return { key: MODE_KEY, value: mode };
}

export function workerModeFromEnv(env: Record<string, string | undefined>): WorkerMode {
  return env[MODE_KEY] === 'restart' ? 'restart' : 'update';
}
