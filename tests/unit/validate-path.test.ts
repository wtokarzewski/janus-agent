import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { validatePath, validateUserFileAccess } from '../../src/tools/validate-path.js';

const isWindows = process.platform === 'win32';

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

  it.skipIf(isWindows)('blocks symlink pointing outside workspace', () => {
    symlinkSync(outside, join(workspace, 'evil-link'));
    expect(() => validatePath(workspace, 'evil-link/secret.txt')).toThrow('Path escapes workspace');
  });

  it.skipIf(isWindows)('allows symlink pointing inside workspace', () => {
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

  it.skipIf(isWindows)('handles workspace that is itself a symlink', () => {
    const base = join(workspace, '..');
    const wsLink = join(base, 'ws-link');
    symlinkSync(workspace, wsLink);
    const result = validatePath(wsLink, 'file.txt');
    expect(result).toBe(join(realpathSync(workspace), 'file.txt'));
  });

});

describe('validateUserFileAccess', () => {
  const ws = '/home/app';
  const janus = '/home/app/.janus';

  it('allows system context (no userId) to access everything', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/auth.json`, undefined, undefined, 'write')).not.toThrow();
    expect(() => validateUserFileAccess(ws, `${janus}/users/maciek/files/note.txt`, undefined, undefined, 'read')).not.toThrow();
  });

  it('allows paths outside .janus/ (non-protected dirs)', () => {
    expect(() => validateUserFileAccess(ws, '/home/app/skills/test/SKILL.md', 'wojtek', undefined, 'write')).not.toThrow();
    expect(() => validateUserFileAccess(ws, '/home/app/AGENTS.md', 'wojtek', undefined, 'write')).not.toThrow();
  });

  it('blocks access to sessions/ directory', () => {
    expect(() => validateUserFileAccess(ws, '/home/app/sessions/telegram_123.jsonl', 'wojtek', undefined, 'read')).toThrow('Access denied');
    expect(() => validateUserFileAccess(ws, '/home/app/sessions/telegram_123.jsonl', 'wojtek', undefined, 'write')).toThrow('Access denied');
  });

  it('blocks access to memory/ directory', () => {
    expect(() => validateUserFileAccess(ws, '/home/app/memory/HISTORY.md', 'wojtek', undefined, 'read')).toThrow('Access denied');
    expect(() => validateUserFileAccess(ws, '/home/app/memory/2026-03-07.md', 'wojtek', undefined, 'write')).toThrow('Access denied');
  });

  it('allows system context to access sessions and memory', () => {
    expect(() => validateUserFileAccess(ws, '/home/app/sessions/telegram_123.jsonl', undefined, undefined, 'read')).not.toThrow();
    expect(() => validateUserFileAccess(ws, '/home/app/memory/HISTORY.md', undefined, undefined, 'read')).not.toThrow();
  });

  it('allows user to access own directory', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/users/wojtek/files/note.txt`, 'wojtek', undefined, 'write')).not.toThrow();
    expect(() => validateUserFileAccess(ws, `${janus}/users/wojtek/PROFILE.md`, 'wojtek', undefined, 'read')).not.toThrow();
  });

  it('blocks user from accessing another user directory', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/users/monika/files/diary.txt`, 'wojtek', undefined, 'read')).toThrow('Access denied');
    expect(() => validateUserFileAccess(ws, `${janus}/users/monika/PROFILE.md`, 'wojtek', undefined, 'write')).toThrow('Access denied');
  });

  it('allows read access to .janus/ root files', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/EGO.md`, 'wojtek', undefined, 'read')).not.toThrow();
  });

  it('blocks write access to .janus/ root files', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/EGO.md`, 'wojtek', undefined, 'write')).toThrow('Access denied');
    expect(() => validateUserFileAccess(ws, `${janus}/auth.json`, 'wojtek', undefined, 'write')).toThrow('Access denied');
    expect(() => validateUserFileAccess(ws, `${janus}/random-file.txt`, 'wojtek', undefined, 'write')).toThrow('Access denied');
  });

  it('allows access to matching chat directory', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/chats/-100123/files/shopping.md`, 'wojtek', '-100123', 'write')).not.toThrow();
    expect(() => validateUserFileAccess(ws, `${janus}/chats/-100123/files/shopping.md`, 'wojtek', '-100123', 'read')).not.toThrow();
  });

  it('blocks access to non-matching chat directory', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/chats/-100999/files/secret.md`, 'wojtek', '-100123', 'read')).toThrow('Access denied');
    expect(() => validateUserFileAccess(ws, `${janus}/chats/-100999/files/secret.md`, 'wojtek', undefined, 'read')).toThrow('Access denied');
  });

  it('sanitizes chatId with forum topic (/ → _)', () => {
    expect(() => validateUserFileAccess(ws, `${janus}/chats/-100123_42/files/topic.md`, 'wojtek', '-100123/42', 'write')).not.toThrow();
  });
});
