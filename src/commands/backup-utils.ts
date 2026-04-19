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
