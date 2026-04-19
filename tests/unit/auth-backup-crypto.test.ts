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
