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

function getMachineId(): string {
  // Linux: /etc/machine-id
  try {
    return readFileSync('/etc/machine-id', 'utf-8').trim();
  } catch { /* not Linux */ }

  // macOS: IOPlatformUUID
  try {
    const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  } catch { /* not macOS or no ioreg */ }

  // Fallback: hostname (weaker but deterministic)
  return hostname();
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
