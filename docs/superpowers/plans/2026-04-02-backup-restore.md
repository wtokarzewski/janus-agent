# Backup & Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `backup`, `restore`, and `doctor` commands to Janus for full data portability between servers.

**Architecture:** Three new commander subcommands with thin CLI wrappers over pure testable functions. Backup stages files to temp dir, creates SQLite snapshot via `db.backup()`, computes sha256 checksums on staged content, writes self-describing manifest, packs into tar.gz. Auth credentials decrypted from machine-bound encryption and optionally re-encrypted with user password (PBKDF2/sha512). Restore validates checksums, path safety and symlinks, creates rollback snapshot, atomically places files. Doctor verifies workspace integrity with core checks (pass/fail) and diagnostics (info only).

**Tech Stack:** TypeScript (ESM), `tar` npm package, `node:crypto` (sha256 + AES-256-GCM + PBKDF2/sha512), better-sqlite3 `backup()`, commander CLI.

**Spec:** `docs/superpowers/specs/2026-04-02-backup-restore-design.md` (v4 final)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/commands/backup-errors.ts` | Domain error classes: BackupError, RestoreError, ManifestValidationError, ChecksumMismatchError, PathTraversalError, AuthDecryptionError, UnsupportedFormatVersionError |
| `src/commands/backup-utils.ts` | Pure utilities: sha256File, assertPathSafe, collectFiles, formatBytes. Shared by backup + restore. |
| `src/auth/crypto.ts` | Add encryptWithPassword, decryptWithPassword, isBackupEncrypted (PBKDF2/sha512, self-describing payload) |
| `src/commands/doctor.ts` | runDoctorChecks() pure function (returns DoctorResult[]) + runDoctor() CLI wrapper |
| `src/commands/backup.ts` | createBackupArchive() pure function (returns BackupManifest + warnings) + verifyArchive() + runBackup() CLI wrapper |
| `src/commands/restore.ts` | restoreFromArchive() pure function + readManifest() (selective) + runRestore() CLI wrapper |
| `src/index.ts` | Register backup, restore, doctor commands with all flags |
| `tests/unit/auth-backup-crypto.test.ts` | Password encryption tests |
| `tests/unit/doctor.test.ts` | Doctor check tests |
| `tests/unit/backup-restore.test.ts` | Backup + restore + verify integration tests |

---

### Task 1: Domain error classes

**Files:**
- Create: `src/commands/backup-errors.ts`

- [ ] **Step 1: Create backup-errors.ts**

```typescript
/**
 * Domain error classes for backup/restore operations.
 * Used for consistent error handling, CLI mapping, and test assertions.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

export class ChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChecksumMismatchError';
  }
}

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

export class AuthDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthDecryptionError';
  }
}

export class UnsupportedFormatVersionError extends Error {
  constructor(version: number) {
    super(`Unsupported backup format version: ${version}. This Janus version only supports format version 1.`);
    this.name = 'UnsupportedFormatVersionError';
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`

---

### Task 2: Shared utilities

**Files:**
- Create: `src/commands/backup-utils.ts`
- Create: `tests/unit/backup-restore.test.ts` (initial, just utils tests)

- [ ] **Step 1: Create backup-utils.ts**

```typescript
/**
 * Shared utilities for backup/restore — checksums, path validation, file collection.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
import { PathTraversalError } from './backup-errors.js';

/** Compute sha256 hex digest of a file. */
export function sha256File(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Validate that a resolved path stays within the allowed base directory.
 * Uses canonical resolve — does not rely on string includes.
 * Throws PathTraversalError if path escapes.
 */
export function assertPathSafe(filePath: string, baseDir: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(baseDir, filePath);
  if (resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + sep)) {
    throw new PathTraversalError(`Path "${filePath}" escapes base directory "${baseDir}"`);
  }
}

/**
 * Recursively collect all regular files under a directory.
 * Returns paths relative to baseDir.
 * Skips symlinks, sockets, device files, FIFOs — returns them in warnings.
 */
export function collectFiles(
  baseDir: string,
  dir: string,
  exclude?: string[],
): { files: string[]; warnings: string[] } {
  const files: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(dir)) return { files, warnings };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (exclude?.some(e => relPath.startsWith(e) || entry.name === e)) continue;

    const stat = lstatSync(fullPath);

    if (stat.isSymbolicLink()) {
      warnings.push(`Skipped symlink: ${relPath}`);
      continue;
    }
    if (stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) {
      warnings.push(`Skipped special file: ${relPath}`);
      continue;
    }

    if (stat.isDirectory()) {
      const sub = collectFiles(baseDir, fullPath, exclude);
      files.push(...sub.files);
      warnings.push(...sub.warnings);
    } else if (stat.isFile()) {
      files.push(relPath);
    }
  }

  return { files, warnings };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Write tests**

