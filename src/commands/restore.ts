/**
 * Restore — extract backup archive, verify integrity, restore files.
 *
 * Pure `restoreFromArchive()` does all the work:
 * extracting archive, validating manifest, verifying checksums, restoring files.
 *
 * `readManifest()` reads just the manifest from an archive.
 * `runRestore()` is a thin CLI wrapper around them.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, mkdtempSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { extract as tarExtract, list as tarList } from 'tar';
import type { BackupManifest } from './backup.js';
import { assertPathSafe, sha256File, collectFiles } from './backup-utils.js';
import {
  ManifestValidationError,
  UnsupportedFormatVersionError,
  PathTraversalError,
  ChecksumMismatchError,
} from './backup-errors.js';
import { encryptCredentials, decryptWithPassword, isBackupEncrypted } from '../auth/crypto.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface RestoreOptions {
  archivePath: string;
  workspaceDir: string;
  password?: string;
  dryRun?: boolean;
  noGlobal?: boolean;
  noWorkspace?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Find the single root directory inside an extraction dir. */
function findRootDir(extractDir: string): string {
  const entries = readdirSync(extractDir);
  if (entries.length !== 1) {
    throw new ManifestValidationError(`Expected single root directory in archive, found ${entries.length} entries`);
  }
  return entries[0];
}

