import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SkillDefinition } from '../skills/types.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import type { JanusConfig } from '../config/schema.js';
import type { InboundMessage } from '../bus/types.js';
import type { SkillLearner } from '../learner/learner.js';
import { loadProfileMd, findUserProfile } from '../users/user-resolver.js';

interface ContextDeps {
  skills: SkillLoader;
  memory: MemoryStore;
  config: JanusConfig;
  learner?: SkillLearner;
}

/**
 * Build system prompt from all context sources.
 * Assembly order:
 * 1. Identity (time, workspace, tools)
 * 2. Ego: ~/.janus/EGO.md (agent character, global)
 * 3. Agents: ./AGENTS.md (agent behavior rules, per-workspace)
 * 4. Heartbeat: ./HEARTBEAT.md (autonomous tasks, per-workspace)
 * 5. Project: ./JANUS.md (per-repo instructions)
 * 6. Skills (always-loaded = full, on-demand = summary)
 * 7. Memory (MEMORY.md + daily note)
 * 8. Session info
 */
export class ContextBuilder {
  private deps: ContextDeps;

  constructor(deps: ContextDeps) {
    this.deps = deps;
  }

  async build(opts: {
    channel: string;
    chatId: string;
    tools: Array<{ name: string; description: string }>;
    summary?: string;
    userMessage?: string;
    mode?: 'full' | 'minimal';
    user?: InboundMessage['user'];
    scope?: InboundMessage['scope'];
  }): Promise<string> {
    const parts: string[] = [];
    const minimal = opts.mode === 'minimal';

    // Resolve user profile for filtering
    const userProfile = opts.user?.userId
      ? findUserProfile(opts.user.userId, this.deps.config)
      : undefined;

    // 1. Identity — filter tools by user allow/deny
    let tools = opts.tools;
    if (userProfile?.tools) {
      tools = this.filterTools(tools, userProfile.tools.allow, userProfile.tools.deny);
    }
    parts.push(this.buildIdentity(tools));

    // 1b. User section
    if (opts.user) {
      const userSection = await this.buildUserSection(opts.user, userProfile?.profilePath);
      if (userSection) parts.push(userSection);
    }

    if (!minimal) {
      // 2. Ego (EGO.md from ~/.janus/)
      const ego = await this.loadEgo();
      if (ego) parts.push(ego);

      // 3. Agents (AGENTS.md from workspace)
      const agents = await this.loadAgents();
      if (agents) parts.push(agents);

      // 4. Heartbeat (HEARTBEAT.md from workspace)
      const heartbeat = await this.loadHeartbeat();
      if (heartbeat) parts.push(heartbeat);

      // 5. Project file (JANUS.md from workspace)
      const project = await this.loadProjectFile();
      if (project) parts.push(project);
    }

    // 6. Skills — filter by user allow/deny
    const skillsSection = await this.buildSkillsSection(userProfile?.skills);
    if (skillsSection) parts.push(skillsSection);

    if (!minimal) {
      // 7. Memory (hybrid: FTS5 search if available, else full dump)
      const memorySection = await this.buildMemorySection(opts.userMessage, opts.user?.userId, opts.scope);
      if (memorySection) parts.push(memorySection);

      // 7b. Learner recommendations (if enough data)
      if (opts.userMessage && this.deps.learner) {
        const learnerSection = await this.buildLearnerSection(opts.userMessage);
        if (learnerSection) parts.push(learnerSection);
      }
    }

    // 8. Session info
    const sessionParts = [`Channel: ${opts.channel}`, `Chat: ${opts.chatId}`];
    if (opts.user) sessionParts.push(`User: ${opts.user.userId}`);
    if (opts.scope) sessionParts.push(`Scope: ${opts.scope.kind}:${opts.scope.id}`);
    parts.push(`<session>\n${sessionParts.join('\n')}\n</session>`);

    // 9. Previous summary
    if (opts.summary) {
      parts.push(`<previous_summary>\n${opts.summary}\n</previous_summary>`);
    }

    return parts.join('\n\n---\n\n');
  }

  private async buildUserSection(
    user: NonNullable<InboundMessage['user']>,
    profilePath?: string,
  ): Promise<string | null> {
    const lines = [`You are talking to ${user.name ?? user.userId} (userId: ${user.userId}).`];
    const profile = await loadProfileMd(user.userId, profilePath);
    if (profile?.trim()) {
      lines.push(profile.trim());
    }
    return `<user>\n${lines.join('\n')}\n</user>`;
  }

  private filterTools(
    tools: Array<{ name: string; description: string }>,
    allow?: string[],
    deny?: string[],
  ): Array<{ name: string; description: string }> {
    let filtered = tools;
    if (allow) {
      filtered = filtered.filter(t => allow.includes(t.name));
    }
    if (deny) {
      filtered = filtered.filter(t => !deny.includes(t.name));
    }
    return filtered;
  }

  private buildIdentity(tools: Array<{ name: string; description: string }>): string {
    const now = new Date().toISOString();
    const workspace = resolve(this.deps.config.workspace.dir);
    const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    return `<identity>
You are Janus, a universal AI agent.

Current time: ${now}
Workspace: ${workspace}

Available tools:
${toolList}
</identity>`;
  }