Create `tests/unit/backup-restore.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256File, assertPathSafe, collectFiles } from '../../src/commands/backup-utils.js';
import { PathTraversalError } from '../../src/commands/backup-errors.js';

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
```

- [ ] **Step 3: Run tests**

Run: `npm test -- --reporter=verbose tests/unit/backup-restore.test.ts`
Expected: All PASS.

- [ ] **Step 4: Run typecheck + full suite**

Run: `npx tsc --noEmit && npm test`

---

### Task 3: Password-based auth encryption

**Files:**
- Modify: `src/auth/crypto.ts`
- Create: `tests/unit/auth-backup-crypto.test.ts`

- [ ] **Step 1: Write tests**

Create `tests/unit/auth-backup-crypto.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  encryptWithPassword,
  decryptWithPassword,
  isBackupEncrypted,
} from '../../src/auth/crypto.js';

describe('password-based backup encryption', () => {
  const plain = '{"anthropic": {"type": "api_key", "key": "sk-test-123"}}';

  it('round-trips encrypt → decrypt', () => {
    const encrypted = encryptWithPassword(plain, 'mypassword');
    const decrypted = decryptWithPassword(encrypted, 'mypassword');
    expect(decrypted).toBe(plain);
  });

  it('fails with wrong password', () => {
    const encrypted = encryptWithPassword(plain, 'correct');
    expect(() => decryptWithPassword(encrypted, 'wrong')).toThrow();
  });

  it('payload is self-describing with KDF params', () => {
    const encrypted = encryptWithPassword(plain, 'pass');
    const parsed = JSON.parse(encrypted);
    expect(parsed._backup_encrypted).toBe(true);
    expect(parsed.kdf).toBe('pbkdf2');
    expect(parsed.digest).toBe('sha512');
    expect(parsed.iterations).toBe(100000);
    expect(parsed.salt).toBeTruthy();
    expect(parsed.iv).toBeTruthy();
    expect(parsed.tag).toBeTruthy();
    expect(parsed.data).toBeTruthy();
  });

  it('isBackupEncrypted detects backup payloads', () => {
    const encrypted = encryptWithPassword(plain, 'pass');
    expect(isBackupEncrypted(encrypted)).toBe(true);
  });

  it('isBackupEncrypted returns false for non-backup data', () => {
    expect(isBackupEncrypted(plain)).toBe(false);
    expect(isBackupEncrypted('{"_encrypted": true}')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose tests/unit/auth-backup-crypto.test.ts`

- [ ] **Step 3: Implement**

In `src/auth/crypto.ts`, add after the existing `isEncrypted()` function. Key points:
- `digest: 'sha512'` (not sha256) for PBKDF2
- Self-describing payload with `_backup_encrypted`, `kdf`, `digest`, `iterations`
- `deriveKeyFromPassword(password, salt, digest, iterations)` reads params from payload on decrypt
- Use existing constants: `ALGORITHM`, `KEY_LENGTH`, `IV_LENGTH`, `TAG_LENGTH`
- Use existing imports: `createCipheriv`, `createDecipheriv`, `randomBytes`, `pbkdf2Sync`

See spec section "Password encryption payload format" for exact payload shape.

- [ ] **Step 4: Run tests**

Run: `npm test -- --reporter=verbose tests/unit/auth-backup-crypto.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Run full suite**

Run: `npx tsc --noEmit && npm test`

---

### Task 4: Doctor command

**Files:**
- Create: `src/commands/doctor.ts`
- Create: `tests/unit/doctor.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write tests**

Create `tests/unit/doctor.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose tests/unit/doctor.test.ts`

- [ ] **Step 3: Implement doctor.ts**

Create `src/commands/doctor.ts`. Key design:
- `runDoctorChecks(workspaceDir: string): DoctorResult[]` — pure, no console output
- `DoctorResult: { name, category: 'core'|'diagnostic', status: 'pass'|'fail'|'warn'|'fixed'|'info', message }`
- Core checks: config (exists + JSON parse), .janus dir, database (exists + integrity_check), DB version (> migrations = fail, < = warn), auth (missing = warn, undecryptable existing = fail), required dirs (auto-create if missing), permissions (POSIX only, skip on Windows)
- Diagnostics: GWS, pending migrations, optional dirs
- Use top-level ESM imports, no require()
- `runDoctor()`: CLI wrapper, prints colored output with icons

