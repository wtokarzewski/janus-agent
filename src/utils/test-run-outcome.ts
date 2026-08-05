/**
 * Did the test suite actually run and fail, or did the runner never get there?
 *
 * `update` and `self_update` revert the workspace when tests fail. A timeout, a
 * blown output buffer or a missing binary is not a verdict on the new code —
 * reverting on those throws away a good update, and on a slow machine
 * (Windows, cold cache, antivirus in the loop) it happens every time.
 */
export type TestRunOutcome = 'failed' | 'inconclusive';

export function classifyTestRun(err: unknown): TestRunOutcome {
  const e = err as { code?: unknown; killed?: boolean; signal?: string } | null;
  if (!e) return 'inconclusive';

  // Killed by the timeout — the suite never reported anything.
  if (e.killed || e.signal) return 'inconclusive';

  // A numeric exit code comes from the test runner itself: a real verdict.
  if (typeof e.code === 'number') return 'failed';

  // String codes are Node/OS level: ENOENT, EACCES, ERR_CHILD_PROCESS_STDIO_MAXBUFFER…
  return 'inconclusive';
}
