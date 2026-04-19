import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extract as tarExtract, create as tarCreate } from 'tar';
import { sha256File, assertPathSafe, collectFiles } from '../../src/commands/backup-utils.js';
import { PathTraversalError, AuthDecryptionError, UnsupportedFormatVersionError } from '../../src/commands/backup-errors.js';
import { Database } from '../../src/db/database.js';
import { createBackupArchive, verifyArchive } from '../../src/commands/backup.js';
import { restoreFromArchive, readManifest } from '../../src/commands/restore.js';

describe('backup-utils', () => {
  it('sha256File computes correct hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sha-test-'));
    writeFileSync(join(dir, 'test.txt'), 'hello world');
    expect(sha256File(join(dir, 'test.txt'))).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    rmSync(dir, { recursive: true, force: true });
  });

  it('assertPathSafe allows normal paths', () => {
    expect(() => assertPathSafe('workspace/janus.json', '/tmp/restore')).not.toThrow();
    expect(() => assertPathSafe('.janus/auth.json', '/tmp/restore')).not.toThrow();
  });

  it('assertPathSafe rejects path traversal', () => {
    expect(() => assertPathSafe('../../etc/passwd', '/tmp/restore')).toThrow(PathTraversalError);
    expect(() => assertPathSafe('../../../root/.ssh/id_rsa', '/tmp/restore')).toThrow(PathTraversalError);
  });

  it('collectFiles skips symlinks with warning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'collect-test-'));
    writeFileSync(join(dir, 'real.txt'), 'content');
    try { symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt')); } catch { /* Windows */ }
    const { files, warnings } = collectFiles(dir, dir);
    expect(files).toContain('real.txt');
    // On platforms that support symlinks, the link should be skipped
    if (warnings.length > 0) {
      expect(warnings[0]).toContain('symlink');
      expect(files).not.toContain('link.txt');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('collectFiles respects exclude list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exclude-test-'));
    writeFileSync(join(dir, 'keep.txt'), 'a');
    mkdirSync(join(dir, 'Cache'), { recursive: true });
    writeFileSync(join(dir, 'Cache', 'file.bin'), 'b');
    const { files } = collectFiles(dir, dir, ['Cache']);
    expect(files).toContain('keep.txt');
    expect(files.some(f => f.includes('Cache'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('backup', () => {
  let srcDir: string;
  let outDir: string;

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'janus-backup-src-'));
    outDir = mkdtempSync(join(tmpdir(), 'janus-backup-out-'));
    writeFileSync(join(srcDir, 'janus.json'), '{"llm":{}}');
    mkdirSync(join(srcDir, '.janus'), { recursive: true });
    writeFileSync(join(srcDir, '.janus', 'auth.json'), '{"anthropic":{"type":"api_key","key":"sk-test"}}');
    const db = new Database(join(srcDir, '.janus', 'janus.db'));
    db.close();
    mkdirSync(join(srcDir, 'memory'), { recursive: true });
    writeFileSync(join(srcDir, 'memory', 'MEMORY.md'), '# Memory');
    mkdirSync(join(srcDir, 'sessions'), { recursive: true });
    writeFileSync(join(srcDir, 'sessions', 'test.jsonl'), '{"key":"test"}');
    writeFileSync(join(srcDir, 'AGENTS.md'), '# Agents');
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('creates archive with manifest and sha256 checksums', async () => {
    const archive = join(outDir, 'test.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    expect(existsSync(archive)).toBe(true);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.fileCount).toBe(manifest.files.length);
    expect(manifest.totalBytes).toBe(manifest.files.reduce((s, f) => s + f.size, 0));
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('uses db.backup() for SQLite snapshot', async () => {
    const archive = join(outDir, 'db.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    const extractDir = mkdtempSync(join(tmpdir(), 'extract-'));
    await tarExtract({ file: archive, cwd: extractDir });
    const root = readdirSync(extractDir)[0];
    const dbPath = join(extractDir, root, 'workspace', '.janus', 'janus.db');
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(dbPath, { readonly: true });
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
    rmSync(extractDir, { recursive: true, force: true });
  });

  it('encrypts auth with password', async () => {
    const archive = join(outDir, 'enc.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, password: 'secret' });
    const extractDir = mkdtempSync(join(tmpdir(), 'extract-'));
    await tarExtract({ file: archive, cwd: extractDir });
    const root = readdirSync(extractDir)[0];
    const auth = JSON.parse(readFileSync(join(extractDir, root, 'workspace', '.janus', 'auth.json'), 'utf-8'));
    expect(auth._backup_encrypted).toBe(true);
    expect(auth.digest).toBe('sha512');
    rmSync(extractDir, { recursive: true, force: true });
  });

  it('stores plain auth without password and warns', async () => {
    const archive = join(outDir, 'plain.tar.gz');
    const { manifest, warnings } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    expect(manifest.authMode).toBe('plain');
    expect(warnings.some(w => w.includes('unencrypted'))).toBe(true);
  });

  it('excludes sessions with includeSessions=false', async () => {
    const archive = join(outDir, 'nosess.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, includeSessions: false });
    expect(manifest.optionalSections.sessions).toBe(false);
    expect(manifest.files.some(f => f.path.includes('sessions/'))).toBe(false);
  });

  it('dry run does not create archive', async () => {
    const archive = join(outDir, 'dry.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, dryRun: true });
    expect(existsSync(archive)).toBe(false);
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  it('fails on undecryptable auth without --skip-auth', async () => {
    writeFileSync(join(srcDir, '.janus', 'auth.json'), JSON.stringify({ _encrypted: true, salt: 'aa', iv: 'bb', tag: 'cc', data: 'dd' }));
    const archive = join(outDir, 'fail.tar.gz');
    await expect(createBackupArchive({ workspaceDir: srcDir, outputPath: archive })).rejects.toThrow(AuthDecryptionError);
  });

  it('skips auth with skipAuth on undecryptable', async () => {
    writeFileSync(join(srcDir, '.janus', 'auth.json'), JSON.stringify({ _encrypted: true, salt: 'aa', iv: 'bb', tag: 'cc', data: 'dd' }));
    const archive = join(outDir, 'skip.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, skipAuth: true });
    expect(manifest.authIncluded).toBe(false);
  });
});

describe('verify', () => {
  let srcDir: string;
  let outDir: string;

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'verify-src-'));
    outDir = mkdtempSync(join(tmpdir(), 'verify-out-'));
    writeFileSync(join(srcDir, 'janus.json'), '{"llm":{}}');
    mkdirSync(join(srcDir, '.janus'), { recursive: true });
    const db = new Database(join(srcDir, '.janus', 'janus.db'));
    db.close();
    mkdirSync(join(srcDir, 'memory'), { recursive: true });
    writeFileSync(join(srcDir, 'memory', 'MEMORY.md'), '# Memory');
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('passes for valid archive', async () => {
    const archive = join(outDir, 'valid.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    const result = await verifyArchive(archive);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing manifest', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'bad-'));
    const root = join(badDir, 'janus-backup-bad');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'junk.txt'), 'x');
    const archive = join(outDir, 'nomanifest.tar.gz');
    await tarCreate({ gzip: true, file: archive, cwd: badDir }, ['janus-backup-bad']);
    const result = await verifyArchive(archive);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('manifest'))).toBe(true);
    rmSync(badDir, { recursive: true, force: true });
  });
});

describe('restore', () => {
  let srcDir: string;
  let tgtDir: string;

  beforeEach(async () => {
    srcDir = mkdtempSync(join(tmpdir(), 'restore-src-'));
    tgtDir = mkdtempSync(join(tmpdir(), 'restore-tgt-'));
    writeFileSync(join(srcDir, 'janus.json'), '{"llm":{}}');
    mkdirSync(join(srcDir, '.janus'), { recursive: true });
    writeFileSync(join(srcDir, '.janus', 'auth.json'), '{"anthropic":{"type":"api_key","key":"sk-test"}}');
    const db = new Database(join(srcDir, '.janus', 'janus.db'));
    db.close();
    mkdirSync(join(srcDir, 'memory'), { recursive: true });
    writeFileSync(join(srcDir, 'memory', 'MEMORY.md'), '# Memory');
    writeFileSync(join(srcDir, 'AGENTS.md'), '# Agents');
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(tgtDir, { recursive: true, force: true });
  });

  it('restores workspace files to empty target', async () => {
    const archive = join(srcDir, 'backup.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    await restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir });
    expect(existsSync(join(tgtDir, 'janus.json'))).toBe(true);
    expect(existsSync(join(tgtDir, '.janus', 'janus.db'))).toBe(true);
    expect(existsSync(join(tgtDir, 'memory', 'MEMORY.md'))).toBe(true);
  });

  it('re-encrypts auth with machine key', async () => {
    const archive = join(srcDir, 'backup.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    await restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir });
    const raw = readFileSync(join(tgtDir, '.janus', 'auth.json'), 'utf-8');
    expect(JSON.parse(raw)._encrypted).toBe(true);
  });

  it('restores password-protected backup', async () => {
    const archive = join(srcDir, 'enc.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, password: 'secret' });
    await restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir, password: 'secret' });
    expect(JSON.parse(readFileSync(join(tgtDir, '.janus', 'auth.json'), 'utf-8'))._encrypted).toBe(true);
  });

  it('fails with wrong password', async () => {
    const archive = join(srcDir, 'enc.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, password: 'correct' });
    await expect(restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir, password: 'wrong' })).rejects.toThrow();
  });

  it('rejects path traversal in manifest', async () => {
    const malDir = mkdtempSync(join(tmpdir(), 'mal-'));
    const root = join(malDir, 'janus-backup-evil');
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      formatVersion: 1, janusVersion: '0.1.0', createdAt: new Date().toISOString(),
      sourceHostname: 'x', sourcePlatform: 'x', sourceNodeVersion: '24',
      scope: 'full', authMode: 'plain', authIncluded: false,
      optionalSections: { sessions: false, chromeProfile: false },
      fileCount: 1, totalBytes: 5,
      files: [{ path: '../../etc/evil', size: 5, sha256: 'abc' }],
    }));
    const archive = join(malDir, 'evil.tar.gz');
    await tarCreate({ gzip: true, file: archive, cwd: malDir }, ['janus-backup-evil']);
    await expect(restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir })).rejects.toThrow(PathTraversalError);
    rmSync(malDir, { recursive: true, force: true });
  });

  it('rejects unsupported formatVersion', async () => {
    const badDir = mkdtempSync(join(tmpdir(), 'bad-'));
    const root = join(badDir, 'janus-backup-bad');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      formatVersion: 99, janusVersion: '0.1.0', createdAt: new Date().toISOString(),
      sourceHostname: 'x', sourcePlatform: 'x', sourceNodeVersion: '24',
      scope: 'full', authMode: 'plain', authIncluded: false,
      optionalSections: { sessions: false, chromeProfile: false },
      fileCount: 0, totalBytes: 0, files: [],
    }));
    const archive = join(badDir, 'bad.tar.gz');
    await tarCreate({ gzip: true, file: archive, cwd: badDir }, ['janus-backup-bad']);
    await expect(restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir })).rejects.toThrow(UnsupportedFormatVersionError);
    rmSync(badDir, { recursive: true, force: true });
  });

  it('reads manifest without full extract', async () => {
    const archive = join(srcDir, 'backup.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    const manifest = await readManifest(archive);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.files.length).toBeGreaterThan(0);
  });

  it('restores without auth when authIncluded=false', async () => {
    writeFileSync(join(srcDir, '.janus', 'auth.json'), JSON.stringify({ _encrypted: true, salt: 'a', iv: 'b', tag: 'c', data: 'd' }));
    const archive = join(srcDir, 'noauth.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, skipAuth: true });
    await restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir });
    expect(existsSync(join(tgtDir, '.janus', 'auth.json'))).toBe(false);
    expect(existsSync(join(tgtDir, 'janus.json'))).toBe(true);
  });

  it('rolls back overwritten files on restore failure', async () => {
    // Pre-existing files in target
    mkdirSync(join(tgtDir, 'memory'), { recursive: true });
    writeFileSync(join(tgtDir, 'janus.json'), '{"original":true}');
    writeFileSync(join(tgtDir, 'memory', 'MEMORY.md'), '# Original Memory');
    writeFileSync(join(tgtDir, 'AGENTS.md'), '# Original Agents');

    // Create a password-protected backup
    const archive = join(srcDir, 'rollback.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, password: 'secret' });

    // Restore with WRONG password — auth decryption will fail AFTER files are copied
    await expect(
      restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir, password: 'wrong' }),
    ).rejects.toThrow();

    // Original files should be restored via rollback
    expect(readFileSync(join(tgtDir, 'janus.json'), 'utf-8')).toBe('{"original":true}');
    expect(readFileSync(join(tgtDir, 'memory', 'MEMORY.md'), 'utf-8')).toBe('# Original Memory');
    expect(readFileSync(join(tgtDir, 'AGENTS.md'), 'utf-8')).toBe('# Original Agents');
  });

  it('restores over existing workspace with additive overwrite', async () => {
    // Pre-existing file in target
    mkdirSync(join(tgtDir, 'memory'), { recursive: true });
    writeFileSync(join(tgtDir, 'memory', 'EXTRA.md'), '# Extra');
    writeFileSync(join(tgtDir, 'janus.json'), '{"old":true}');

    const archive = join(srcDir, 'backup.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    await restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir });

    // Overwritten
    expect(readFileSync(join(tgtDir, 'janus.json'), 'utf-8')).toContain('llm');
    // Extra file preserved (additive)
    expect(existsSync(join(tgtDir, 'memory', 'EXTRA.md'))).toBe(true);
  });

  it('restores with noWorkspace skips workspace files', async () => {
    const archive = join(srcDir, 'backup.tar.gz');
    await createBackupArchive({ workspaceDir: srcDir, outputPath: archive });
    await restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir, noWorkspace: true });
    // Workspace files should NOT be restored
    expect(existsSync(join(tgtDir, 'janus.json'))).toBe(false);
    expect(existsSync(join(tgtDir, '.janus', 'janus.db'))).toBe(false);
  });
});

