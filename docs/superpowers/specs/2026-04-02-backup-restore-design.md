# Backup & Restore — Design Spec

**Date:** 2026-04-02
**Status:** Final (v4)
**Phase:** 1 of 4 (Backup/Restore → Releases/Versioning → Install Script/Update → Coding Standards)

## Problem Statement

No way to migrate a Janus instance between servers. User data (config, credentials, database, memory, sessions) is scattered across workspace and global directories with no export/import mechanism. Credentials are encrypted with machine-bound keys (machine-id + username), making manual file copy insufficient.

## Goals

- Full 1:1 backup of all Janus data into a single portable archive
- Restore on a new machine after fresh Janus install
- Optional password protection for credentials in the archive
- Checksum-verified integrity (sha256 per file, computed on staged content)
- Atomic restore with rollback on failure
- Post-restore verification via `janus doctor`

## Non-Goals (Phase 1 scope)

- Scheduled/automatic backups (can be added later via cron)
- Incremental backups (full snapshot only)
- Deduplication
- Cross-version migration transforms (restore expects same logical data model)
- Separating data from code directory (future phase — install script)
- npm publish or install script (phase 3)
- `doctor --archive` (archive verification lives in `verifyArchive` / `readManifest`, not in doctor)

---

## Data Inventory

### Workspace data (relative to cwd)

| Path | Contents | Notes |
|------|----------|-------|
| `janus.json` | Workspace config | LLM providers, agents, users, bindings |
| `AGENTS.md` | Agent behavior rules | |
| `HEARTBEAT.md` | Autonomous scheduled tasks | |
| `JANUS.md` | Project-specific instructions | |
| `.janus/auth.json` | Credentials (encrypted AES-256-GCM) | Machine-bound encryption — must re-encrypt for portability. **Belongs to workspace scope.** |
| `.janus/janus.db` | SQLite database (WAL mode) | Must use `db.backup()` API for consistent snapshot |
| `.janus/users/` | Per-user data | PROFILE.md, AGENTS.md, HEARTBEAT.md, EGO.md, memory/, files/ |
| `.janus/agents/` | Per-agent data | EGO.md, AGENTS.md, HEARTBEAT.md, memory/ |
| `.janus/chats/` | Per-chat file sandboxes | files/ per chatId |
| `memory/` | Global workspace memory | MEMORY.md, HISTORY.md, daily notes, learner.jsonl |
| `sessions/` | Conversation history (JSONL) | Can be large (100s of MB), optional |

### Global data (`~/.janus/`)

| Path | Contents | Notes |
|------|----------|-------|
| `EGO.md` | Agent character (global) | |
| `config.json` | User-level config overrides | Optional |
| `history` | CLI command history | Max 500 entries, regular file only |
| `chrome-profile/` | Browser Operator Chrome profile | Large (500MB+), opt-in only (`--include-chrome`) |

### External (NOT included in backup)

| Path | Contents | Restore action |
|------|----------|---------------|
| `~/.config/gcloud/` | Google Workspace credentials | Run `npx gws auth setup` after restore |
| Node.js, npm | Runtime | Pre-requisite on new machine |
| Git repo / code | Janus source code | `git clone` or install script on new machine |

---

## Design

### Archive format

Standard `.tar.gz` with a manifest file at root.

**Filename:** `janus-backup-YYYY-MM-DD-HHMMSS.tar.gz`
**Root dir inside archive:** `janus-backup-YYYY-MM-DD-HHMMSS/` (same stem as filename)

**Archive structure rules:**
- Archive must contain exactly one root directory
- All entries must live under that root
- `manifest.json` must be at `{root}/manifest.json`

**Structure:**
```
janus-backup-2026-04-02-120000/
├── manifest.json
├── workspace/
│   ├── janus.json
│   ├── AGENTS.md
│   ├── HEARTBEAT.md
│   ├── JANUS.md
│   ├── .janus/
│   │   ├── auth.json          ← re-encrypted with password or plain
│   │   ├── janus.db           ← created via db.backup(), not file copy
│   │   ├── users/
│   │   ├── agents/
│   │   └── chats/
│   ├── memory/
│   └── sessions/              ← omitted if --no-sessions
└── global/
    ├── EGO.md
    ├── config.json
    ├── history
    └── chrome-profile/        ← only if --include-chrome
```

### Manifest (`manifest.json`)

