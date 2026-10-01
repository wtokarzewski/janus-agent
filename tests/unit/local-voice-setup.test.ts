import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { apply, inspect, restore } from '../../scripts/local-voice-config.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'voice-setup-'));
  roots.push(repo);
  for (const dir of ['.janus', 'backup', 'tools']) mkdirSync(join(repo, dir));
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(repo, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const backup = join(repo, 'backup'), tools = join(repo, 'tools');
  const voice = { enabled: true, provider: 'local', language: 'pl', local: { modelPath: 'C:/dane głosu/model.bin' } };
  writeFileSync(join(tools, 'voice-config.json'), JSON.stringify({ voice }));
  return { repo, backup, tools, voice, config: join(repo, 'janus.json') };
}
it('merges voice without losing credentials/settings and restores jobs without overwriting other user changes', () => {
  const f = fixture();
  const original = { llm: { apiKey: 'fixture-secret' }, telegram: { token: 'fixture-token' }, voice: { enabled: false }, autoUpdate: { enabled: true, schedule: '0 6 * * *' }, note: 'Zażółć' };
  const raw = JSON.stringify(original);
  writeFileSync(f.config, raw);
  const db = new Database(join(f.repo, '.janus', 'janus.db'));
  try {
    db.exec("CREATE TABLE cron_jobs(id TEXT PRIMARY KEY, name TEXT, enabled INTEGER); INSERT INTO cron_jobs VALUES ('update1','self_update:check',1), ('update2','self_update:check',0), ('reminder','hello',1)");
    apply(f.repo, f.backup, f.tools);
    expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual({ ...original, voice: f.voice, autoUpdate: { ...original.autoUpdate, enabled: false } });
    expect(readFileSync(join(f.backup, 'janus.json.original'), 'utf8')).toBe(raw);
    expect(db.prepare('SELECT enabled FROM cron_jobs ORDER BY id').all()).toEqual([{ enabled: 1 }, { enabled: 0 }, { enabled: 0 }]);
    const current = JSON.parse(readFileSync(f.config, 'utf8'));
    current.note = 'changed after installation';
    current.autoUpdate.schedule = '0 8 * * *';
    writeFileSync(f.config, JSON.stringify(current));
    db.exec("UPDATE cron_jobs SET enabled=0 WHERE id='reminder'");
    restore(f.repo, f.backup);
    expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual({ ...original, note: current.note, autoUpdate: { ...original.autoUpdate, schedule: current.autoUpdate.schedule } });
    expect(db.prepare('SELECT enabled FROM cron_jobs ORDER BY id').all()).toEqual([{ enabled: 0 }, { enabled: 1 }, { enabled: 0 }]);
    restore(f.repo, f.backup); // recovery is idempotent
  } finally { db.close(); }
});
it('rejects malformed configuration without replacing it or creating a backup', () => {
  const f = fixture();
  writeFileSync(f.config, '{BROKEN');
  expect(() => apply(f.repo, f.backup, f.tools)).toThrow('Invalid JSON');
  expect(readFileSync(f.config, 'utf8')).toBe('{BROKEN');
  expect(existsSync(join(f.backup, 'configuration.json'))).toBe(false);
});
it('retains the first recovery record and supports configuration inherited from .janus', () => {
  const f = fixture();
  writeFileSync(join(f.repo, '.janus', 'config.json'), JSON.stringify({ workspace: { dir: 'data' }, database: { path: 'alternate.db' } }));
  expect(inspect(f.repo)).toEqual({ pidFile: join(f.repo, 'data', '.janus', 'gateway.pid'), database: join(f.repo, 'data', 'alternate.db') });
  apply(f.repo, f.backup, f.tools);
  expect(() => apply(f.repo, f.backup, f.tools)).toThrow('backup already exists');
  restore(f.repo, f.backup);
  expect(existsSync(f.config)).toBe(false);
  apply(f.repo, join(f.repo, 'tools'), f.tools);
  const current = JSON.parse(readFileSync(f.config, 'utf8'));
  current.newSetting = 'keep';
  writeFileSync(f.config, JSON.stringify(current));
  restore(f.repo, join(f.repo, 'tools'));
  expect(JSON.parse(readFileSync(f.config, 'utf8'))).toEqual({ newSetting: 'keep' });
});
