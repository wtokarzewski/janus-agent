import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForGatewayExit } from '../../src/utils/gateway-exit.js';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'janus-lock-'));
  mkdirSync(join(dir, '.janus'), { recursive: true });
  return dir;
}

describe('waitForGatewayExit', () => {
  it('returns immediately when no gateway is recorded', async () => {
    const dir = workspace();
    try {
      expect(await waitForGatewayExit(dir, 1000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns once the recorded process is gone', async () => {
    const dir = workspace();
    // A pid that cannot be alive: the file is stale, so there is nothing to wait for.
    writeFileSync(join(dir, '.janus', 'gateway.pid'), '999999', 'utf-8');
    try {
      expect(await waitForGatewayExit(dir, 1000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up when the gateway is still running', async () => {
    const dir = workspace();
    // Our own pid is alive by definition — the update must not start under it.
    writeFileSync(join(dir, '.janus', 'gateway.pid'), String(process.pid), 'utf-8');
    try {
      expect(await waitForGatewayExit(dir, 300)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
