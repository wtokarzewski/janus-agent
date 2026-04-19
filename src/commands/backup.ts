/**
 * Backup — staging, manifest, archive creation.
 *
 * Pure `createBackupArchive()` does all the work:
 * staging files, computing checksums, building manifest, creating .tar.gz.
 *
 * `runBackup()` is a thin CLI wrapper around it.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, rmSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, hostname, homedir } from 'node:os';
import { createRequire } from 'node:module';
import { create as tarCreate, extract as tarExtract } from 'tar';
import BetterSqlite3 from 'better-sqlite3';

import { sha256File, collectFiles } from './backup-utils.js';
import { BackupError, AuthDecryptionError } from './backup-errors.js';
import { decryptCredentials, encryptWithPassword, isEncrypted } from '../auth/crypto.js';

const require = createRequire(import.meta.url);
const { version: JANUS_VERSION } = require('../../package.json');

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface BackupManifest {
  formatVersion: 1;
  janusVersion: string;
  createdAt: string;
  sourceHostname: string;
  sourcePlatform: string;
  sourceNodeVersion: string;
  scope: 'full' | 'workspace' | 'global';
  authMode: 'password' | 'plain' | 'none';
  authIncluded: boolean;
  optionalSections: {
    sessions: boolean;
    chromeProfile: boolean;
  };
  fileCount: number;
  totalBytes: number;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
}

export interface BackupOptions {
  workspaceDir: string;
  outputPath: string;
  password?: string;
  includeSessions?: boolean;
  includeChrome?: boolean;
  dryRun?: boolean;
  skipAuth?: boolean;
  scope?: 'full' | 'workspace' | 'global';
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Copy a file, creating parent directories as needed. */
function copyToStaging(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

/* ------------------------------------------------------------------ */
/*  Core                                                               */
/* ------------------------------------------------------------------ */

export async function createBackupArchive(opts: BackupOptions): Promise<{ manifest: BackupManifest; warnings: string[] }> {
  const {
    workspaceDir,
    outputPath,
    password,
    includeSessions = true,
    includeChrome = false,
    dryRun = false,
    skipAuth = false,
    scope = 'full',
  } = opts;

  const warnings: string[] = [];

  // Validate workspace (not needed for global-only backup)
  if (scope !== 'global') {
    const janusJsonPath = join(workspaceDir, 'janus.json');
    if (!existsSync(janusJsonPath)) {
      throw new BackupError(`No janus.json found in ${workspaceDir} — is this a Janus workspace?`);
    }
  }

  // Create staging directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rootDirName = `janus-backup-${timestamp}`;
  const stagingParentDir = mkdtempSync(join(tmpdir(), 'janus-backup-'));
  const stagingRoot = join(stagingParentDir, rootDirName);
  mkdirSync(stagingRoot, { recursive: true });

  try {
    // Workspace backup steps (1-6): skipped for global-only
    let authMode: 'password' | 'plain' | 'none' = 'none';
    let authIncluded = false;
    const sessionsIncluded = scope !== 'global' && includeSessions;

    if (scope !== 'global') {
      const stagingWorkspace = join(stagingRoot, 'workspace');
      mkdirSync(stagingWorkspace, { recursive: true });

      // 1. Copy top-level workspace files
      const janusJsonPath = join(workspaceDir, 'janus.json');
      copyToStaging(janusJsonPath, join(stagingWorkspace, 'janus.json'));

      for (const optFile of ['AGENTS.md', 'HEARTBEAT.md', 'JANUS.md']) {
        const src = join(workspaceDir, optFile);
        if (existsSync(src)) {
          copyToStaging(src, join(stagingWorkspace, optFile));
        }
      }

      // 2. Copy .janus/ directory (excluding db files, chrome-profile, and auth.json which is handled separately)
      const janusDir = join(workspaceDir, '.janus');
      if (existsSync(janusDir)) {
        const dbExcludes = ['janus.db', 'janus.db-wal', 'janus.db-shm', 'chrome-profile', 'auth.json'];
        const { files: janusFiles, warnings: janusWarnings } = collectFiles(janusDir, janusDir, dbExcludes);
        warnings.push(...janusWarnings);

        for (const relPath of janusFiles) {
          copyToStaging(join(janusDir, relPath), join(stagingWorkspace, '.janus', relPath));
        }
      }

      // 3. Auth handling
      const authPath = join(workspaceDir, '.janus', 'auth.json');

      if (existsSync(authPath)) {
        const rawAuth = readFileSync(authPath, 'utf-8');

        if (isEncrypted(rawAuth)) {
          // Machine-bound encryption — need to decrypt first
          try {
            const decrypted = decryptCredentials(rawAuth);

            if (password) {
              const reEncrypted = encryptWithPassword(decrypted, password);
              const destAuth = join(stagingWorkspace, '.janus', 'auth.json');
              mkdirSync(dirname(destAuth), { recursive: true });
              writeFileSync(destAuth, reEncrypted, { mode: 0o600 });
              authMode = 'password';
            } else {
              const destAuth = join(stagingWorkspace, '.janus', 'auth.json');
              mkdirSync(dirname(destAuth), { recursive: true });
              writeFileSync(destAuth, decrypted, { mode: 0o600 });
              authMode = 'plain';
              warnings.push('Credentials stored unencrypted in backup — consider using --password');
            }
            authIncluded = true;
          } catch (err) {
            if (skipAuth) {
              authIncluded = false;
              authMode = 'none';
              warnings.push('Could not decrypt auth.json — skipped (--skip-auth)');
            } else {
              throw new AuthDecryptionError(
                `Cannot decrypt auth.json for backup. Use --password with the machine where it was encrypted, or --skip-auth to exclude credentials. Original error: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } else {
          // Plain text auth
          if (password) {
            const reEncrypted = encryptWithPassword(rawAuth, password);
            const destAuth = join(stagingWorkspace, '.janus', 'auth.json');
            mkdirSync(dirname(destAuth), { recursive: true });
            writeFileSync(destAuth, reEncrypted, { mode: 0o600 });
            authMode = 'password';
          } else {
            const destAuth = join(stagingWorkspace, '.janus', 'auth.json');
            mkdirSync(dirname(destAuth), { recursive: true });
            writeFileSync(destAuth, rawAuth, { mode: 0o600 });
            authMode = 'plain';
            warnings.push('Credentials stored unencrypted in backup — consider using --password');
          }
          authIncluded = true;
        }
      }

      // 4. SQLite backup
      const dbPath = join(workspaceDir, '.janus', 'janus.db');
      if (existsSync(dbPath)) {
        const stagingDbPath = join(stagingWorkspace, '.janus', 'janus.db');
        mkdirSync(dirname(stagingDbPath), { recursive: true });
        const sourceDb = new BetterSqlite3(dbPath, { readonly: true });
        await sourceDb.backup(stagingDbPath);
        sourceDb.close();
      }

      // 5. Copy memory/ directory
      const memoryDir = join(workspaceDir, 'memory');
      if (existsSync(memoryDir)) {
        const { files: memFiles, warnings: memWarnings } = collectFiles(memoryDir, memoryDir);
        warnings.push(...memWarnings);
        for (const relPath of memFiles) {
          copyToStaging(join(memoryDir, relPath), join(stagingWorkspace, 'memory', relPath));
        }
      }

      // 6. Copy sessions/ directory (if included)
      if (sessionsIncluded) {
        const sessionsDir = join(workspaceDir, 'sessions');
        if (existsSync(sessionsDir)) {
          const { files: sessFiles, warnings: sessWarnings } = collectFiles(sessionsDir, sessionsDir);
          warnings.push(...sessWarnings);
          for (const relPath of sessFiles) {
            copyToStaging(join(sessionsDir, relPath), join(stagingWorkspace, 'sessions', relPath));
          }
        }
      }
    }

    // 7. Copy global files (if scope includes global)
    if (scope !== 'workspace') {
      const globalDir = join(homedir(), '.janus');
      if (existsSync(globalDir)) {
        const stagingGlobal = join(stagingRoot, 'global');
        mkdirSync(stagingGlobal, { recursive: true });

        for (const globalFile of ['EGO.md', 'config.json', 'history']) {
          const src = join(globalDir, globalFile);
          if (existsSync(src)) {
            copyToStaging(src, join(stagingGlobal, globalFile));
          }
        }
      }
    }

    // Compute sha256 on all staged files
    const { files: allStagedFiles } = collectFiles(stagingRoot, stagingRoot);
    const manifestFiles: BackupManifest['files'] = [];
    let totalBytes = 0;

    for (const relPath of allStagedFiles) {
      const fullPath = join(stagingRoot, relPath);
      const stat = statSync(fullPath);
      const hash = sha256File(fullPath);
      manifestFiles.push({
        path: relPath,
        size: stat.size,
        sha256: hash,
      });
      totalBytes += stat.size;
    }

    // Build manifest
    const manifest: BackupManifest = {
      formatVersion: 1,
      janusVersion: JANUS_VERSION as string,
      createdAt: new Date().toISOString(),
      sourceHostname: hostname(),
      sourcePlatform: process.platform,
      sourceNodeVersion: process.version,
      scope,
      authMode,
      authIncluded,
      optionalSections: {
        sessions: sessionsIncluded,
        chromeProfile: includeChrome,
      },
      fileCount: manifestFiles.length,
      totalBytes,
      files: manifestFiles,
    };

    // Write manifest.json to staging root (not included in files[])
    writeFileSync(join(stagingRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    // Dry run: return without creating archive
    if (dryRun) {
      return { manifest, warnings };
    }

    // Create archive
    await tarCreate(
      { gzip: true, file: outputPath, cwd: stagingParentDir },
      [rootDirName],
    );

    return { manifest, warnings };
  } finally {
    // Clean up staging dir
    rmSync(stagingParentDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  Verify                                                             */
/* ------------------------------------------------------------------ */

export async function verifyArchive(archivePath: string): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];
  const extractDir = mkdtempSync(join(tmpdir(), 'janus-verify-'));

  try {
    await tarExtract({ file: archivePath, cwd: extractDir });

    // Find root directory
    const entries = readdirSync(extractDir);
    if (entries.length !== 1) {
      errors.push(`Expected single root directory, found ${entries.length} entries`);
      return { valid: false, errors };
    }

    const root = entries[0];
    const manifestPath = join(extractDir, root, 'manifest.json');

    if (!existsSync(manifestPath)) {
      errors.push('manifest.json not found in archive');
      return { valid: false, errors };
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;

    // Verify fileCount matches
    if (manifest.fileCount !== manifest.files.length) {
      errors.push(`fileCount mismatch: manifest says ${manifest.fileCount}, but files[] has ${manifest.files.length} entries`);
    }

    // Verify totalBytes matches
    const expectedTotal = manifest.files.reduce((sum, f) => sum + f.size, 0);
    if (manifest.totalBytes !== expectedTotal) {
      errors.push(`totalBytes mismatch: manifest says ${manifest.totalBytes}, but files[] sum to ${expectedTotal}`);
    }

    for (const file of manifest.files) {
      const filePath = join(extractDir, root, file.path);
      if (!existsSync(filePath)) {
        errors.push(`Missing file: ${file.path}`);
        continue;
      }
      const actualHash = sha256File(filePath);
      if (actualHash !== file.sha256) {
        errors.push(`Checksum mismatch: ${file.path} (expected ${file.sha256}, got ${actualHash})`);
      }
    }

    return { valid: errors.length === 0, errors };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  CLI wrapper                                                        */
/* ------------------------------------------------------------------ */

export async function runBackup(opts: {
  output?: string;
  password?: string;
  passwordFile?: string;
  noSessions?: boolean;
  sessions?: boolean;
  includeChrome?: boolean;
  dryRun?: boolean;
  verify?: boolean;
  skipAuth?: boolean;
  onlyGlobal?: boolean;
  onlyWorkspace?: boolean;
}): Promise<void> {
  const workspaceDir = process.cwd();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = opts.output ?? `janus-backup-${timestamp}.tar.gz`;

  // Resolve password
  let password = opts.password;
  if (!password && opts.passwordFile) {
    password = readFileSync(opts.passwordFile, 'utf-8').trim();
  }

  // Commander --no-sessions sets opts.sessions = false
  const includeSessions = opts.sessions !== false && opts.noSessions !== true;

  // Determine scope
  let scope: 'full' | 'workspace' | 'global' = 'full';
  if (opts.onlyGlobal) scope = 'global';
  else if (opts.onlyWorkspace) scope = 'workspace';

  const { manifest, warnings } = await createBackupArchive({
    workspaceDir,
    outputPath,
    password,
    includeSessions,
    includeChrome: opts.includeChrome,
    dryRun: opts.dryRun,
    skipAuth: opts.skipAuth,
    scope,
  });

  for (const w of warnings) {
    console.error(`\u26A0 ${w}`);
  }

  if (opts.dryRun) {
    console.log(`\nDry run \u2014 ${manifest.fileCount} files, ${manifest.totalBytes} bytes would be backed up`);
  } else {
    console.log(`\nBackup created: ${outputPath}`);
    console.log(`  Files: ${manifest.fileCount}`);
    console.log(`  Auth: ${manifest.authMode}`);

    if (opts.verify) {
      const result = await verifyArchive(outputPath);
      if (result.valid) {
        console.log('  Verified: \u2713');
      } else {
        console.error('  Verification failed:');
        for (const e of result.errors) console.error(`    - ${e}`);
        process.exit(1);
      }
    }
  }
}
