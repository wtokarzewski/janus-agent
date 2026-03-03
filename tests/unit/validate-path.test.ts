import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validatePath } from '../../src/tools/validate-path.js';

describe('validatePath', () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    const base = join(tmpdir(), `vp-test-${randomUUID().slice(0, 8)}`);
    workspace = join(base, 'workspace');
    outside = join(base, 'outside');
    mkdirSync(join(workspace, 'subdir'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(workspace, 'file.txt'), 'hello');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
  });

  afterEach(() => {
    const base = join(workspace, '..');
    rmSync(base, { recursive: true, force: true });
  });

  it('allows normal paths within workspace', () => {
    const result = validatePath(workspace, 'file.txt');
    expect(result).toBe(join(realpathSync(workspace), 'file.txt'));
  });

  it('allows subdirectory paths', () => {
    writeFileSync(join(workspace, 'subdir', 'nested.txt'), 'nested');
    const result = validatePath(workspace, 'subdir/nested.txt');
    expect(result).toBe(join(realpathSync(workspace), 'subdir', 'nested.txt'));
  });

  it('allows workspace root itself', () => {
    const result = validatePath(workspace, '.');
    expect(result).toBe(realpathSync(workspace));
  });

  it('blocks .. escape', () => {
    expect(() => validatePath(workspace, '../outside/secret.txt')).toThrow('Path escapes workspace');
  });

  it('blocks absolute path outside workspace', () => {
    expect(() => validatePath(workspace, outside + '/secret.txt')).toThrow('Path escapes workspace');
  });

  it('blocks symlink pointing outside workspace', () => {
    symlinkSync(outside, join(workspace, 'evil-link'));
    expect(() => validatePath(workspace, 'evil-link/secret.txt')).toThrow('Path escapes workspace');
  });

  it('allows symlink pointing inside workspace', () => {
    symlinkSync(join(workspace, 'subdir'), join(workspace, 'good-link'));
    const result = validatePath(workspace, 'good-link');
    expect(result).toBe(realpathSync(join(workspace, 'subdir')));
  });

  it('allows non-existing file inside workspace (write case)', () => {
    const result = validatePath(workspace, 'newfile.txt');
    expect(result).toBe(join(realpathSync(workspace), 'newfile.txt'));
  });

  it('allows non-existing file in existing subdir', () => {
    const result = validatePath(workspace, 'subdir/newfile.txt');
    expect(result).toBe(join(realpathSync(workspace), 'subdir', 'newfile.txt'));
  });

  it('blocks non-existing file via .. escape', () => {
    expect(() => validatePath(workspace, '../outside/newfile.txt')).toThrow('Path escapes workspace');
  });

  it('handles workspace that is itself a symlink', () => {
    const base = join(workspace, '..');
    const wsLink = join(base, 'ws-link');
    symlinkSync(workspace, wsLink);
    const result = validatePath(wsLink, 'file.txt');
    expect(result).toBe(join(realpathSync(workspace), 'file.txt'));
  });
});