  private async loadEgo(): Promise<string | null> {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return null;

    try {
      const content = await readFile(resolve(home, '.janus', 'EGO.md'), 'utf-8');
      if (content.trim()) {
        return `<ego>\n${content.trim()}\n</ego>`;
      }
    } catch {
      // No EGO.md
    }
    return null;
  }

  private async loadAgents(): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    try {
      const content = await readFile(resolve(dir, 'AGENTS.md'), 'utf-8');
      if (content.trim()) {
        return `<agents>\n${content.trim()}\n</agents>`;
      }
    } catch {
      // No AGENTS.md in this workspace
    }
    return null;
  }

  private async loadHeartbeat(): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    try {
      const content = await readFile(resolve(dir, 'HEARTBEAT.md'), 'utf-8');
      if (content.trim()) {
        return `<heartbeat>\n${content.trim()}\n</heartbeat>`;
      }
    } catch {
      // No HEARTBEAT.md in this workspace
    }
    return null;
  }

  private async loadProjectFile(): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    try {
      const content = await readFile(resolve(dir, 'JANUS.md'), 'utf-8');
      if (content.trim()) {
        return `<project>\n${content.trim()}\n</project>`;
      }
    } catch {
      // No JANUS.md in this workspace
    }
    return null;
  }

  private async buildSkillsSection(
    skillFilter?: { allow?: string[]; deny?: string[] },
  ): Promise<string | null> {
    let skills: SkillDefinition[];
    try {
      skills = await this.deps.skills.loadAll();
    } catch {
      return null;
    }

    // Apply user skill allow/deny filters
    if (skillFilter?.allow) {
      skills = skills.filter(s => skillFilter.allow!.includes(s.name));
    }
    if (skillFilter?.deny) {
      skills = skills.filter(s => !skillFilter.deny!.includes(s.name));
    }

    if (skills.length === 0) return null;

    const maxChars = this.deps.config.agent.maxSkillsPromptChars;
    const maxCount = this.deps.config.agent.maxSkillsInPrompt;

    const instructions = `<instructions>
Before responding, scan the skill descriptions below.
If exactly one skill clearly applies to the user's request, read its file with read_file, then follow the instructions.
If multiple could apply, choose the most specific one.
If none apply, proceed without loading a skill.
Never read more than one skill at a time.
</instructions>`;

    const skillEntries: string[] = [];
    let totalChars = instructions.length;

    for (const s of skills.slice(0, maxCount)) {
      let entry: string;
      if (s.always) {
        entry = `<skill name="${s.name}" description="${s.description}" location="${s.location}" always="true">\n${s.instructions}\n</skill>`;
      } else {
        entry = `<skill name="${s.name}" description="${s.description}" location="${s.location}" />`;
      }

      if (totalChars + entry.length > maxChars) {
        skillEntries.push('<!-- skill list truncated due to size limit -->');
        break;
      }
      skillEntries.push(entry);
      totalChars += entry.length;
    }

    return `<skills>\n${instructions}\n${skillEntries.join('\n')}\n</skills>`;
  }

  private async buildLearnerSection(task: string): Promise<string | null> {
    try {
      const rec = await this.deps.learner!.getRecommendations(task);
      if (!rec || rec.sampleSize <= 3) return null;

      const lines = [
        `Based on ${rec.sampleSize} similar tasks: avg duration ${rec.avgDuration}ms, avg iterations ${rec.avgIterations}, success rate ${Math.round(rec.successRate * 100)}%.`,
      ];
      if (rec.avgIterations > 3) {
        lines.push('Consider breaking this task into smaller steps.');
      }
      if (rec.successRate < 0.7) {
        lines.push('This type of task has low success rate — be extra careful.');
      }
      return `<learner>\n${lines.join('\n')}\n</learner>`;
    } catch {
      return null;
    }
  }

  private async buildMemorySection(
    userMessage?: string,
    userId?: string,
    scope?: InboundMessage['scope'],
  ): Promise<string | null> {
    // Hybrid search: if index available and user message provided, search FTS5 (+ vectors if enabled)
    if (this.deps.memory.hasIndex && userMessage) {
      const useVector = this.deps.config.memory?.vectorSearch ?? false;
      const chunks = useVector
        ? await this.deps.memory.hybridSearch(userMessage, 8, userId, scope)
        : await this.deps.memory.search(userMessage, 8, userId, scope);
      const parts: string[] = [];

      if (chunks.length > 0) {
        for (const chunk of chunks) {
          parts.push(`<memory_chunk source="${chunk.source}" section="${chunk.heading}">\n${chunk.content}\n</memory_chunk>`);
        }
      }

      // Always include today's daily note in full
      const todayNote = await this.deps.memory.readDaily();
      if (todayNote.trim()) {
        parts.push(`<memory_chunk source="today" section="daily_note">\n${todayNote.trim()}\n</memory_chunk>`);
      }

      if (parts.length > 0) {
        return `<memory>\n${parts.join('\n')}\n</memory>`;
      }
    }

    // Fallback: full dump (no index, no results, or no user message)
    const ctx = await this.deps.memory.getContext();
    const parts: string[] = [];

    if (ctx.memory) parts.push(`<!-- MEMORY.md -->\n${ctx.memory}`);
    if (ctx.recentNotes) parts.push(`<!-- recent notes -->\n${ctx.recentNotes}`);

    return parts.length > 0 ? `<memory>\n${parts.join('\n\n')}\n</memory>` : null;
  }
}
