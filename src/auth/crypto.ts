/**
 * Credential encryption — AES-256-GCM for auth.json at rest (CR-M).
 *
 * Key derivation: PBKDF2(machine-id + username, salt, 100k iterations) → 256-bit key.
 * Machine ID: /etc/machine-id on Linux, IOPlatformUUID on macOS, hostname fallback.
 * Salt: persisted alongside encrypted data (not secret, prevents rainbow tables).
 *
 * Format: JSON { _encrypted: true, salt: hex, iv: hex, tag: hex, data: hex }
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = 'sha256';

interface EncryptedPayload {
  _encrypted: true;
  salt: string; // hex
  iv: string;   // hex
  tag: string;  // hex
  data: string; // hex
}

let _machineIdCache: string | undefined;

function getMachineId(): string {
  if (_machineIdCache !== undefined) return _machineIdCache;

  // Linux: /etc/machine-id
  try {
    _machineIdCache = readFileSync('/etc/machine-id', 'utf-8').trim();
    return _machineIdCache;
  } catch { /* not Linux */ }

  // macOS: IOPlatformUUID
  try {
    const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'], // suppress stderr on non-macOS
    });
    const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) {
      _machineIdCache = match[1];
      return _machineIdCache;
    }
  } catch { /* not macOS or no ioreg */ }

  // Windows: MachineGuid from registry
  try {
    const out = execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    if (match) {
      _machineIdCache = match[1];
      return _machineIdCache;
    }
  } catch { /* not Windows or no registry access */ }

  // Fallback: hostname (weaker but deterministic)
  _machineIdCache = hostname();
  return _machineIdCache;
}

function deriveKey(salt: Buffer): Buffer {
  const secret = `${getMachineId()}:${userInfo().username}`;
  return pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

export function encryptCredentials(plainJson: string): string {
  const salt = randomBytes(16);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plainJson, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: EncryptedPayload = {
    _encrypted: true,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };

  return JSON.stringify(payload, null, 2) + '\n';
}

export function decryptCredentials(raw: string): string {
  const payload = JSON.parse(raw) as EncryptedPayload;

  if (!payload._encrypted) {
    // Plain-text auth.json (legacy/unencrypted) — return as-is
    return raw;
  }

  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const data = Buffer.from(payload.data, 'hex');

  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** Check if a raw file content is encrypted. */
export function isEncrypted(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return parsed._encrypted === true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Password-based backup encryption (separate from machine-bound)    */
/* ------------------------------------------------------------------ */

const BACKUP_ITERATIONS = 100_000;
const BACKUP_DIGEST = 'sha512';

interface BackupEncryptedPayload {
  _backup_encrypted: true;
  kdf: 'pbkdf2';
  digest: string;
  iterations: number;
  salt: string; // hex
  iv: string;   // hex
  tag: string;  // hex
  data: string; // hex
}

function deriveKeyFromPassword(
  password: string,
  salt: Buffer,
  digest: string,
  iterations: number,
): Buffer {
  return pbkdf2Sync(password, salt, iterations, KEY_LENGTH, digest);
}

/** Encrypt plaintext JSON with a user-provided password (for portable backups). */
export function encryptWithPassword(plainJson: string, password: string): string {
  const salt = randomBytes(16);
  const key = deriveKeyFromPassword(password, salt, BACKUP_DIGEST, BACKUP_ITERATIONS);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plainJson, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload: BackupEncryptedPayload = {
    _backup_encrypted: true,
    kdf: 'pbkdf2',
    digest: BACKUP_DIGEST,
    iterations: BACKUP_ITERATIONS,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };

  return JSON.stringify(payload, null, 2);
}

/** Decrypt a password-encrypted backup payload. Reads KDF params from the payload itself. */
export function decryptWithPassword(raw: string, password: string): string {
  const payload = JSON.parse(raw) as BackupEncryptedPayload;

  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const data = Buffer.from(payload.data, 'hex');

  const key = deriveKeyFromPassword(password, salt, payload.digest, payload.iterations);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** Check if a raw string is a password-encrypted backup payload. */
export function isBackupEncrypted(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return parsed._backup_encrypted === true;
  } catch {
    return false;
  }
}
