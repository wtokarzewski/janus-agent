import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as log from '../utils/logger.js';
import type { SkillDefinition } from '../skills/types.js';
import { type MemoryStore, scopeForChat } from '../memory/memory-store.js';
import type { SkillLoader } from '../skills/skill-loader.js';
import type { JanusConfig } from '../config/schema.js';
import type { InboundMessage } from '../bus/types.js';
import type { SkillLearner } from '../learner/learner.js';
import { loadProfileMd, findUserProfile, sanitizeChatId, loadSkillChannels } from '../users/user-resolver.js';
import type { AgentContext } from '../agent/agent-resolver.js';
import type { Database } from '../db/database.js';
import { getKnownChats } from '../db/known-chats.js';
import { localDate, localDateWithDay, localTimestamp, getTimezone } from '../utils/date.js';
import { buildPinnedStateSection, isSkillActiveForChat, type SkillChannelPref } from './pinned-state.js';
import { assembleWithBoundary } from '../prompts/cache-boundary.js';

/** Split system prompt into cacheable static part and per-request dynamic part. */
export interface ContextResult {
  staticPart: string;
  dynamicPart: string;
  /**
   * Single system-prompt string with explicit CACHE_BOUNDARY marker between
   * static (cacheable) and dynamic content. New consumers should use this
   * field; legacy staticPart/dynamicPart kept for backwards compatibility.
   */
  systemPrompt: string;
  /** Absolute paths of pinned skill state files — for summarization filter. */
  pinnedPaths?: Set<string>;
}

interface ContextDeps {
  skills: SkillLoader;
  memory: MemoryStore;
  config: JanusConfig;
  learner?: SkillLearner;
  database?: Database;
}

