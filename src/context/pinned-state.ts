import { readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { SkillDefinition } from '../skills/types.js';
import * as log from '../utils/logger.js';

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
  const fileBlocks: string[] = [];
  const pinnedPaths = new Set<string>();
  let totalChars = 0;

  for (const skill of skillsWithPinned) {
    for (const rawPath of skill.pinned) {
      const resolvedRelPath = substituteTemplates(rawPath, input);
      const absPath = resolve(userFilesRoot, resolvedRelPath);

      // Path-escape guard: absPath must stay under userFilesRoot
      const rel = relative(userFilesRoot, absPath);
      if (rel.startsWith('..') || rel === '' || rel.startsWith(`..${sep}`)) {
        log.warn(`[pinned] ${skill.name}: path escape blocked: ${rawPath}`);
        continue;
      }

      pinnedPaths.add(absPath);

      try {
        const content = await readFile(absPath, 'utf-8');
        totalChars += content.length;
        fileBlocks.push(
          `<file path="${resolvedRelPath}" skill="${skill.name}">\n${content}\n</file>`,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          fileBlocks.push(
            `<file path="${resolvedRelPath}" skill="${skill.name}" status="missing">\n` +
            `(file does not exist yet — will be created on first entry)\n</file>`,
          );
        } else {
          log.warn(`[pinned] ${skill.name}: read failed for ${resolvedRelPath}: ${(err as Error).message}`);
        }
      }
    }
  }

  if (fileBlocks.length === 0) return null;

  const tokens = Math.ceil(totalChars / 2.5);
  log.info(`[pinned] ${skillsWithPinned.length} skill(s), ${fileBlocks.length} file(s), ~${tokens} tokens`);

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