describe('global scope', () => {
  it('workspace-only backup excludes global section', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'scope-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'scope-out-'));
    writeFileSync(join(srcDir, 'janus.json'), '{"llm":{}}');
    mkdirSync(join(srcDir, '.janus'), { recursive: true });
    const db = new Database(join(srcDir, '.janus', 'janus.db'));
    db.close();

    const archive = join(outDir, 'ws.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, scope: 'workspace' });
    expect(manifest.scope).toBe('workspace');
    // No global/ paths in files
    expect(manifest.files.some(f => f.path.startsWith('global/'))).toBe(false);

    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('full backup includes scope: full in manifest', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'scope-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'scope-out-'));
    writeFileSync(join(srcDir, 'janus.json'), '{"llm":{}}');
    mkdirSync(join(srcDir, '.janus'), { recursive: true });
    const db = new Database(join(srcDir, '.janus', 'janus.db'));
    db.close();

    const archive = join(outDir, 'full.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, scope: 'full' });
    expect(manifest.scope).toBe('full');

    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('global-only backup skips workspace validation', async () => {
    // No janus.json — would fail for workspace scope
    const srcDir = mkdtempSync(join(tmpdir(), 'scope-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'scope-out-'));

    const archive = join(outDir, 'global.tar.gz');
    const { manifest } = await createBackupArchive({ workspaceDir: srcDir, outputPath: archive, scope: 'global' });
    expect(manifest.scope).toBe('global');
    // No workspace/ paths in files
    expect(manifest.files.some(f => f.path.startsWith('workspace/'))).toBe(false);

    rmSync(srcDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  it('restore rejects files outside workspace/ and global/ prefixes', async () => {
    const malDir = mkdtempSync(join(tmpdir(), 'mal-'));
    const tgtDir = mkdtempSync(join(tmpdir(), 'mal-tgt-'));
    const root = join(malDir, 'janus-backup-evil');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({
      formatVersion: 1, janusVersion: '0.1.0', createdAt: new Date().toISOString(),
      sourceHostname: 'x', sourcePlatform: 'x', sourceNodeVersion: '24',
      scope: 'full', authMode: 'none', authIncluded: false,
      optionalSections: { sessions: false, chromeProfile: false },
      fileCount: 1, totalBytes: 5,
      files: [{ path: 'other/evil.txt', size: 5, sha256: 'abc' }],
    }));
    const archive = join(malDir, 'evil.tar.gz');
    await tarCreate({ gzip: true, file: archive, cwd: malDir }, ['janus-backup-evil']);
    await expect(restoreFromArchive({ archivePath: archive, workspaceDir: tgtDir })).rejects.toThrow(PathTraversalError);
    rmSync(malDir, { recursive: true, force: true });
    rmSync(tgtDir, { recursive: true, force: true });
  });
});