/**
 * Build system prompt from all context sources.
 * Returns { staticPart, dynamicPart } for Anthropic prompt caching.
 *
 * Static part (cached — stable across requests):
 * 1. Identity (agent name, workspace, tools — NO timestamp)
 * 2. Known users
 * 3. Chat files dir
 * 4. Ego: .janus/EGO.md
 * 5. Agents: ./AGENTS.md
 * 6. Heartbeat: ./HEARTBEAT.md
 * 7. Project: ./JANUS.md
 * 8. Skills
 *
 * Dynamic part (NOT cached — changes per request):
 * 1. User section (profile)
 * 2. Memory search results
 * 3. Learner recommendations
 * 4. Session info (date + time + channel + sender)
 * 5. Previous summary
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
    mode?: 'full' | 'minimal' | 'background';
    user?: InboundMessage['user'];
    scope?: InboundMessage['scope'];
    agentCtx?: AgentContext;
  }): Promise<ContextResult> {
    const staticParts: string[] = [];
    const dynamicParts: string[] = [];
    const minimal = opts.mode === 'minimal';
    const background = opts.mode === 'background';

    // Resolve user profile for filtering
    const userProfile = opts.user?.userId
      ? findUserProfile(opts.user.userId, this.deps.config)
      : undefined;

    // --- STATIC PART (cacheable — stable across requests) ---

    // 1. Identity — filter tools by user allow/deny (NO timestamp — fully static)
    let tools = opts.tools;
    if (userProfile?.tools) {
      tools = this.filterTools(tools, userProfile.tools.allow, userProfile.tools.deny);
    }
    staticParts.push(this.buildIdentity(tools, opts.agentCtx));

    // 1c. Known users (id + name + channel identities)
    if (this.deps.config.users.length > 0) {
      const userLines = this.deps.config.users.map(u => {
        const channels = u.identities
          ?.filter(i => i.channelUserId)
          .map(i => `${i.channel}:${i.channelUserId}`)
          .join(', ') ?? '';
        return `- ${u.id} (${u.name})${channels ? ` channels: ${channels}` : ''}`;
      });
      staticParts.push(`<known_users>\n${userLines.join('\n')}\n</known_users>`);
    }

    // 1d. Shared chat files directory (group chats — Telegram group IDs start with '-')
    if (opts.chatId && opts.chatId.startsWith('-')) {
      const safeChatId = sanitizeChatId(opts.chatId);
      const chatFilesDir = resolve(this.deps.config.workspace.dir, '.janus', 'chats', safeChatId, 'files');
      staticParts.push(`<chat_files>\n${chatFilesDir}/\n</chat_files>`);
    }

    if (!minimal) {
      // 2. Ego (EGO.md — agent path override: null=skip, undefined=global)
      if (opts.agentCtx?.egoPath !== null) {
        const ego = await this.loadEgo(opts.agentCtx?.egoPath);
        if (ego) staticParts.push(ego);
      }

      // 3. Agents (AGENTS.md — agent path override + per-user override)
      if (opts.agentCtx?.agentsFilePath !== null) {
        const agents = await this.loadAgents(opts.user?.userId, opts.agentCtx?.agentsFilePath);
        if (agents) staticParts.push(agents);
      }

      // 4. Heartbeat (HEARTBEAT.md — agent path override + per-user) — skip in background mode
      if (!background && opts.agentCtx?.heartbeatFilePath !== null) {
        const heartbeat = await this.loadHeartbeat(opts.user?.userId, opts.agentCtx?.heartbeatFilePath);
        if (heartbeat) staticParts.push(heartbeat);
      }

      // 5. Project file (JANUS.md from workspace) — skip in background mode
      if (!background) {
        const project = await this.loadProjectFile();
        if (project) staticParts.push(project);
      }
    }

    // 6. Skills — filter by user allow/deny
    const skillsSection = await this.buildSkillsSection(userProfile?.skills);
    if (skillsSection) staticParts.push(skillsSection);

    // --- DYNAMIC PART (per-request — NOT cached) ---

    // 1b. User section (profile content can change)
    if (opts.user) {
      const userSection = await this.buildUserSection(opts.user, userProfile?.profilePath);
      if (userSection) dynamicParts.push(userSection);
    }

    // Skill channel routing — known chats + preferences (per-user)
    let pinnedPathsForSummary: Set<string> | undefined;
    if (opts.user?.userId) {
      const knownChats = this.buildKnownChatsSection(opts.user.userId);
      if (knownChats) dynamicParts.push(knownChats);

      // Hoist single loadSkillChannels read — shared by skill_channels section and pinned filter.
      const skillPrefs = await loadSkillChannels(opts.user.userId, this.deps.config.workspace.dir);

      const skillChannels = this.buildSkillChannelsSection(skillPrefs);
      if (skillChannels) dynamicParts.push(skillChannels);

      // Pinned skill state — survives summarization. Loaded fresh each call.
      // See docs/superpowers/specs/2026-05-14-pinned-skill-state-design.md.
      try {
        const allSkills = await this.deps.skills.loadAll();
        const activeSkills = allSkills.filter(s =>
          isSkillActiveForChat(s, opts.channel, opts.chatId, skillPrefs),
        );
        const pinned = await buildPinnedStateSection({
          skills: activeSkills,
          workspaceDir: this.deps.config.workspace.dir,
          userId: opts.user.userId,
          today: localDate(),
          yesterday: localDate(new Date(Date.now() - 86_400_000)),
        });
        if (pinned) {
          dynamicParts.push(pinned.xml);
          pinnedPathsForSummary = pinned.pinnedPaths;
        }
      } catch (err) {
        log.warn(`[pinned] failed to build pinned section: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!minimal && !background) {
      // 7. Memory (hybrid: FTS5 search if available, else full dump)
      const memoryAgentId = opts.agentCtx && !opts.agentCtx.memoryShared ? opts.agentCtx.id : undefined;
      const memorySection = await this.buildMemorySection(opts.userMessage, opts.user?.userId, opts.scope, memoryAgentId, opts.chatId);
      if (memorySection) dynamicParts.push(memorySection);

      // 7b. Learner recommendations (if enough data)
      if (opts.userMessage && this.deps.learner) {
        const learnerSection = await this.buildLearnerSection(opts.userMessage);
        if (learnerSection) dynamicParts.push(learnerSection);
      }
    }

    // 8. Session info (dynamic — changes every request)
    const nowDate = localDateWithDay();
    const nowTime = localTimestamp();
    const tz = getTimezone();
    const timeLine = tz ? `Time: ${nowTime} (${tz})` : `Time: ${nowTime}`;
    const sessionParts = [`Date: ${nowDate}`, timeLine, `Channel: ${opts.channel}`, `Chat: ${opts.chatId}`];
    if (opts.user) {
      const senderLabel = opts.user.name ? `${opts.user.name} (${opts.user.userId})` : opts.user.userId;
      sessionParts.push(`Sender: ${senderLabel}`);
    }
    if (opts.agentCtx) sessionParts.push(`Agent: ${opts.agentCtx.id}`);
    if (opts.scope) sessionParts.push(`Scope: ${opts.scope.kind}:${opts.scope.id}`);
    dynamicParts.push(`<session>\n${sessionParts.join('\n')}\n</session>`);

    // 9. Previous summary
    if (opts.summary) {
      dynamicParts.push(`<previous_summary>\n${opts.summary}\n</previous_summary>`);
    }

    const staticPart = staticParts.join('\n\n---\n\n');
    const dynamicPart = dynamicParts.join('\n\n---\n\n');
    return {
      staticPart,
      dynamicPart,
      systemPrompt: assembleWithBoundary(staticParts, dynamicParts),
      pinnedPaths: pinnedPathsForSummary,
    };
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

  private buildKnownChatsSection(userId: string): string | null {
    if (!this.deps.database) return null;
    const chats = getKnownChats(this.deps.database, userId);
    if (chats.length === 0) return null;

    const lines = chats.map(c => {
      const label = c.chatName ? ` (${c.chatType ?? 'chat'}: ${c.chatName})` : '';
      return `- ${c.channel}:${c.chatId}${label}`;
    });
    return `<your_chats>\n${lines.join('\n')}\n</your_chats>`;
  }

  private buildSkillChannelsSection(prefs: Record<string, SkillChannelPref>): string | null {
    const entries = Object.entries(prefs);
    if (entries.length === 0) return null;

    const lines = entries.map(([skill, pref]) => {
      const label = pref.chatName ? ` (${pref.chatName})` : '';
      return `- ${skill} → ${pref.channel}:${pref.chatId}${label}`;
    });
    lines.push('');
    lines.push('When a skill has a preferred channel different from the current chat:');
    lines.push('- Send a brief redirect note on current chat');
    lines.push('- Use the message tool to deliver the full response to the preferred channel');
    return `<skill_channels>\n${lines.join('\n')}\n</skill_channels>`;
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

  private buildIdentity(tools: Array<{ name: string; description: string }>, agentCtx?: AgentContext): string {
    const workspace = resolve(this.deps.config.workspace.dir);
    const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
    const agentName = agentCtx?.name ?? 'Janus';
    const agentDesc = agentCtx?.definition.description ? ` — ${agentCtx.definition.description}` : '';

    return `<identity>
You are ${agentName}${agentDesc}, a universal AI agent.

Workspace: ${workspace}

Available tools:
${toolList}
</identity>`;
  }

  private async loadEgo(pathOverride?: string): Promise<string | null> {
    const egoPath = pathOverride
      ? resolve(this.deps.config.workspace.dir, pathOverride)
      : resolve(this.deps.config.workspace.dir, '.janus', 'EGO.md');

    try {
      const content = await readFile(egoPath, 'utf-8');
      if (content.trim()) {
        return `<ego>\n${content.trim()}\n</ego>`;
      }
    } catch {
      // No EGO.md
    }
    return null;
  }

  private async loadAgents(userId?: string, pathOverride?: string): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    const parts: string[] = [];

    // Global AGENTS.md (or agent-specific override)
    const agentsPath = pathOverride ? resolve(dir, pathOverride) : resolve(dir, 'AGENTS.md');
    try {
      const content = await readFile(agentsPath, 'utf-8');
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

  private async loadHeartbeat(userId?: string, pathOverride?: string): Promise<string | null> {
    const dir = resolve(this.deps.config.workspace.dir);
    const parts: string[] = [];

    // Global HEARTBEAT.md (or agent-specific override)
    const hbPath = pathOverride ? resolve(dir, pathOverride) : resolve(dir, 'HEARTBEAT.md');
    try {
      const content = await readFile(hbPath, 'utf-8');
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
    agentId?: string,
    chatId?: string,
  ): Promise<string | null> {
    const memScope = scopeForChat({ scope, userId, chatId, agentId });
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
        const dateStr = localDate(date);
        const dayNote = await this.deps.memory.readDaily(dateStr, memScope);
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
    const ctx = await this.deps.memory.getContext(memScope);
    const parts: string[] = [];

    if (ctx.memory) parts.push(`<!-- MEMORY.md -->\n${ctx.memory}`);
    if (ctx.recentNotes) parts.push(`<!-- recent notes -->\n${ctx.recentNotes}`);

    return parts.length > 0 ? `<memory>\n${parts.join('\n\n')}\n</memory>` : null;
  }
}
