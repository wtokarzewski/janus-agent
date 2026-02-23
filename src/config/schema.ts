import { z } from 'zod';

const ProviderSpecSchema = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  apiKey: z.string().default(''),
  apiBase: z.string().optional(),
  purpose: z.array(z.string()).optional(),
  priority: z.number().optional(),
});

export type ProviderSpec = z.infer<typeof ProviderSpecSchema>;

const LLMSchema = z.object({
  provider: z.enum(['openrouter', 'anthropic', 'openai', 'deepseek', 'groq', 'claude-agent', 'codex']).default('openrouter'),
  apiKey: z.string().optional(),
  apiBase: z.string().optional(),
  model: z.string().default('anthropic/claude-sonnet-4-5-20250929'),
  maxTokens: z.number().default(4096),
  temperature: z.number().default(0.7),
  providers: z.array(ProviderSpecSchema).optional(),
});

const AgentSchema = z.object({
  maxIterations: z.number().default(20),
  summarizationThreshold: z.number().default(20),
  tokenBudget: z.number().default(100_000),
  contextWindow: z.number().default(128_000),
  toolRetries: z.number().default(2),
  onLLMError: z.enum(['stop', 'retry']).default('retry'),
  maxSubagentIterations: z.number().default(5),
  maxSkillsInPrompt: z.number().default(150),
  maxSkillsPromptChars: z.number().default(30_000),
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

const HeartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalMs: z.number().default(60_000),
});

const TelegramSchema = z.object({
  enabled: z.boolean().default(false),
  token: z.string().optional(),
  allowlist: z.array(z.string()).default([]),
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
});

const UserIdentitySchema = z.object({
  channel: z.string(),
  channelUserId: z.string().optional(),
  channelUsername: z.string().optional(),
});

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
  execTimeout: z.number().default(30_000),
  execDenyPatterns: z.array(z.string()).default([
    'rm\\s+-rf\\s+/',
    'rm\\s+-rf\\s+~',
    'sudo\\s+rm',
    'mkfs',
    ':\\(\\)\\{:|:&\\};:',
    '>\\s*/dev/sda',
    'dd\\s+if=/dev/zero',
  ]),
  maxFileSize: z.number().default(1_048_576),
});

export const JanusConfigSchema = z.object({
  llm: LLMSchema.optional().transform(v => LLMSchema.parse(v ?? {})),
  agent: AgentSchema.optional().transform(v => AgentSchema.parse(v ?? {})),
  workspace: WorkspaceSchema.optional().transform(v => WorkspaceSchema.parse(v ?? {})),
  tools: ToolsSchema.optional().transform(v => ToolsSchema.parse(v ?? {})),
  database: DatabaseSchema.optional().transform(v => DatabaseSchema.parse(v ?? {})),
  heartbeat: HeartbeatSchema.optional().transform(v => HeartbeatSchema.parse(v ?? {})),
  whatsapp: WhatsAppSchema.optional().transform(v => WhatsAppSchema.parse(v ?? {})),
  telegram: TelegramSchema.optional().transform(v => TelegramSchema.parse(v ?? {})),
  streaming: StreamingSchema.optional().transform(v => StreamingSchema.parse(v ?? {})),
  gates: GatesSchema.optional().transform(v => GatesSchema.parse(v ?? {})),
  memory: MemorySchema.optional().transform(v => MemorySchema.parse(v ?? {})),
  users: z.array(UserProfileSchema).default([]),
  family: FamilySchema.optional(),
});

export type JanusConfig = z.infer<typeof JanusConfigSchema>;
