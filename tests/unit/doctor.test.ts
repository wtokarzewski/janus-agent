import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDoctorChecks } from '../../src/commands/doctor.js';
import { Database } from '../../src/db/database.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'janus-doctor-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('doctor core checks', () => {
  it('reports missing janus.json as fail', () => {
    const results = runDoctorChecks(tempDir);
    expect(results.find(r => r.name === 'config')?.status).toBe('fail');
  });

  it('reports healthy workspace', () => {
    writeFileSync(join(tempDir, 'janus.json'), '{}');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const db = new Database(join(tempDir, '.janus', 'janus.db'));
    db.close();
    mkdirSync(join(tempDir, 'memory'), { recursive: true });
    mkdirSync(join(tempDir, 'sessions'), { recursive: true });
    const results = runDoctorChecks(tempDir);
    expect(results.find(r => r.name === 'config')?.status).toBe('pass');
    expect(results.find(r => r.name === 'database')?.status).toBe('pass');
  });

  it('reports missing database as fail', () => {
    writeFileSync(join(tempDir, 'janus.json'), '{}');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const results = runDoctorChecks(tempDir);
    expect(results.find(r => r.name === 'database')?.status).toBe('fail');
  });

  it('auto-creates missing dirs and reports fixed', () => {
    writeFileSync(join(tempDir, 'janus.json'), '{}');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const db = new Database(join(tempDir, '.janus', 'janus.db'));
    db.close();
    const results = runDoctorChecks(tempDir);
    expect(results.find(r => r.name === 'directories')?.status).toBe('fixed');
  });

  it('reports missing auth.json as warn (fresh install)', () => {
    writeFileSync(join(tempDir, 'janus.json'), '{}');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const db = new Database(join(tempDir, '.janus', 'janus.db'));
    db.close();
    const results = runDoctorChecks(tempDir);
    expect(results.find(r => r.name === 'auth')?.status).toBe('warn');
  });

  it('reports undecryptable auth as fail', () => {
    writeFileSync(join(tempDir, 'janus.json'), '{}');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const db = new Database(join(tempDir, '.janus', 'janus.db'));
    db.close();
    writeFileSync(
      join(tempDir, '.janus', 'auth.json'),
      JSON.stringify({ _encrypted: true, salt: 'a', iv: 'b', tag: 'c', data: 'd' }),
    );
    const results = runDoctorChecks(tempDir);
    const auth = results.find(r => r.name === 'auth');
    expect(auth?.status).toBe('fail');
    expect(auth?.message).toContain('cannot be decrypted');
  });

  it('GWS is diagnostic, never fail', () => {
    writeFileSync(join(tempDir, 'janus.json'), '{}');
    mkdirSync(join(tempDir, '.janus'), { recursive: true });
    const db = new Database(join(tempDir, '.janus', 'janus.db'));
    db.close();
    mkdirSync(join(tempDir, 'memory'), { recursive: true });
    mkdirSync(join(tempDir, 'sessions'), { recursive: true });
    const results = runDoctorChecks(tempDir);
    const gws = results.find(r => r.name === 'gws');
    expect(gws?.category).toBe('diagnostic');
  });
});
