import { describe, it, expect } from 'vitest';
import { buildRespawnCommand, buildRespawnOptions } from '../../src/utils/respawn.js';

describe('buildRespawnCommand', () => {
  it('keeps the node flags that started this process', () => {
    // tsx injects itself through execArgv, not NODE_OPTIONS. Dropping it
    // respawns a plain `node src/index.ts`, which dies on the first import.
    const cmd = buildRespawnCommand({
      execPath: '/usr/bin/node',
      execArgv: ['--require', '/app/node_modules/tsx/dist/preflight.cjs', '--import', 'file:///app/node_modules/tsx/dist/loader.mjs'],
      argv: ['/usr/bin/node', '/app/src/index.ts', 'gateway'],
    });

    expect(cmd).toEqual({
      command: '/usr/bin/node',
      args: [
        '--require', '/app/node_modules/tsx/dist/preflight.cjs',
        '--import', 'file:///app/node_modules/tsx/dist/loader.mjs',
        '/app/src/index.ts', 'gateway',
      ],
    });
  });

  it('passes a plain node invocation through unchanged', () => {
    const cmd = buildRespawnCommand({
      execPath: '/usr/bin/node',
      execArgv: [],
      argv: ['/usr/bin/node', '/app/dist/index.js', 'gateway'],
    });

    expect(cmd).toEqual({ command: '/usr/bin/node', args: ['/app/dist/index.js', 'gateway'] });
  });

  it('drops --eval flags, which cannot be replayed', () => {
    // `node -e "..."` has no script to restart; keeping the flag would rerun
    // the snippet instead of the app.
    const cmd = buildRespawnCommand({
      execPath: '/usr/bin/node',
      execArgv: ['--import', 'file:///app/loader.mjs', '--eval', 'console.log(1)'],
      argv: ['/usr/bin/node', '/app/src/index.ts'],
    });

    expect(cmd.args).toEqual(['--import', 'file:///app/loader.mjs', '/app/src/index.ts']);
  });
});

describe('buildRespawnOptions', () => {
  it('detaches from the console on Windows', () => {
    // npm tears down its process tree when the parent exits, taking a child
    // that shares the console with it — the replacement died the moment the
    // old process left, after surviving its grace period.
    const opts = buildRespawnOptions('win32');

    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.windowsHide).toBe(true);
  });

  it('keeps inherited output elsewhere', () => {
    const opts = buildRespawnOptions('linux');

    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('inherit');
  });
});