```json
{
  "formatVersion": 1,
  "janusVersion": "0.1.0",
  "createdAt": "2026-04-02T12:00:00Z",
  "sourceHostname": "home-server",
  "sourcePlatform": "linux",
  "sourceNodeVersion": "24.0.0",
  "scope": "full",
  "authMode": "password",
  "authIncluded": true,
  "optionalSections": {
    "sessions": true,
    "chromeProfile": false
  },
  "fileCount": 42,
  "totalBytes": 5242880,
  "files": [
    { "path": "workspace/janus.json", "size": 2048, "sha256": "a1b2c3..." },
    { "path": "workspace/.janus/janus.db", "size": 524288, "sha256": "d4e5f6..." }
  ]
}
```

**Field definitions:**

- `formatVersion`: integer. Only `1` supported in phase 1. Restore rejects unknown versions with `UnsupportedFormatVersionError`.
- `scope`: `"full"` | `"workspace-only"` | `"global-only"`.
- `authMode`: `"password"` | `"plain"`. Only meaningful when `authIncluded: true`.
- `authIncluded`: boolean. `false` when `--skip-auth` was used or auth.json didn't exist. When `false`, `authMode` is ignored.
- `optionalSections.sessions`: may only be `true` when scope includes workspace.
- `optionalSections.chromeProfile`: may only be `true` when scope includes global.
- `fileCount`: number of entries in `files[]`. Directories are not counted.
- `totalBytes`: sum of `size` values from `files[]` (staged payload size, not tar.gz size).
- `sha256`: hex checksum per file, **computed on the staged/final content** (not the source file).
- `manifest.json` itself is **not** in `files[]`. Verify treats manifest as the source of truth, not as a checksummed entry.

### File type handling policy

| Type | Backup behavior | Restore behavior |
|------|----------------|-----------------|
| Regular file | Include | Place in target |
| Directory | Recurse into | Create in target |
| Symlink | **Skip with warning** | **Hard fail** (`PathTraversalError`) |
| Socket | Skip with warning | N/A |
| Device file | Skip with warning | N/A |
| FIFO | Skip with warning | N/A |

Backup logs a warning for each skipped non-regular entry. Restore aborts if any symlink entry appears in the archive — this prevents traversal attacks via symbolic links. Symlink entries are treated as `PathTraversalError` for simplicity of error handling in phase 1.

**Warning surface:** Core functions return a structured `warnings: string[]` array alongside their main result. CLI wrappers print warnings to stderr. Tests assert on the warnings array, not console output.

### Chrome profile filter

When `--include-chrome` is used, the following are **excluded** from `chrome-profile/`:

```
SingletonLock
SingletonSocket
SingletonCookie
Cache/
Code Cache/
GPUCache/
Crashpad/
GrShaderCache/
DawnCache/
Temp/
```

Chrome profile is opt-in because it's large and contains ephemeral state.

### Auth handling

`auth.json` is encrypted with machine-bound key: `PBKDF2(machine-id + username, salt)`. Cannot be decrypted on a different machine. **Auth belongs to workspace scope** (not global).

**Backup auth error policy:**
- **Default:** If auth.json exists and cannot be decrypted, **backup fails** with `AuthDecryptionError`.
- **`--skip-auth`:** Skips auth.json entirely. Manifest: `authIncluded: false`.
- No ambiguous state — `authMode` and `authIncluded` are always consistent.

**Backup flow:**
1. Try `decryptCredentials(raw)` on auth.json
2. If decryption fails and no `--skip-auth` → abort with `AuthDecryptionError`
3. If decryption succeeds:
   - Password provided → `encryptWithPassword(plain, password)` → `authMode: "password"`
   - No password → store as plain JSON → `authMode: "plain"` → warn user

**Restore auth flow** (explicit — no blind copy):
1. If `authIncluded: false` → skip, no auth.json created in target
2. Read auth.json from extracted archive
3. If `authMode: "password"` → `decryptWithPassword(raw, password)` → get plain JSON
4. If `authMode: "plain"` → use as-is
5. **Always** re-encrypt: `encryptCredentials(plain)` → write to target `.janus/auth.json` with 0o600

Auth.json is never blindly copied from archive to target. It always goes through the decrypt → re-encrypt pipeline.

**Password encryption payload format** (self-describing):
```json
{
  "_backup_encrypted": true,
  "kdf": "pbkdf2",
  "digest": "sha512",
  "iterations": 100000,
  "salt": "hex...",
  "iv": "hex...",
  "tag": "hex...",
  "data": "hex..."
}
```

