import { realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { sanitizeChatId } from '../users/user-resolver.js';

/**
 * Resolve and validate that a path stays within the workspace.
 * Uses realpathSync to follow symlinks and prevent traversal.
 *
 * For existing paths: resolves symlinks fully and checks prefix.
 * For non-existing paths (write-file): walks up to nearest existing ancestor.
 */
export function validatePath(workspaceDir: string, filePath: string): string {
  const realWorkspace = realpathSync(resolve(workspaceDir));
  const resolved = resolve(realWorkspace, filePath);

  // For existing paths, resolve symlinks and check
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!real.startsWith(realWorkspace + sep) && real !== realWorkspace) {
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
    if (!realAncestor.startsWith(realWorkspace + sep) && realAncestor !== realWorkspace) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }
  }

  return resolved;
}

/**
 * Validate per-user file access.
 * Call AFTER validatePath() has confirmed the path is within the workspace.
 *
 * Rules:
 * - No userId (system/cron) → allow everything
 * - .janus/users/{X}/ → allow only if X === userId
 * - .janus/chats/{X}/ → allow only if X matches chatId
 * - .janus/ root (not in users/ or chats/) → read: allow, write: block
 * - sessions/ → block (conversation history is private)
 * - memory/ → block (shared memory may contain other users' data)
 * - Everything else → allow (skills/, workspace files, etc.)
 */
export function validateUserFileAccess(
  workspaceDir: string,
  fullPath: string,
  userId: string | undefined,
  chatId: string | undefined,
  mode: 'read' | 'write',
): void {
  // System/cron context (no userId) → allow everything
  if (!userId) return;

  // Normalize to a platform-native absolute path — prefix checks below compare
  // against resolve()d directories, so a caller passing an unnormalized path
  // (e.g. forward slashes on Windows) must not silently bypass them.
  fullPath = resolve(fullPath);

  const wsDir = resolve(workspaceDir);

  // Protected directories outside .janus/
  const sessionsDir = resolve(wsDir, 'sessions');
  if (fullPath.startsWith(sessionsDir + sep) || fullPath === sessionsDir) {
    throw new Error('Access denied: session files are private.');
  }

  const memoryDir = resolve(wsDir, 'memory');
  if (fullPath.startsWith(memoryDir + sep) || fullPath === memoryDir) {
    throw new Error('Access denied: shared memory files are private. Per-user memory is at .janus/users/' + userId + '/memory/');
  }

  const janusDir = resolve(wsDir, '.janus');

  // Path outside .janus/ (and not sessions/memory) → allow (shared workspace files)
  if (!fullPath.startsWith(janusDir + sep) && fullPath !== janusDir) return;

  // Relative path within .janus/
  const relPath = fullPath.slice(janusDir.length + 1);

  // .janus/users/{X}/ → allow only if X === userId
  // Writes must target files/, memory/, or known system files (PROFILE.md, HEARTBEAT.md, AGENTS.md)
  if (relPath.startsWith('users' + sep)) {
    const parts = relPath.split(sep);
    if (parts.length >= 2 && parts[1] !== userId) {
      throw new Error('Access denied: cannot access another user\'s directory.');
    }
    if (mode === 'write' && parts.length >= 3) {
      const subPath = parts[2];
      const allowedRootFiles = ['PROFILE.md', 'HEARTBEAT.md', 'AGENTS.md'];
      const allowedSubdirs = ['files', 'memory'];
      if (!allowedRootFiles.includes(subPath) && !allowedSubdirs.includes(subPath)) {
        throw new Error(`Access denied: user files must be in .janus/users/${userId}/files/. Move the file there.`);
      }
    }
    return;
  }

  // .janus/chats/{X}/ → allow only if X matches chatId
  if (relPath.startsWith('chats' + sep)) {
    const parts = relPath.split(sep);
    const safeChatId = chatId ? sanitizeChatId(chatId) : undefined;
    if (parts.length >= 2 && (!safeChatId || parts[1] !== safeChatId)) {
      throw new Error('Access denied: cannot access another chat\'s directory.');
    }
    return;
  }

  // .janus/ root (not in users/ or chats/) — read: allow, write: block
  if (mode === 'write') {
    throw new Error(`Access denied: cannot write to .janus/ system directory. Use .janus/users/${userId}/files/ for personal files.`);
  }
}
