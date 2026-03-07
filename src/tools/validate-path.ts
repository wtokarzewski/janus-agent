import { realpathSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Resolve and validate that a path stays within the workspace.
 * Uses realpathSync to follow symlinks and prevent traversal.
 *
 * For existing paths: resolves symlinks fully and checks prefix.
 * For non-existing paths (write-file): walks up to nearest existing ancestor.
 */
export function validatePath(workspaceDir: string, filePath: string, allowedDirs?: string[]): string {
  const realWorkspace = realpathSync(resolve(workspaceDir));
  const realAllowed = (allowedDirs ?? []).filter(d => existsSync(d)).map(d => realpathSync(resolve(d)));
  const resolved = resolve(realWorkspace, filePath);

  const isWithinAllowed = (realPath: string): boolean =>
    (realPath.startsWith(realWorkspace + '/') || realPath === realWorkspace) ||
    realAllowed.some(dir => realPath.startsWith(dir + '/') || realPath === dir);

  // For existing paths, resolve symlinks and check
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!isWithinAllowed(real)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
    return real;
  }

  // For non-existing paths, walk up to nearest existing ancestor
  let current = dirname(resolved);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  if (existsSync(current)) {
    const realAncestor = realpathSync(current);
    if (!isWithinAllowed(realAncestor)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
  }

  return resolved;
}