- [ ] **Step 4: Register in index.ts**

Add after the `update` command:
```typescript
program
  .command('doctor')
  .description('Verify Janus installation and data integrity')
  .action(async () => {
    const { runDoctor } = await import('./commands/doctor.js');
    await runDoctor();
  });
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --reporter=verbose tests/unit/doctor.test.ts`

- [ ] **Step 6: Run typecheck + full suite**

Run: `npx tsc --noEmit && npm test`

---

### Task 5: Backup — staging, manifest, archive

**Files:**
- Create: `src/commands/backup.ts`
- Modify: `src/index.ts`
- Add tests to `tests/unit/backup-restore.test.ts`

**Dependency:** Requires `tar` npm package. Run `npm install tar` first. Check if types are bundled; if not, `npm install -D @types/tar`.

- [ ] **Step 1: Install tar**

Run: `npm install tar`

- [ ] **Step 2: Write tests**

Add to `tests/unit/backup-restore.test.ts`:

```typescript
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import tar from 'tar';
import { Database } from '../../src/db/database.js';
import { createBackupArchive, type BackupManifest } from '../../src/commands/backup.js';
import { AuthDecryptionError } from '../../src/commands/backup-errors.js';

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
    await tar.x({ file: archive, cwd: extractDir });
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
    await tar.x({ file: archive, cwd: extractDir });
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose tests/unit/backup-restore.test.ts`

- [ ] **Step 4: Implement backup.ts**

Create `src/commands/backup.ts`. Key design per spec:

**`createBackupArchive(opts) → { manifest, warnings }`** (pure function):
1. Create staging dir with timestamped root name
2. Collect workspace files (janus.json, AGENTS.md, HEARTBEAT.md, JANUS.md) via copy
3. Collect .janus/ files via collectFiles (skip WAL/SHM, handled separately)
4. Auth.json: try decryptCredentials → if fails and no skipAuth → throw AuthDecryptionError. If succeeds: password → encryptWithPassword, no password → store plain + add warning
5. SQLite: `new BetterSqlite3(dbPath, { readonly: true })` → `db.backup(stagingDbPath)` → close
6. memory/, sessions/ (if included) via collectFiles
7. Global files (if scope includes global): EGO.md, config.json, history
8. Chrome profile (if includeChrome): collectFiles with exclusion list
9. Compute sha256 on ALL staged files (not source files)
10. Build manifest: formatVersion=1, scope, authMode, authIncluded, optionalSections, files with sha256
11. Write manifest.json to staging (not in files[])
12. If dryRun: return manifest + warnings, clean up staging, no tar
13. `tar.c({ gzip: true, file: outputPath, cwd: stageParentDir }, [rootDirName])`
14. Clean up staging

**`runBackup(opts)`** (thin CLI wrapper):
- Resolve password: `--password` > `--password-file` (read utf-8, trim newline) > interactive prompt (only if auth exists and would be included)
- Call createBackupArchive
- Print warnings to stderr
- If `--verify`: call verifyArchive
- Print summary

- [ ] **Step 5: Register in index.ts**

```typescript
program
  .command('backup')
  .description('Create a full backup of Janus data')
  .option('--output <path>', 'Output file path')
  .option('--password <password>', 'Encrypt credentials with password')
  .option('--password-file <path>', 'Read password from file')
  .option('--only-global', 'Only backup ~/.janus/')
  .option('--only-workspace', 'Only backup workspace data')
  .option('--no-sessions', 'Exclude session history')
  .option('--include-chrome', 'Include Chrome profile')
  .option('--dry-run', 'Show what would be backed up')
  .option('--verify', 'Verify archive checksums after creation')
  .option('--skip-auth', 'Skip auth.json if undecryptable')
  .action(async (opts) => {
    const { runBackup } = await import('./commands/backup.js');
    await runBackup(opts);
  });
```

- [ ] **Step 6: Run tests**

Run: `npm test -- --reporter=verbose tests/unit/backup-restore.test.ts`

- [ ] **Step 7: Run typecheck + full suite**

Run: `npx tsc --noEmit && npm test`

---

### Task 6: Verify archive

**Files:**
- Modify: `src/commands/backup.ts` (add verifyArchive)
- Add tests to `tests/unit/backup-restore.test.ts`

- [ ] **Step 1: Write tests**

Add to `tests/unit/backup-restore.test.ts`:

```typescript
import { verifyArchive } from '../../src/commands/backup.js';

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
    await tar.c({ gzip: true, file: archive, cwd: badDir }, ['janus-backup-bad']);
    const result = await verifyArchive(archive);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('manifest'))).toBe(true);
    rmSync(badDir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Implement verifyArchive**

Add to `src/commands/backup.ts`:

**`verifyArchive(archivePath) → { valid, errors }`**:
1. Extract to temp dir
2. Find root dir (exactly one required)
3. Read manifest.json (ManifestValidationError if missing/malformed)
4. For each file in manifest.files: check exists, compute sha256, compare
5. Verify fileCount matches files[].length
6. Verify totalBytes matches sum of sizes
7. Return `{ valid: errors.length === 0, errors }`

- [ ] **Step 3: Run tests**

Run: `npm test -- --reporter=verbose tests/unit/backup-restore.test.ts`

- [ ] **Step 4: Run typecheck + full suite**

Run: `npx tsc --noEmit && npm test`

---

### Task 7: Restore + rollback

**Files:**
- Create: `src/commands/restore.ts`
- Modify: `src/index.ts`
- Add tests to `tests/unit/backup-restore.test.ts`

- [ ] **Step 1: Write tests**

Add to `tests/unit/backup-restore.test.ts`:

```typescript
import { restoreFromArchive, readManifest } from '../../src/commands/restore.js';
import { ManifestValidationError, UnsupportedFormatVersionError, PathTraversalError, ChecksumMismatchError } from '../../src/commands/backup-errors.js';

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
    await tar.c({ gzip: true, file: archive, cwd: malDir }, ['janus-backup-evil']);
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
    await tar.c({ gzip: true, file: archive, cwd: badDir }, ['janus-backup-bad']);
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --reporter=verbose tests/unit/backup-restore.test.ts`

- [ ] **Step 3: Implement restore.ts**

Create `src/commands/restore.ts`. Key design per spec:

**`readManifest(archivePath) → BackupManifest`** (selective):
- Use `tar.t()` to list entries, find root dir and `{root}/manifest.json`
- Extract only manifest.json to temp (use `tar.x` with filter)
- Validate: exactly one root, manifest at expected path, JSON parseable
- Throw ManifestValidationError for any issue

**`restoreFromArchive(opts) → { warnings }`** (pure function):
1. Extract full archive to temp dir
2. Validate formatVersion (UnsupportedFormatVersionError if > 1)
3. assertPathSafe on every file in manifest against target dir (both extract and target paths)
4. Check for symlink entries in extracted files → PathTraversalError
5. Verify sha256 checksums → ChecksumMismatchError
6. Determine empty vs existing target
7. If existing: create rollback of managed paths that will be overwritten
8. Auth: if authIncluded → read from extract → decrypt if password → encryptCredentials → write with 0o600
9. Copy all other files (skip auth.json, already handled)
10. On failure after rollback: restore rollback, clean up
11. On success: clean up

**`runRestore(archive, opts)`** (thin CLI wrapper):
- Read manifest (selective)
- Show summary
- Resolve password: flag > file > prompt
- Confirm
- Call restoreFromArchive
- Print warnings
- Suggest `janus doctor`

- [ ] **Step 4: Register in index.ts**

```typescript
program
  .command('restore <archive>')
  .description('Restore Janus data from a backup archive')
  .option('--password <password>', 'Password for encrypted backup')
  .option('--password-file <path>', 'Read password from file')
  .option('--no-global', 'Skip restoring ~/.janus/')
  .option('--no-workspace', 'Skip restoring workspace data')
  .option('--dry-run', 'Show what would be restored')
  .action(async (archive: string, opts) => {
    const { runRestore } = await import('./commands/restore.js');
    await runRestore(archive, opts);
  });
```

- [ ] **Step 5: Run tests**

Run: `npm test -- --reporter=verbose tests/unit/backup-restore.test.ts`

- [ ] **Step 6: Run typecheck + full suite**

Run: `npx tsc --noEmit && npm test`

---

### Task 8: CLI wiring + smoke tests

- [ ] **Step 1: Verify all commands registered**

Run: `npx tsx src/index.ts --help`
Expected: `doctor`, `backup`, `restore` in command list.

- [ ] **Step 2: Smoke test doctor**

Run: `npx tsx src/index.ts doctor`

- [ ] **Step 3: Smoke test backup dry-run**

Run: `npx tsx src/index.ts backup --dry-run`

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Run full test suite**

Run: `npm test`