All KDF parameters stored in payload. Future versions can change digest/iterations and old backups still decrypt. Using `sha512` for PBKDF2 digest. Node's `pbkdf2Sync` requires explicit digest — never rely on defaults.

### Password input

**Precedence:** `--password` > `--password-file` > interactive prompt (CLI wrapper only)

**`--password-file` behavior:**
- Read as UTF-8 text
- Trim trailing newline(s)
- Empty result after trim = validation error

**Interactive prompt policy:**
- Only prompt when auth.json exists and `authIncluded` would be true
- Never prompt for `--only-global`, `--skip-auth`, or when no auth.json exists

Core logic functions receive a resolved `password: string | undefined`. They never touch readline.

### SQLite backup

**Always use `db.backup(destination)` API** (better-sqlite3).

Flow:
1. Open source DB: `new BetterSqlite3(dbPath, { readonly: true })`
2. Call `db.backup(stagingDbPath)` — creates consistent snapshot to a separate file
3. Close source DB
4. Compute sha256 on the staged snapshot (not the source file)

better-sqlite3 documents that during `backup()`, if another connection modifies the source DB, the backup may be restarted automatically. This is correct for online backups. Never use `copyFileSync` for the DB — WAL mode means the on-disk file alone may be incomplete.

### Checksum computation

**Checksums are always computed on staged/final content, not source files.**

Critical because:
- `auth.json` is transformed (decrypted → re-encrypted or stored plain)
- `janus.db` is transformed (live DB → snapshot via `db.backup()`)

Flow: stage all files to temp directory → compute sha256 on each staged file → write manifest → create tar.gz.

### Restore safety

#### Path traversal protection

Two levels of validation:
1. **During tar extraction:** Validate every entry path. Use canonical `resolve(extractDir, entryPath)` and check that result starts with `resolve(extractDir) + path.sep` (or equals `resolve(extractDir)`). Do not rely on string `includes()`.
2. **During copy to target:** Validate every file path from manifest before writing. Same canonical resolve check against target root.

If any path escapes at either level → abort with `PathTraversalError`.
Symlink entries in archive → abort with `PathTraversalError`.

#### Restore "empty target" definition

- **Workspace restore:** target is considered empty if **none** of the managed paths exist (`janus.json`, `.janus/`, `memory/`, `sessions/`, `AGENTS.md`, `HEARTBEAT.md`, `JANUS.md`). The directory itself (cwd) may exist.
- **Global restore:** analogous — target is empty if none of the restored global files exist in `~/.janus/`.

#### Atomic restore flow

**Case A: Empty target (fresh install)**
1. Extract archive to temp directory
2. Validate manifest, checksums, paths
3. Handle auth.json through decrypt → re-encrypt pipeline
4. Copy directly to target (no rollback needed)

**Case B: Existing data in target**
1. Extract archive to temp directory
2. Validate manifest, checksums, paths
3. Create rollback snapshot of **only the managed paths that will be overwritten**:
   - Workspace: `janus.json`, `AGENTS.md`, `HEARTBEAT.md`, `JANUS.md`, `.janus/`, `memory/`, `sessions/`
   - Global: `EGO.md`, `config.json`, `history`, `chrome-profile/`
   - Only snapshot paths that actually exist AND are in the archive
4. Handle auth.json through decrypt → re-encrypt pipeline
5. Copy validated files from extract to target (controlled merge)
6. On failure after rollback creation: restore from rollback, clean up, abort
7. On success: clean up temp dirs (extract + rollback)

#### Overwrite policy

- **Default:** Restore overwrites only files present in the archive. Does **not** delete existing files not in the archive (additive + overwrite known files).
- No `--prune` in phase 1.

### Permissions policy

- `auth.json`: force mode 0o600 on POSIX after restore
- All other files: standard default permissions, no mode-bit restoration in phase 1
- **Windows:** skip mode-bit enforcement entirely, report as not-applicable in doctor

### Error taxonomy

| Error | Meaning | Exit code |
|-------|---------|-----------|
| `BackupError` | General backup failure | 1 |
| `RestoreError` | General restore failure | 1 |
| `ManifestValidationError` | Missing, malformed, or multiple manifests | 1 |
| `ChecksumMismatchError` | sha256 doesn't match manifest | 1 |
| `PathTraversalError` | Path escapes target directory or symlink in archive | 1 |
| `AuthDecryptionError` | Cannot decrypt auth.json (wrong password or machine key) | 1 |
| `UnsupportedFormatVersionError` | `formatVersion` not recognized | 1 |
| User cancelled | Interactive restore confirmation declined | 2 |

