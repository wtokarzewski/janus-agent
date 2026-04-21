import { z } from 'zod';

const LogLevelSchema = z.enum(['minimal', 'normal', 'verbose']).default('normal');
export type LogLevel = z.infer<typeof LogLevelSchema>;

// --- NEW: providers + slots config ---

/** Provider entry: auth method, priority, optional apiBase */
const ProviderEntrySchema = z.object({
  auth: z.enum(['api_key', 'oauth', 'cli']).optional(),
  priority: z.number(),
  apiBase: z.string().optional(),
  logLevel: LogLevelSchema.optional(),
});

/** Slot: maps provider name → model ID, or null to use default slot */
const SlotSchema = z.nullable(z.record(z.string(), z.string()));

const ThinkingSchema = z.object({
  enabled: z.boolean().default(false),
  budgetTokens: z.number().default(10_000),
  level: z.enum(['off', 'minimal', 'low', 'medium', 'high']).optional(),
});

// --- LEGACY: flat single-provider config (for backward compat during migration) ---

const LegacyProviderSpecSchema = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  apiKey: z.string().default(''),
  apiBase: z.string().optional(),
  auth: z.enum(['api_key', 'oauth', 'cli']).optional(),
  purpose: z.array(z.string()).optional(),
  priority: z.number().optional(),
  logLevel: LogLevelSchema.optional(),
});

export type LegacyProviderSpec = z.infer<typeof LegacyProviderSpecSchema>;

const LLMSchema = z.object({
  // NEW format: providers + slots
  providers: z.record(z.string(), ProviderEntrySchema).optional(),
  slots: z.record(z.string(), SlotSchema).optional(),

  // LEGACY flat fields (kept for backward compat — normalized at load time)
  provider: z.enum(['openrouter', 'anthropic', 'openai', 'deepseek', 'groq', 'claude-agent', 'codex']).optional(),
  auth: z.enum(['api_key', 'oauth', 'cli']).optional(),
  apiKey: z.string().optional(),
  apiBase: z.string().optional(),
  model: z.string().optional(),

  // LEGACY providers[] array
  /** @deprecated Use providers object + slots instead */
  legacyProviders: z.array(LegacyProviderSpecSchema).optional(),

  // Shared LLM settings (format-independent)
  maxTokens: z.number().default(4096),
  temperature: z.number().default(0.3),
  toolTemperature: z.number().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  thinking: ThinkingSchema.optional(),
});

// --- Resolved types (computed at load time, used by runtime) ---

export interface ResolvedProvider {
  name: string;           // provider key (e.g. "anthropic", "openrouter")
  auth: 'api_key' | 'oauth' | 'cli';
  priority: number;
  apiBase?: string;
  logLevel?: LogLevel;
}

export interface ResolvedSlot {
  name: string;           // slot key (e.g. "default", "background")
  entries: Array<{
    provider: string;     // provider key
    model: string;        // model ID for this provider
    priority: number;     // inherited from provider
  }>;
}

export interface ResolvedLLM {
  providers: ResolvedProvider[];
  slots: ResolvedSlot[];
  // Shared settings
  maxTokens: number;
  temperature: number;
  toolTemperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  thinking?: { enabled: boolean; budgetTokens: number; level?: 'off' | 'minimal' | 'low' | 'medium' | 'high' };
}

// --- Rest of config schemas (unchanged) ---

const LanesSchema = z.object({
  user: z.number().default(6),
  cron: z.number().default(3),
  heartbeat: z.number().default(2),
});

const SubagentsSchema = z.object({
  maxSpawnDepth: z.number().default(1),
  maxChildrenPerAgent: z.number().default(5),
  maxConcurrentSubagents: z.number().default(8),
});

const ContextSchema = z.object({
  keepRecentTokens: z.number().default(20_000),
  reserveTokens: z.number().default(20_000),
  toolResultMaxShare: z.number().min(0.01).max(1.0).default(0.3),
  toolResultHardMax: z.number().default(400_000),
  softTrimChars: z.number().default(4000),
  compactionThresholds: z.tuple([z.number(), z.number(), z.number()]).default([0.75, 0.80, 0.85]),
  emergencyThreshold: z.number().default(0.95),
  protectedTailTurns: z.number().min(0).default(3),
});

const AgentSchema = z.object({
  summarizationThreshold: z.number().default(40),
  tokenBudget: z.number().default(750_000),
  contextWindow: z.number().default(1_000_000),
  toolRetries: z.number().default(2),
  onLLMError: z.enum(['stop', 'retry']).default('retry'),
  onToolError: z.enum(['continue', 'ask']).default('continue'),
  maxSkillsInPrompt: z.number().default(150),
  maxSkillsPromptChars: z.number().default(30_000),
  lanes: LanesSchema.optional().transform(v => LanesSchema.parse(v ?? {})),
  subagents: SubagentsSchema.optional().transform(v => SubagentsSchema.parse(v ?? {})),
  context: ContextSchema.optional().transform(v => ContextSchema.parse(v ?? {})),
});

