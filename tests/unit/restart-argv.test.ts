import { describe, it, expect } from 'vitest';
import { encodeRestartArgv, restartArgvFromEnv } from '../../src/utils/restart-argv.js';

describe('restart argv round-trip', () => {
  it('carries the flags the gateway was started with', () => {
    // `npm start -- gateway --token-debug`: the worker must start the gateway
    // the same way, not with a bare default.
    const env = { [encodeRestartArgv(['gateway', '--token-debug']).key]: encodeRestartArgv(['gateway', '--token-debug']).value };

    expect(restartArgvFromEnv(env)).toEqual(['gateway', '--token-debug']);
  });

  it('falls back to a plain gateway when nothing was passed', () => {
    expect(restartArgvFromEnv({})).toEqual(['gateway']);
  });

  it('falls back when the value is not usable', () => {
    expect(restartArgvFromEnv({ JANUS_RESTART_ARGV: 'not json' })).toEqual(['gateway']);
    expect(restartArgvFromEnv({ JANUS_RESTART_ARGV: '{"a":1}' })).toEqual(['gateway']);
    expect(restartArgvFromEnv({ JANUS_RESTART_ARGV: '[]' })).toEqual(['gateway']);
    expect(restartArgvFromEnv({ JANUS_RESTART_ARGV: '[1,2]' })).toEqual(['gateway']);
  });
});

describe('worker mode', () => {
  it('updates by default', async () => {
    const { workerModeFromEnv } = await import('../../src/utils/restart-argv.js');
    expect(workerModeFromEnv({})).toBe('update');
  });

  it('restarts without updating when asked', async () => {
    const { workerModeFromEnv } = await import('../../src/utils/restart-argv.js');
    expect(workerModeFromEnv({ JANUS_WORKER_MODE: 'restart' })).toBe('restart');
  });

  it('falls back to updating on an unknown mode', async () => {
    const { workerModeFromEnv } = await import('../../src/utils/restart-argv.js');
    expect(workerModeFromEnv({ JANUS_WORKER_MODE: 'nonsense' })).toBe('update');
  });
});