All domain/validation errors → exit 1. User cancellation → exit 2. Success → exit 0.

---

## Commands

### `janus backup` (phase 1: `npm start -- backup`)

```
Options:
  --output <path>       Output file path (default: ./janus-backup-<timestamp>.tar.gz)
  --password <pass>     Encrypt credentials with this password
  --password-file <f>   Read password from file (utf-8, trailing newline trimmed)
  --only-global         Only backup ~/.janus/
  --only-workspace      Only backup workspace data
  --no-sessions         Exclude session history
  --include-chrome      Include Chrome profile (off by default)
  --dry-run             Show what would be backed up
  --verify              Verify archive checksums after creation
  --skip-auth           Skip auth.json if it can't be decrypted
```

**Flow:**
1. Collect file list (workspace + global), stage to temp directory
2. Handle auth.json: decrypt → re-encrypt with password or store plain. Fail if undecryptable (unless `--skip-auth`).
3. Create SQLite snapshot via `db.backup(stagingPath)`
4. Compute sha256 for every staged file
5. Write manifest.json (not included in `files[]`)
6. Create tar.gz
7. If `--verify`: run full verification
8. Clean up staging, print summary

### `--verify` semantics

After creating the archive:
1. Open the archive
2. Read manifest
3. Extract to separate temp directory
4. Compute sha256 for every extracted file
5. Compare against manifest: `fileCount`, `totalBytes`, per-file `sha256`
6. Fail if: archive can't be opened, manifest can't be parsed, extracted file missing from manifest, manifest references file missing from archive, any checksum mismatch
7. Only report "backup complete" if all checks pass

### `janus restore <archive>` (phase 1: `npm start -- restore`)

```
Options:
  --password <pass>     Password for encrypted backup
  --password-file <f>   Read password from file (utf-8, trailing newline trimmed)
  --no-global           Skip restoring ~/.janus/
  --no-workspace        Skip restoring workspace data
  --dry-run             Show what would be restored
```

**Flow:**
1. Read manifest only (selective extraction — see below)
2. Show summary, prompt for confirmation
3. Get password: `--password` > `--password-file` > interactive prompt (only if `authMode: "password"`)
4. Extract full archive to temp directory
5. Validate: `formatVersion`, checksums, path traversal (both extract and manifest paths), no symlinks
6. Determine if target is empty or has existing data
7. If existing data: create rollback snapshot of managed paths being overwritten
8. Copy files to target (additive overwrite), auth through decrypt → re-encrypt pipeline
9. On failure: restore from rollback, clean up
10. On success: clean up, suggest `janus doctor`

### `readManifest(archivePath)`

**Implementation requirement:** Read only `manifest.json` from the archive via selective/streaming extraction. Do NOT extract the full archive just to read the manifest.

**Implementation note:** May scan archive headers/entries to identify the single root and manifest path, but must not fully extract payload files.

**Error handling:**
- No `manifest.json` found → `ManifestValidationError`
- Archive has no root directory or multiple roots → `ManifestValidationError`
- Manifest not at expected location `{root}/manifest.json` → `ManifestValidationError`
- Manifest JSON parse fails → `ManifestValidationError`

### `janus doctor` (phase 1: `npm start -- doctor`)

**Core checks** (affect pass/fail):

| Check | Pass | Warn | Fail |
|-------|------|------|------|
| `janus.json` | Exists + JSON parse OK | — | Missing or unparseable |
| `.janus/` directory | Exists | — | Missing |
| `janus.db` | Exists + `integrity_check` OK | — | Missing or corrupted |
| DB version ≤ migrations | OK | `user_version < migrations.length` (pending) | `user_version > migrations.length` (future/incompatible) |
| Required dirs (`memory/`, `sessions/`) | Exist | — | Missing → auto-create, report `fixed`. Phase 1: doctor always treats these as required and auto-creates them. |
| `auth.json` (exists) | Decryptable | — | Malformed or undecryptable |
| `auth.json` (missing) | — | Fresh install, no credentials | — |
| Permissions (POSIX) | `auth.json` is 0o600 | Wrong mode | — |
| Permissions (Windows) | N/A (skipped) | — | — |

