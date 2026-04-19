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
