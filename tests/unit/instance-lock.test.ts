/**
 * Gateway instance lock — a second gateway must not run against the same
 * workspace (shared cron table → silently lost reminders).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  acquireInstanceLock,
  releaseInstanceLock,
  isPidAlive,
  lockFilePath,
} from '../../src/utils/instance-lock.js';
import { createTempDir } from '../helpers/test-fixtures.js';

/** A PID that is (practically) guaranteed dead — max pid on Linux is 4194304. */
const DEAD_PID = 4_099_999;

describe('instance lock', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires when no lock file exists', async () => {
    const result = await acquireInstanceLock(dir);
    expect(result.acquired).toBe(true);
    expect(readFileSync(lockFilePath(dir), 'utf-8').trim()).toBe(String(process.pid));
  });

  it('takes over a stale lock from a dead pid', async () => {
    const path = lockFilePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(DEAD_PID));

    const result = await acquireInstanceLock(dir);
    expect(result.acquired).toBe(true);
    expect(readFileSync(path, 'utf-8').trim()).toBe(String(process.pid));
  });

  it('refuses when a live process holds the lock', async () => {
    const path = lockFilePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid));

    // Pretend to be a different process trying to start
    const result = await acquireInstanceLock(dir, { waitMs: 0, pid: process.pid + 1 });
    expect(result.acquired).toBe(false);
    expect(result.holderPid).toBe(process.pid);
  });

  it('re-acquires its own lock (idempotent restart within same pid)', async () => {
    await acquireInstanceLock(dir);
    const again = await acquireInstanceLock(dir, { waitMs: 0 });
    expect(again.acquired).toBe(true);
  });

  it('releases only when owned', async () => {
    const path = lockFilePath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid + 1));

    await releaseInstanceLock(dir); // not the owner — must not delete
    expect(readFileSync(path, 'utf-8').trim()).toBe(String(process.pid + 1));

    writeFileSync(path, String(process.pid));
    await releaseInstanceLock(dir);
    expect(() => readFileSync(path, 'utf-8')).toThrow();
  });

  it('isPidAlive: own pid alive, absurd pid dead', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(DEAD_PID)).toBe(false);
    expect(isPidAlive(-5)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
  });
});
