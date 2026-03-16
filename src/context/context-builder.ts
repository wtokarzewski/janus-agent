import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SkillDefinition } from '../skills/types.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import type { JanusConfig } from '../config/schema.js';
import type { InboundMessage } from '../bus/types.js';
import type { SkillLearner } from '../learner/learner.js';
import { loadProfileMd, findUserProfile, sanitizeChatId } from '../users/user-resolver.js';

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
 * 2. Ego: .janus/EGO.md (agent character, per-workspace)
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

    // 1c. Shared chat files directory (group chats — Telegram group IDs start with '-')
    if (opts.chatId && opts.chatId.startsWith('-')) {
      const safeChatId = sanitizeChatId(opts.chatId);
      const chatFilesDir = resolve(this.deps.config.workspace.dir, '.janus', 'chats', safeChatId, 'files');
      parts.push(`<chat_files>\n${chatFilesDir}/\n</chat_files>`);
    }

    if (!minimal) {
      // 2. Ego (EGO.md from .janus/)
      const ego = await this.loadEgo();
      if (ego) parts.push(ego);

      // 3. Agents (AGENTS.md from workspace + per-user override)
      const agents = await this.loadAgents(opts.user?.userId);
      if (agents) parts.push(agents);

      // 4. Heartbeat (HEARTBEAT.md from workspace + per-user)
      const heartbeat = await this.loadHeartbeat(opts.user?.userId);
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

    // 8. Session info (dynamic — not cached by Anthropic prompt caching)
    // Use date-only (no time) to maximize Anthropic prompt cache hits within a day
    const now = new Date().toISOString().slice(0, 10);
    const sessionParts = [`Current date: ${now}`, `Channel: ${opts.channel}`, `Chat: ${opts.chatId}`];
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
    const userDir = resolve(this.deps.config.workspace.dir, '.janus', 'users', user.userId);
    const lines = [
      `You are talking to ${user.name ?? user.userId} (userId: ${user.userId}).`,
      `User directory: ${userDir}`,
      `User files: ${resolve(userDir, 'files')}/`,
    ];
    const profile = await loadProfileMd(user.userId, this.deps.config.workspace.dir, profilePath);
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
    const workspace = resolve(this.deps.config.workspace.dir);
    const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');

    // Anthropic OAuth requires system prompt starting with Claude Code identity prefix
    const oauthPrefix = (this.deps.config.llm.auth === 'oauth'
      && this.deps.config.llm.provider === 'anthropic')
      ? "You are Claude Code, Anthropic's official CLI for Claude.\n\n"
      : '';

    return `<identity>
${oauthPrefix}You are Janus, a universal AI agent.

Workspace: ${workspace}

Available tools:
${toolList}
</identity>`;
  }

  private async loadEgo(): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir, '.janus');

    try {
      const content = await readFile(resolve(dir, 'EGO.md'), 'utf-8');
      if (content.trim()) {
        return `<ego>\n${content.trim()}\n</ego>`;
      }
    } catch {
      // No EGO.md
    }
    return null;
  }

  private async loadAgents(userId?: string): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    const parts: string[] = [];

    // Global AGENTS.md
    try {
      const content = await readFile(resolve(dir, 'AGENTS.md'), 'utf-8');
      if (content.trim()) parts.push(content.trim());
    } catch {
      // No global AGENTS.md
    }

    // Per-user override
    if (userId) {
      try {
        const content = await readFile(resolve(dir, '.janus', 'users', userId, 'AGENTS.md'), 'utf-8');
        if (content.trim()) parts.push(`<!-- user-specific rules for ${userId} -->\n${content.trim()}`);
      } catch {
        // No per-user AGENTS.md
      }
    }

    return parts.length > 0 ? `<agents>\n${parts.join('\n\n')}\n</agents>` : null;
  }

  private async loadHeartbeat(userId?: string): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    const parts: string[] = [];

    // Global HEARTBEAT.md
    try {
      const content = await readFile(resolve(dir, 'HEARTBEAT.md'), 'utf-8');
      if (content.trim()) parts.push(content.trim());
    } catch {
      // No global HEARTBEAT.md
    }

    // Per-user HEARTBEAT.md
    if (userId) {
      try {
        const content = await readFile(resolve(dir, '.janus', 'users', userId, 'HEARTBEAT.md'), 'utf-8');
        if (content.trim()) parts.push(`<!-- heartbeat tasks for ${userId} -->\n${content.trim()}`);
      } catch {
        // No per-user HEARTBEAT.md
      }
    }

    return parts.length > 0 ? `<heartbeat>\n${parts.join('\n\n')}\n</heartbeat>` : null;
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

    const skillEntries: string[] = [];
    let totalChars = 0;

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

    return `<skills>\n${skillEntries.join('\n')}\n</skills>`;
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

      // Always include recent daily notes in full (per-user when userId available)
      const recentDays = this.deps.config.memory?.recentDays ?? 3;
      for (let d = 0; d < recentDays; d++) {
        const date = new Date();
        date.setDate(date.getDate() - d);
        const dateStr = date.toISOString().slice(0, 10);
        const dayNote = await this.deps.memory.readDaily(dateStr, userId);
        if (dayNote.trim()) {
          const label = d === 0 ? 'today' : dateStr;
          parts.push(`<memory_chunk source="${label}" section="daily_note">\n${dayNote.trim()}\n</memory_chunk>`);
        }
      }

      if (parts.length > 0) {
        return `<memory>\n${parts.join('\n')}\n</memory>`;
      }
    }

    // Fallback: full dump (no index, no results, or no user message)
    const ctx = await this.deps.memory.getContext(userId);
    const parts: string[] = [];

    if (ctx.memory) parts.push(`<!-- MEMORY.md -->\n${ctx.memory}`);
    if (ctx.recentNotes) parts.push(`<!-- recent notes -->\n${ctx.recentNotes}`);

    return parts.length > 0 ? `<memory>\n${parts.join('\n\n')}\n</memory>` : null;
  }
}