**Diagnostics** (informational, never affect pass/fail):

| Check | Info |
|-------|------|
| Pending migrations | "N pending, will apply on next start" |
| Google Workspace | Authenticated or not |
| Optional dirs | `.janus/users/`, `.janus/agents/` present or not |

---

## Files affected

| File | Change |
|------|--------|
| `src/commands/backup-errors.ts` | New: domain error classes |
| `src/commands/backup-utils.ts` | New: `sha256File()`, `assertPathSafe()`, `collectFiles()`, `formatBytes()` |
| `src/auth/crypto.ts` | Add `encryptWithPassword()`, `decryptWithPassword()`, `isBackupEncrypted()` (digest=sha512, self-describing payload) |
| `src/commands/doctor.ts` | New: `runDoctorChecks()`, `runDoctor()` CLI wrapper |
| `src/commands/backup.ts` | New: `createBackupArchive()`, `verifyArchive()`, `runBackup()` CLI wrapper |
| `src/commands/restore.ts` | New: `restoreFromArchive()`, `readManifest()`, `runRestore()` CLI wrapper |
| `src/index.ts` | Register backup, restore, doctor commands |
| `tests/unit/auth-backup-crypto.test.ts` | Password encryption tests |
| `tests/unit/doctor.test.ts` | Doctor check tests |
| `tests/unit/backup-restore.test.ts` | Backup + restore + verify integration tests |

---

## Testing

### auth-backup-crypto.test.ts
| Scenario | Test |
|----------|------|
| Round-trip encrypt → decrypt | plain → encrypt → decrypt → equals plain |
| Wrong password fails | Throws |
| Payload self-describing | kdf, digest=sha512, iterations fields present |
| Detects backup-encrypted format | `isBackupEncrypted()` true/false |

### doctor.test.ts
| Scenario | Test |
|----------|------|
| Healthy workspace | All core pass |
| Missing janus.json | fail |
| Missing database | fail |
| Corrupted database | fail |
| Missing auth.json (fresh install) | warn |
| Existing undecryptable auth.json | fail |
| Missing dirs auto-created | fixed |
| GWS diagnostic only | Never fail |
| DB version > migrations | fail |
| DB version < migrations | warn (pending) |
| Windows: permissions skipped | info / N/A |

### backup-restore.test.ts
| Scenario | Test |
|----------|------|
| Full backup with checksums | Valid manifest, all sha256 correct |
| SQLite via db.backup() | Extracted DB passes integrity_check |
| Auth encrypted with password | `_backup_encrypted: true` |
| Auth plain without password | Plain JSON |
| `--no-sessions` | No session files, `optionalSections.sessions: false` |
| `--include-chrome` | Chrome files (minus exclusions) |
| `--dry-run` | No archive created |
| `--verify` valid | All checksums match |
| `--verify` corrupt | Checksum mismatch detected |
| `--skip-auth` undecryptable | `authIncluded: false` |
| Undecryptable auth no skip | `AuthDecryptionError` |
| Restore empty target | Files placed correctly |
| Restore re-encrypts auth | Machine-encrypted after restore |
| Restore password-protected | Decrypt + re-encrypt |
| Restore wrong password | `AuthDecryptionError` |
| Path traversal in manifest | `PathTraversalError` |
| Symlink in archive | `PathTraversalError` |
| Checksum mismatch | `ChecksumMismatchError` |
| Missing manifest | `ManifestValidationError` |
| Unsupported formatVersion | `UnsupportedFormatVersionError` |
| Multiple roots in archive | `ManifestValidationError` |
| Restore without auth | Works, no auth.json in target |
| Restore over existing | Additive overwrite, rollback on failure |
| Rollback on failure | Original data restored |
| Global-only / workspace-only | Scope filtering |
| readManifest selective | Only manifest.json extracted |
| Source symlink skipped in backup | Warning logged, file excluded |
| fileCount matches files[] length | Manifest consistency |
| totalBytes matches sum of sizes | Manifest consistency |

---

## Migration path

1. `npm start -- update` (gets code with backup/restore)
2. `npm start -- backup --password mysecret`
3. New server: `git clone`, `npm install`
4. `npm start -- restore backup.tar.gz --password mysecret`
5. `npm start -- doctor`
6. `npx gws auth setup` (if using Google Workspace)
7. `npm start -- gateway`