const WorkspaceSchema = z.object({
  dir: z.string().default('.'),
  memoryDir: z.string().default('memory'),
  sessionsDir: z.string().default('sessions'),
  skillsDir: z.string().default('skills'),
});

const WhatsAppSchema = z.object({
  enabled: z.boolean().default(false),
  authDir: z.string().default('~/.janus/whatsapp-auth'),
  allowlist: z.array(z.string()).default([]),
  maxMessageLength: z.number().default(4000),
});

const DatabaseSchema = z.object({
  enabled: z.boolean().default(true),
  path: z.string().default('.janus/janus.db'),
});

const CronSchema = z.object({
  cleanup: z.object({
    enabled: z.boolean().default(true),
    /** How often to run cleanup (days). */
    intervalDays: z.number().default(7),
    /** Time of day to run cleanup (HH:MM, local time). */
    time: z.string().regex(/^\d{2}:\d{2}$/).default('00:05'),
    /** Delete disabled one-shot (at) jobs older than this many days. */
    maxAgeDaysOneShot: z.number().default(7),
    /** Delete disabled recurring (every/cron) jobs older than this many days. */
    maxAgeDaysRecurring: z.number().default(30),
  }).optional().transform(v => v ?? { enabled: true, intervalDays: 7, time: '00:05', maxAgeDaysOneShot: 7, maxAgeDaysRecurring: 30 }),
});

const HeartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMs: z.number().default(60_000),
});

const AutoUpdateSchema = z.object({
  enabled: z.boolean().default(false),
  schedule: z.string().default('0 9 * * 1'),
});

const TelegramSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  allowlist: z.array(z.string()).default([]),
  denyByDefault: z.boolean().default(true),
  groupPolicy: z.enum(['all', 'mention']).default('all'),
});

const StreamingSchema = z.object({
  enabled: z.boolean().default(true),
  telegramThrottleMs: z.number().default(500),
});

const GatesSchema = z.object({
  enabled: z.boolean().default(true),
  execPatterns: z.array(z.string()).default([
    'rm\\s',
    'git\\s+push',
    'git\\s+reset',
    'npm\\s+publish',
    'docker\\s+rm',
  ]),
});

const MemorySchema = z.object({
  vectorSearch: z.boolean().default(false),
  vectorWeight: z.number().default(1.0),
  textWeight: z.number().default(1.0),
  recentDays: z.number().default(3),
});

const VoiceSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['groq']).default('groq'),
  apiKey: z.string().optional(),
  language: z.string().optional(),
  maxDurationSec: z.number().default(300),
});

const VisionSchema = z.object({
  enabled: z.boolean().default(true),
  maxFileSizeMb: z.number().default(10),
});

const TTSSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai']).default('openai'),
  apiKey: z.string().optional(),
  model: z.enum(['tts-1', 'tts-1-hd']).default('tts-1'),
  voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).default('nova'),
});

const BrowserOperatorSchema = z.object({
  chromePath: z.string().optional(),
  profileDir: z.string().optional(),
  headless: z.boolean().default(false),
});

const MCPServerSpecSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const MCPSchema = z.object({
  servers: z.array(MCPServerSpecSchema).default([]),
});

const UserIdentitySchema = z.object({
  channel: z.string(),
  channelUserId: z.string().optional(),
  channelUsername: z.string().optional(),
}).refine(
  id => id.channelUserId || id.channelUsername,
  { message: 'Identity must have at least channelUserId or channelUsername' },
);

const ToolPolicySchema = z.object({
  maxRecencyDays: z.number().optional(),
  domainsAllow: z.array(z.string()).optional(),
  domainsDeny: z.array(z.string()).optional(),
  contentRating: z.enum(['G', 'PG', 'PG13', 'R']).optional(),
});

const UserProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  identities: z.array(UserIdentitySchema).default([]),
  profilePath: z.string().optional(),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    policy: ToolPolicySchema.optional(),
  }).optional(),
  skills: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

const FamilySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  groupChatIds: z.array(z.string()).default([]),
});

