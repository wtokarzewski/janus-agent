// Configuration and update-job changes used by the Windows voice trial installer.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function readObject(file) {
  if (!existsSync(file)) return {};
  let value;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`Invalid JSON in ${file}; file was not changed`); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`Expected an object in ${file}`);
  return value;
}
function writeJson(file, value) {
  const temporary = `${file}.voice-${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, file);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function inspect(repo) {
  const user = readObject(join(repo, '.janus', 'config.json'));
  const config = readObject(join(repo, 'janus.json'));
  const workspace = resolve(repo, config.workspace?.dir ?? user.workspace?.dir ?? '.');
  return {
    pidFile: join(workspace, '.janus', 'gateway.pid'),
    database: resolve(workspace, config.database?.path ?? user.database?.path ?? '.janus/janus.db'),
  };
}
function openDatabase(repo, file) {
  if (!existsSync(file)) return null;
  const require = createRequire(join(repo, 'package.json'));
  const Database = require('better-sqlite3');
  return new Database(file, { fileMustExist: true });
}
export function apply(repo, directory, tools) {
  const file = join(repo, 'janus.json');
  const backupFile = join(directory, 'configuration.json');
  if (existsSync(backupFile)) throw new Error('Configuration backup already exists. Restore the previous trial first.');
  const original = readObject(file);
  const voice = readObject(join(tools, 'voice-config.json')).voice;
  if (voice?.provider !== 'local' || voice.enabled !== true) throw new Error('Invalid local voice tool configuration');
  const info = inspect(repo);
  const db = openDatabase(repo, info.database);
  try {
    const hasCron = db?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cron_jobs'").get();
    const jobs = hasCron ? db.prepare("SELECT id, enabled FROM cron_jobs WHERE name='self_update:check'").all() : [];
    // Write the recovery record before the first mutation. Preserve an exact copy too.
    if (existsSync(file)) writeFileSync(join(directory, 'janus.json.original'), readFileSync(file), { mode: 0o600 });
    writeJson(backupFile, { original, existed: existsSync(file), database: info.database, jobs });
    if (hasCron) db.prepare("UPDATE cron_jobs SET enabled=0 WHERE name='self_update:check'").run();
    writeJson(file, { ...original, voice, autoUpdate: { ...original.autoUpdate, enabled: false } });
  } finally { db?.close(); }
}
export function restore(repo, directory) {
  const backupFile = join(directory, 'configuration.json');
  if (!existsSync(backupFile)) return;
  const saved = readObject(backupFile);
  const file = join(repo, 'janus.json');
  const config = readObject(file);
  if (Object.hasOwn(saved.original, 'voice')) config.voice = saved.original.voice;
  else delete config.voice;
  // Restore only the field we changed; retain other edits made during the trial.
  if (Object.hasOwn(saved.original.autoUpdate ?? {}, 'enabled')) {
    config.autoUpdate = { ...config.autoUpdate, enabled: saved.original.autoUpdate.enabled };
  } else if (config.autoUpdate) {
    delete config.autoUpdate.enabled;
    if (Object.keys(config.autoUpdate).length === 0 && !Object.hasOwn(saved.original, 'autoUpdate')) delete config.autoUpdate;
  }
  const db = openDatabase(repo, saved.database);
  try {
    if (saved.jobs.length && !db) throw new Error('Original database is missing; update-job state could not be restored');
    if (db && saved.jobs.length) db.transaction(() => {
      const update = db.prepare("UPDATE cron_jobs SET enabled=? WHERE id=? AND name='self_update:check'");
      for (const job of saved.jobs) update.run(job.enabled, job.id);
    })();
    if (!saved.existed && Object.keys(config).length === 0) { if (existsSync(file)) unlinkSync(file); }
    else writeJson(file, config);
  } finally { db?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, repo, directory, tools] = process.argv.slice(2);
  try {
    if (action === 'inspect') console.log(JSON.stringify(inspect(repo)));
    else if (action === 'apply') apply(repo, directory, tools);
    else if (action === 'restore') restore(repo, directory);
    else throw new Error('Unknown setup action');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
