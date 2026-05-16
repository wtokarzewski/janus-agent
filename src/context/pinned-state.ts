import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SkillDefinition } from '../skills/types.js';
import type { SkillChannelPref } from '../users/user-resolver.js';
import * as log from '../utils/logger.js';

export type { SkillChannelPref };

export interface BuildPinnedStateInput {
  skills: SkillDefinition[];
  workspaceDir: string;
  userId: string;
  today: string;     // YYYY-MM-DD
  yesterday: string; // YYYY-MM-DD
}

export interface BuildPinnedStateResult {
  xml: string;
  pinnedPaths: Set<string>; // absolute paths — for summarization filter
}

// Pinned files bypass summarization and live in system prompt to survive
// context compaction. See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
export async function buildPinnedStateSection(
  input: BuildPinnedStateInput,
): Promise<BuildPinnedStateResult | null> {
  const skillsWithPinned = input.skills.filter(s => s.pinned && s.pinned.length > 0);
  if (skillsWithPinned.length === 0) return null;

  const userFilesRoot = resolve(input.workspaceDir, '.janus', 'users', input.userId, 'files');
  // Resolve the root itself to handle any symlinks in the workspace path
  const realUserFilesRoot = realpathSync(resolve(userFilesRoot));

  const fileBlocks: string[] = [];
  const pinnedPaths = new Set<string>();

  for (const skill of skillsWithPinned) {
    let skillChars = 0;
    let skillFileCount = 0;

    for (const rawPath of skill.pinned) {
      const resolvedRelPath = substituteTemplates(rawPath, input);
      const absPath = resolve(userFilesRoot, resolvedRelPath);

      // Path-escape guard using realpathSync to follow symlinks.
      // Mirrors the pattern in src/tools/validate-path.ts.
      //
      // For existing paths: realpathSync resolves all symlinks, then we verify
      // the real path is inside realUserFilesRoot.
      //
      // For non-existing paths (ENOENT): build the canonical path directly from
      // the already-resolved realUserFilesRoot so the prefix check is consistent.
      let guardedPath: string;
      try {
        const realPath = realpathSync(absPath);
        if (!realPath.startsWith(realUserFilesRoot + sep) && realPath !== realUserFilesRoot) {
          log.warn(`[pinned] ${skill.name}: path escape blocked: ${rawPath}`);
          continue;
        }
        guardedPath = realPath;
      } catch {
        // realpathSync throws ENOENT for non-existing paths — treat as missing file
        // but still guard against traversal. Compute canonical path using the
        // real root so the startsWith comparison is consistent on all platforms.
        const candidatePath = resolve(realUserFilesRoot, resolvedRelPath);
        if (!candidatePath.startsWith(realUserFilesRoot + sep) && candidatePath !== realUserFilesRoot) {
          log.warn(`[pinned] ${skill.name}: path escape blocked: ${rawPath}`);
          continue;
        }
        guardedPath = candidatePath;
      }
      pinnedPaths.add(guardedPath);

      try {
        const content = await readFile(absPath, 'utf-8');
        skillChars += content.length;
        skillFileCount++;
        fileBlocks.push(
          `<file path="${resolvedRelPath}" skill="${skill.name}">\n${content}\n</file>`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          skillFileCount++;
          fileBlocks.push(
            `<file path="${resolvedRelPath}" skill="${skill.name}" status="missing">\n` +
            `(file does not exist yet — will be created on first entry)\n</file>`,
          );
        } else {
          log.warn(`[pinned] ${skill.name}: read failed for ${resolvedRelPath}: ${(err as Error).message}`);
        }
      }
    }

    if (skillFileCount > 0) {
      const tokens = Math.ceil(skillChars / 2.5);
      log.info(`[pinned] ${skill.name}: ${skillFileCount} files, ${tokens} tokens loaded`);
    }
  }

  if (fileBlocks.length === 0) return null;

  return {
    xml: `<pinned_skill_state>\n${fileBlocks.join('\n\n')}\n</pinned_skill_state>`,
    pinnedPaths,
  };
}

function substituteTemplates(path: string, ctx: BuildPinnedStateInput): string {
  return path
    .replaceAll('{today}', ctx.today)
    .replaceAll('{yesterday}', ctx.yesterday)
    .replaceAll('{userId}', ctx.userId);
}

/**
 * Returns true if a skill's pinned files should be loaded for the current chat.
 * Active when:
 *   1. The skill is always-on (`always: true`), OR
 *   2. Its skill-channels preference matches the current (channel, chatId), OR
 *   3. No skill-channels preference exists AND the skill declared pinned files.
 *
 * Rule 3 is what makes pinned state work universally for users who haven't gone
 * through the skill's "first use" channel-routing flow yet. See
 * docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
 */
export function isSkillActiveForChat(
  skill: SkillDefinition,
  channel: string,
  chatId: string,
  prefs: Record<string, SkillChannelPref>,
): boolean {
  if (skill.always) return true;
  const pref = prefs[skill.name];
  if (pref) return pref.channel === channel && pref.chatId === chatId;
  // No explicit preference: skills that declared pinned files are active everywhere
  // for this user. Avoids requiring skill-channels.json migration for existing installs.
  return skill.pinned.length > 0;
}