const ToolsSchema = z.object({
  /** Master switch for exec tool. When false, exec is not registered and cron jobs cannot run commands. */
  execEnabled: z.boolean().default(true),
  execTimeout: z.number().default(30_000),
  execDenyPatterns: z.array(z.string()).default([
    'rm\\s+-rf\\s+/',
    'rm\\s+-rf\\s+~',
    'sudo\\s+rm',
    'mkfs',
    ':\\(\\)\\{:|:&\\};:',
    '>\\s*/dev/sda',
    'dd\\s+if=/dev/zero',
    'sqlite3\\s+.*\\.janus/',
    'sqlite3\\s+.*janus\\.db',
  ]),
  maxFileSize: z.number().default(1_048_576),
  webSearchApiKey: z.string().optional(),
  webFetchTimeoutMs: z.number().default(10_000),
  webFetchMaxBytes: z.number().default(51_200),
  execDenyPatternsExtra: z.array(z.string()).default([]),
});

// --- Multi-agent routing ---

const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const AgentDefinitionSchema = z.object({
  id: z.string().regex(AGENT_ID_RE, 'Agent ID must be 1-64 lowercase alphanumeric chars with _ or -'),
  name: z.string(),
  description: z.string().optional(),
  ego: z.string().nullable().optional(),
  agentsFile: z.string().nullable().optional(),
  heartbeatFile: z.string().nullable().optional(),
  skillsDirs: z.array(z.string()).default([]),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  }).optional(),
  llm: z.object({
    slots: z.record(z.string(), SlotSchema).optional(),
  }).optional(),
  params: z.object({
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
  }).optional(),
  memory: z.object({
    shared: z.boolean().default(true),
  }).optional(),
  heartbeat: z.object({
    isolatedSession: z.boolean().default(false),
    activeHours: z.object({
      start: z.string(),
      end: z.string(),
      tz: z.string().optional(),
    }).optional(),
  }).optional(),
  subagents: z.object({
    allowAgents: z.array(z.string()).default(['*']),
  }).optional(),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

const BindingSchema = z.object({
  agentId: z.string(),
  match: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});

export type Binding = z.infer<typeof BindingSchema>;

const SessionSchema = z.object({
  dmScope: z.enum(['main', 'per-peer', 'per-channel-peer']).default('per-channel-peer'),
  identityLinks: z.record(z.string(), z.array(z.string())).default({}),
});

export const JanusConfigSchema = z.object({
  llm: LLMSchema.optional().transform(v => LLMSchema.parse(v ?? {})),
  agent: AgentSchema.optional().transform(v => AgentSchema.parse(v ?? {})),
  workspace: WorkspaceSchema.optional().transform(v => WorkspaceSchema.parse(v ?? {})),
  tools: ToolsSchema.optional().transform(v => ToolsSchema.parse(v ?? {})),
  database: DatabaseSchema.optional().transform(v => DatabaseSchema.parse(v ?? {})),
  cron: CronSchema.optional().transform(v => CronSchema.parse(v ?? {})),
  heartbeat: HeartbeatSchema.optional().transform(v => HeartbeatSchema.parse(v ?? {})),
  whatsapp: WhatsAppSchema.optional().transform(v => WhatsAppSchema.parse(v ?? {})),
  telegram: TelegramSchema.optional().transform(v => TelegramSchema.parse(v ?? {})),
  streaming: StreamingSchema.optional().transform(v => StreamingSchema.parse(v ?? {})),
  gates: GatesSchema.optional().transform(v => GatesSchema.parse(v ?? {})),
  memory: MemorySchema.optional().transform(v => MemorySchema.parse(v ?? {})),
  voice: VoiceSchema.optional().transform(v => VoiceSchema.parse(v ?? {})),
  vision: VisionSchema.optional().transform(v => VisionSchema.parse(v ?? {})),
  tts: TTSSchema.optional().transform(v => TTSSchema.parse(v ?? {})),
  mcp: MCPSchema.optional().transform(v => MCPSchema.parse(v ?? {})),
  browserOperator: BrowserOperatorSchema.optional().transform(v => BrowserOperatorSchema.parse(v ?? {})),
  autoUpdate: AutoUpdateSchema.optional().transform(v => AutoUpdateSchema.parse(v ?? {})),
  users: z.array(UserProfileSchema).default([]),
  ownerIds: z.array(z.string()).default([]),
  family: FamilySchema.optional(),
  agents: z.array(AgentDefinitionSchema).default([]),
  bindings: z.array(BindingSchema).default([]),
  defaultAgentId: z.string().default('main'),
  session: SessionSchema.optional().transform(v => SessionSchema.parse(v ?? {})),
  /** IANA timezone (e.g. "Europe/Warsaw"). Auto-detected from system if omitted. */
  timezone: z.string().optional(),
});

export type RawJanusConfig = z.infer<typeof JanusConfigSchema>;

/** Full config with resolved LLM providers/slots (computed at load time) */
export type JanusConfig = RawJanusConfig & {
  resolved: ResolvedLLM;
};