/** Read and parse manifest.json from the root of an extracted archive. */
function parseManifest(extractDir: string, rootDir: string): BackupManifest {
  const manifestPath = join(extractDir, rootDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new ManifestValidationError('manifest.json not found in archive');
  }

  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as BackupManifest;
  } catch (err) {
    if (err instanceof ManifestValidationError) throw err;
    throw new ManifestValidationError(`Invalid manifest.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Walk a directory tree and check for symlinks — throws PathTraversalError if any found. */
function assertNoSymlinks(dir: string): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const stat = lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      throw new PathTraversalError(`Symlink found in archive: ${relative(dir, fullPath)}`);
    }

    if (stat.isDirectory()) {
      assertNoSymlinks(fullPath);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  readManifest                                                       */
/* ------------------------------------------------------------------ */

/**
 * Read the manifest from a backup archive without performing a full restore.
 * Extracts to a temp dir, reads manifest.json, cleans up.
 */
export async function readManifest(archivePath: string): Promise<BackupManifest> {
  // 1. Scan archive headers to find root dir name
  let rootDir = '';
  await tarList({
    file: archivePath,
    onReadEntry: (entry) => {
      // First entry's path gives us the root dir name
      if (!rootDir) {
        const firstSlash = entry.path.indexOf('/');
        rootDir = firstSlash > 0 ? entry.path.slice(0, firstSlash) : entry.path;
      }
    },
  });

  if (!rootDir) {
    throw new ManifestValidationError('Archive is empty');
  }

  // 2. Selectively extract only manifest.json
  const extractDir = mkdtempSync(join(tmpdir(), 'janus-manifest-'));
  const manifestEntry = `${rootDir}/manifest.json`;

  try {
    await tarExtract({
      file: archivePath,
      cwd: extractDir,
      filter: (path) => path === manifestEntry,
    });

    return parseManifest(extractDir, rootDir);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  restoreFromArchive                                                 */
/* ------------------------------------------------------------------ */

export async function restoreFromArchive(opts: RestoreOptions): Promise<{ warnings: string[] }> {
  const { archivePath, workspaceDir, password, dryRun = false, noGlobal = false, noWorkspace = false } = opts;
  const warnings: string[] = [];
  const extractDir = mkdtempSync(join(tmpdir(), 'janus-restore-'));

  try {
    // 1. Extract full archive to temp dir
    await tarExtract({ file: archivePath, cwd: extractDir });

    // 2. Find root directory
    const rootDir = findRootDir(extractDir);
    const rootPath = join(extractDir, rootDir);

    // 3. Read and parse manifest
    const manifest = parseManifest(extractDir, rootDir);

    // 4. Check format version
    if (manifest.formatVersion > 1) {
      throw new UnsupportedFormatVersionError(manifest.formatVersion);
    }

    // 5. Security: Path traversal check on all manifest files
    for (const file of manifest.files) {
      const isWorkspace = file.path.startsWith('workspace/') || file.path.startsWith('workspace\\');
      const isGlobal = file.path.startsWith('global/') || file.path.startsWith('global\\');
      if (!isWorkspace && !isGlobal) {
        throw new PathTraversalError(`File "${file.path}" is not under workspace/ or global/`);
      }
      if (isWorkspace) assertPathSafe(file.path, 'workspace');
      if (isGlobal) assertPathSafe(file.path, 'global');
    }

    // 6. Security: Symlink check on extracted files
    assertNoSymlinks(rootPath);

    // 7. Checksum verification
    for (const file of manifest.files) {
      const filePath = join(rootPath, file.path);
      if (!existsSync(filePath)) {
        warnings.push(`Missing file in archive: ${file.path}`);
        continue;
      }
      const actualHash = sha256File(filePath);
      if (actualHash !== file.sha256) {
        throw new ChecksumMismatchError(
          `Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${actualHash}`,
        );
      }
    }

    if (dryRun) {
      return { warnings };
    }

    const workspaceSubdir = join(rootPath, 'workspace');
    const globalSubdir = join(rootPath, 'global');
    const extractedAuthPath = join(workspaceSubdir, '.janus', 'auth.json');
    const globalDestDir = join(homedir(), '.janus');

    // Create rollback snapshot of files that will be overwritten
    const rollbackDir = mkdtempSync(join(tmpdir(), 'janus-rollback-'));
    const rollbackFiles: Array<{ relPath: string; destBase: string }> = [];

    try {
      // Snapshot workspace files that will be overwritten
      if (!noWorkspace && existsSync(workspaceSubdir)) {
        const { files: allFiles } = collectFiles(workspaceSubdir, workspaceSubdir);
        for (const relPath of allFiles) {
          // Auth is handled separately — skip here
          if (relPath === join('.janus', 'auth.json')) continue;
          const destFile = join(workspaceDir, relPath);
          if (existsSync(destFile)) {
            const rollbackPath = join(rollbackDir, 'workspace', relPath);
            mkdirSync(dirname(rollbackPath), { recursive: true });
            copyFileSync(destFile, rollbackPath);
            rollbackFiles.push({ relPath: join('workspace', relPath), destBase: workspaceDir });
          }
        }
      }

      // Snapshot auth.json if it will be overwritten
      if (!noWorkspace && manifest.authIncluded && existsSync(extractedAuthPath)) {
        const existingAuth = join(workspaceDir, '.janus', 'auth.json');
        if (existsSync(existingAuth)) {
          const rollbackPath = join(rollbackDir, 'workspace', '.janus', 'auth.json');
          mkdirSync(dirname(rollbackPath), { recursive: true });
          copyFileSync(existingAuth, rollbackPath);
          rollbackFiles.push({ relPath: join('workspace', '.janus', 'auth.json'), destBase: workspaceDir });
        }
      }

      // Snapshot global files that will be overwritten
      if (!noGlobal && existsSync(globalSubdir)) {
        const { files: globalFiles } = collectFiles(globalSubdir, globalSubdir);
        for (const relPath of globalFiles) {
          const destFile = join(globalDestDir, relPath);
          if (existsSync(destFile)) {
            const rollbackPath = join(rollbackDir, 'global', relPath);
            mkdirSync(dirname(rollbackPath), { recursive: true });
            copyFileSync(destFile, rollbackPath);
            rollbackFiles.push({ relPath: join('global', relPath), destBase: globalDestDir });
          }
        }
      }

      // 8. Copy workspace files (except auth.json)
      if (!noWorkspace && existsSync(workspaceSubdir)) {
        const { files: allFiles } = collectFiles(workspaceSubdir, workspaceSubdir);

        for (const relPath of allFiles) {
          if (relPath === join('.janus', 'auth.json')) continue;

          const srcFile = join(workspaceSubdir, relPath);
          const destFile = join(workspaceDir, relPath);
          mkdirSync(dirname(destFile), { recursive: true });
          copyFileSync(srcFile, destFile);
        }
      }

      // 9. Auth handling (after file copy so rollback covers both)
      if (!noWorkspace && manifest.authIncluded && existsSync(extractedAuthPath)) {
        const rawAuth = readFileSync(extractedAuthPath, 'utf-8');
        let plainAuth: string;

        if (isBackupEncrypted(rawAuth)) {
          if (!password) {
            throw new ManifestValidationError('Backup contains password-encrypted credentials but no password was provided');
          }
          plainAuth = decryptWithPassword(rawAuth, password);
        } else {
          plainAuth = rawAuth;
        }

        const reEncrypted = encryptCredentials(plainAuth);
        const destAuth = join(workspaceDir, '.janus', 'auth.json');
        mkdirSync(dirname(destAuth), { recursive: true });
        writeFileSync(destAuth, reEncrypted, { mode: 0o600 });
      }

      // 10. Copy global files to ~/.janus/
      if (!noGlobal && existsSync(globalSubdir)) {
        const { files: globalFiles } = collectFiles(globalSubdir, globalSubdir);
        for (const relPath of globalFiles) {
          const srcFile = join(globalSubdir, relPath);
          const destFile = join(globalDestDir, relPath);
          mkdirSync(dirname(destFile), { recursive: true });
          copyFileSync(srcFile, destFile);
        }
      }
    } catch (restoreErr) {
      // Restore overwritten files from rollback snapshot
      for (const { relPath, destBase } of rollbackFiles) {
        const rollbackPath = join(rollbackDir, relPath);
        // relPath is "workspace/..." or "global/..." — strip the prefix
        const section = relPath.startsWith('workspace') ? 'workspace' : 'global';
        const innerPath = relPath.slice(section.length + 1);
        const destFile = join(destBase, innerPath);
        try {
          mkdirSync(dirname(destFile), { recursive: true });
          copyFileSync(rollbackPath, destFile);
        } catch {
          // Best-effort rollback — log but don't mask original error
          warnings.push(`Rollback failed for: ${relPath}`);
        }
      }
      throw restoreErr;
    } finally {
      rmSync(rollbackDir, { recursive: true, force: true });
    }

    return { warnings };
  } finally {
    // Clean up temp dir
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/*  CLI wrapper                                                        */
/* ------------------------------------------------------------------ */

export async function runRestore(archive: string, opts: {
  password?: string;
  passwordFile?: string;
  dryRun?: boolean;
  noGlobal?: boolean;
  noWorkspace?: boolean;
  global?: boolean;
  workspace?: boolean;
}): Promise<void> {
  const workspaceDir = process.cwd();

  let password = opts.password;
  if (!password && opts.passwordFile) {
    password = readFileSync(opts.passwordFile, 'utf-8').trim();
  }

  // Commander --no-X sets opts.X = false (not opts.noX = true)
  const noGlobal = opts.global === false || opts.noGlobal === true;
  const noWorkspace = opts.workspace === false || opts.noWorkspace === true;

  const manifest = await readManifest(archive);
  console.log(`\nBackup info:`);
  console.log(`  Version: ${manifest.janusVersion}`);
  console.log(`  Created: ${manifest.createdAt}`);
  console.log(`  Files: ${manifest.fileCount}`);
  console.log(`  Auth: ${manifest.authMode}`);

  const { warnings } = await restoreFromArchive({ archivePath: archive, workspaceDir, password, dryRun: opts.dryRun, noGlobal, noWorkspace });

  for (const w of warnings) {
    console.error(`\u26A0 ${w}`);
  }

  console.log('\nRestore complete. Run `janus doctor` to verify.');
}
