import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parse as parseYAML } from 'yaml';
import type { JanusConfig } from '../config/schema.js';
import type { SkillDefinition, SkillSummary } from './types.js';
import * as log from '../utils/logger.js';

/**
 * Load SKILL.md files with YAML frontmatter + markdown body.
 * Search order: workspace/skills → ~/.janus/skills → builtin/skills
 * Cache is invalidated when any skills directory mtime changes.
 */
export class SkillLoader {
  private dirs: string[];
  private cache = new Map<string, SkillDefinition>();
  private dirMtimes = new Map<string, number>();

  constructor(config: JanusConfig) {
    this.dirs = [
      resolve(config.workspace.dir, config.workspace.skillsDir),
      resolve(config.workspace.dir, '.janus', 'skills'),
      resolve(import.meta.dirname ?? '.', '..', '..', 'skills'),
    ];
  }

  async loadAll(): Promise<SkillDefinition[]> {
    if (this.cache.size > 0 && !(await this.dirsChanged())) {
      return Array.from(this.cache.values());
    }

    this.cache.clear();
    for (const dir of this.dirs) {
      await this.loadFromDir(dir);
    }

    await this.snapshotMtimes();
    log.info(`Loaded ${this.cache.size} skills`);
    return Array.from(this.cache.values());
  }

  async load(name: string): Promise<SkillDefinition | undefined> {
    if (this.cache.size === 0) await this.loadAll();
    return this.cache.get(name);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getSummaries(): Promise<SkillSummary[]> {
    const skills = await this.loadAll();
    return skills.map(s => ({
      name: s.name,
      description: s.description,
      isAlwaysLoaded: s.always,
      location: s.location,
    }));
  }

  private async loadFromDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // dir doesn't exist
    }

    for (const entry of entries) {
      // Look for SKILL.md in subdirectories or directly
      const skillPath = entry.endsWith('.md')
        ? join(dir, entry)
        : join(dir, entry, 'SKILL.md');

      try {
        const content = await readFile(skillPath, 'utf-8');
        const skill = this.parseSkillMd(content, skillPath);
        if (skill && !this.cache.has(skill.name)) {
          this.cache.set(skill.name, skill);
          log.debug(`Loaded skill: ${skill.name} (${skill.always ? 'always' : 'on-demand'})`);
        }
      } catch {
        // Not a skill, skip
      }
    }
  }

  /** Check if any skills directory (or subdirectory) has a newer mtime than last snapshot. */
  private async dirsChanged(): Promise<boolean> {
    for (const dir of this.dirs) {
      try {
        const dirStat = await stat(dir);
        const prev = this.dirMtimes.get(dir) ?? 0;
        if (dirStat.mtimeMs !== prev) return true;

        // Also check subdirectory mtimes (skill edits change subdir mtime)
        const entries = await readdir(dir);
        for (const entry of entries) {
          const subPath = join(dir, entry);
          try {
            const subStat = await stat(subPath);
            if (subStat.isDirectory()) {
              const subPrev = this.dirMtimes.get(subPath) ?? 0;
              if (subStat.mtimeMs !== subPrev) return true;
            }
          } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist */ }
    }
    return false;
  }

  /** Snapshot current mtimes for all skills directories and subdirectories. */
  private async snapshotMtimes(): Promise<void> {
    this.dirMtimes.clear();
    for (const dir of this.dirs) {
      try {
        const dirStat = await stat(dir);
        this.dirMtimes.set(dir, dirStat.mtimeMs);

        const entries = await readdir(dir);
        for (const entry of entries) {
          const subPath = join(dir, entry);
          try {
            const subStat = await stat(subPath);
            if (subStat.isDirectory()) {
              this.dirMtimes.set(subPath, subStat.mtimeMs);
            }
          } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist */ }
    }
  }

  private parseSkillMd(content: string, filePath: string): SkillDefinition | null {
    // Split YAML frontmatter from markdown body
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const [, yamlStr, body] = match;
    if (!yamlStr || !body) return null;

    try {
      const meta = parseYAML(yamlStr) as Record<string, unknown>;

      return {
        name: String(meta.name ?? 'unknown'),
        description: String(meta.description ?? ''),
        version: String(meta.version ?? '0.0.0'),
        requires: meta.requires as SkillDefinition['requires'],
        always: Boolean(meta.always ?? false),
        complexity: meta.complexity as SkillDefinition['complexity'],
        instructions: body.trim(),
        location: filePath,
      };
    } catch (err) {
      log.warn(`Failed to parse skill: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
