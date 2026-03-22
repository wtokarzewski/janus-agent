import type { JanusConfig, AgentDefinition } from '../config/schema.js';
import type { InboundMessage } from '../bus/types.js';

export interface AgentContext {
  id: string;
  name: string;
  definition: AgentDefinition;
  egoPath: string | null | undefined;
  agentsFilePath: string | null | undefined;
  heartbeatFilePath: string | null | undefined;
  skillDirs: string[];
  toolAllow?: string[];
  toolDeny?: string[];
  slotOverrides?: Record<string, Record<string, string>>;
  memoryShared: boolean;
  params?: { temperature?: number; maxTokens?: number };
  heartbeatIsolatedSession: boolean;
  heartbeatActiveHours?: { start: string; end: string; tz?: string };
  allowedSubagents: string[];
}

/** Default implicit agent — synthesized when agents[] is empty (zero behavioral change). */
function defaultAgent(): AgentDefinition {
  return { id: 'main', name: 'Janus', skillsDirs: [] };
}

/**
 * Resolve inbound messages to agent contexts via config-driven bindings.
 * Generic match bag: each key in binding.match must exist in the routing bag with the same value.
 * First match wins (array ordering = priority).
 */
export class AgentResolver {
  private agents: Map<string, AgentContext>;
  private bindings: Array<{ agentId: string; match: Record<string, string | number> }>;
  private defaultId: string;
  private dmScope: 'main' | 'per-peer' | 'per-channel-peer';
  private identityMap: Map<string, string>; // "telegram:123" → canonical user ID

  constructor(config: JanusConfig) {
    this.defaultId = config.defaultAgentId ?? 'main';
    this.bindings = config.bindings ?? [];
    this.dmScope = config.session?.dmScope ?? 'per-channel-peer';

    // Build identity links map: "channel:userId" → canonical ID
    this.identityMap = new Map();
    for (const [canonicalId, identities] of Object.entries(config.session?.identityLinks ?? {})) {
      for (const identity of identities) {
        this.identityMap.set(identity, canonicalId);
      }
    }

    // Build agent contexts
    this.agents = new Map();
    const defs = config.agents.length > 0 ? config.agents : [defaultAgent()];

    for (const def of defs) {
      this.agents.set(def.id, {
        id: def.id,
        name: def.name,
        definition: def,
        egoPath: def.ego,
        agentsFilePath: def.agentsFile,
        heartbeatFilePath: def.heartbeatFile,
        skillDirs: def.skillsDirs ?? [],
        toolAllow: def.tools?.allow,
        toolDeny: def.tools?.deny,
        slotOverrides: def.llm?.slots as Record<string, Record<string, string>> | undefined,
        memoryShared: def.memory?.shared ?? true,
        params: def.params,
        heartbeatIsolatedSession: def.heartbeat?.isolatedSession ?? false,
        heartbeatActiveHours: def.heartbeat?.activeHours,
        allowedSubagents: def.subagents?.allowAgents ?? ['*'],
      });
    }
  }

  /** Build routing bag from message and resolve to agent context. */
  resolve(msg: InboundMessage): AgentContext {
    // If message already has agentId (e.g. cron job), use it directly
    if (msg.agentId) {
      return this.agents.get(msg.agentId) ?? this.getDefault();
    }

    // Build routing bag from common fields + channel-specific metadata
    const bag: Record<string, string | number | undefined> = {
      channel: msg.channel,
      chatId: msg.chatId,
      userId: msg.user?.userId,
      ...msg.routingMeta,
    };

    // Iterate bindings — first match wins
    for (const binding of this.bindings) {
      if (this.matchesBinding(bag, binding.match)) {
        const ctx = this.agents.get(binding.agentId);
        if (ctx) return ctx;
      }
    }

    return this.getDefault();
  }

  /**
   * Build session key with DMScope logic.
   * Group chats always use {agentId}:{channel}:{chatId}.
   * DMs vary by dmScope: main, per-peer (cross-platform), per-channel-peer (default).
   */
  resolveSessionKey(agentId: string, msg: InboundMessage): string {
    // Group chats (Telegram groups have negative chatId or contain ':')
    const isGroup = msg.chatId.startsWith('-') || msg.chatId.includes(':');
    if (isGroup) {
      return `${agentId}:${msg.channel}:${msg.chatId}`;
    }

    switch (this.dmScope) {
      case 'main':
        return `${agentId}:main`;
      case 'per-peer': {
        const channelIdentity = `${msg.channel}:${msg.user?.userId ?? msg.chatId}`;
        const canonical = this.identityMap.get(channelIdentity) ?? msg.user?.userId ?? msg.chatId;
        return `${agentId}:direct:${canonical}`;
      }
      case 'per-channel-peer':
      default:
        return `${agentId}:${msg.channel}:${msg.chatId}`;
    }
  }

  get(agentId: string): AgentContext | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentContext[] {
    return Array.from(this.agents.values());
  }

  private getDefault(): AgentContext {
    return this.agents.get(this.defaultId) ?? this.agents.values().next().value!;
  }

  /** Check if every key in match exists in the routing bag with the same value. */
  private matchesBinding(
    bag: Record<string, string | number | undefined>,
    match: Record<string, string | number>,
  ): boolean {
    for (const [key, expected] of Object.entries(match)) {
      if (bag[key] === undefined || String(bag[key]) !== String(expected)) {
        return false;
      }
    }
    return true;
  }
}
