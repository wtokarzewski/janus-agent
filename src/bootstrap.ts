/**
 * Shared bootstrap — creates all dependencies, wires them together.
 * Used by both CLI (index.ts) and gateway (gateway.ts).
 */

import { resolve } from 'node:path';
import type { JanusConfig } from './config/schema.js';
import { FileTokenStore, loadApiKey, getExpiringProviders } from './auth/token-store.js';
import { MessageBus } from './bus/message-bus.js';
import { createProvider } from './llm/openai-compatible-provider.js';
import { ProviderRegistry } from './llm/provider-registry.js';
import { ProviderCircuitBreaker } from './llm/circuit-breaker.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ExecTool } from './tools/builtin/exec.js';
import { ReadFileTool } from './tools/builtin/read-file.js';
import { WriteFileTool } from './tools/builtin/write-file.js';
import { AppendFileTool } from './tools/builtin/append-file.js';
import { EditFileTool } from './tools/builtin/edit-file.js';
import { ListDirTool } from './tools/builtin/list-dir.js';
import { MessageTool } from './tools/builtin/message.js';
import { SendFileTool } from './tools/builtin/send-file.js';
import { SpawnAgentTool } from './tools/builtin/spawn-agent.js';
import { SkillLearner } from './learner/learner.js';
import { JSONLLearnerStorage } from './learner/storage.js';
import { SQLiteLearnerStorage } from './learner/sqlite-storage.js';
import { tryCreateDatabase } from './db/database.js';
import type { Database } from './db/database.js';
import { MemoryIndex } from './memory/memory-index.js';
import { MemoryStore } from './memory/memory-store.js';
import { SessionManager } from './session/session-manager.js';
import { SkillLoader } from './skills/skill-loader.js';
import { ContextBuilder } from './context/context-builder.js';
import { AgentLoop } from './agent/agent-loop.js';
import { AgentResolver } from './agent/agent-resolver.js';
import { SubagentRegistry } from './agent/subagent-registry.js';
import { CronService } from './services/cron-service.js';
import { CronTool } from './tools/builtin/cron.js';
import { HeartbeatTool } from './tools/builtin/heartbeat.js';
import { WebFetchTool } from './tools/builtin/web-fetch.js';
import { WebSearchTool } from './tools/builtin/web-search.js';
import { WebSearchDDGTool } from './tools/builtin/web-search-ddg.js';
import { SelfUpdateTool } from './tools/builtin/self-update.js';
import { BrowserOperatorTool } from './tools/builtin/browser-operator.js';
import { MCPClient, createMCPProxyTool } from './mcp/client.js';
import { initGateAudit } from './gates/gate-audit.js';
import * as log from './utils/logger.js';
import { setTimezone } from './utils/date.js';
import { notifyOwners } from './utils/notify-owner.js';
import { isNonRetryableClientError } from './llm/retry.js';

export interface AppDeps {
  config: JanusConfig;
  db: Database | null;
  bus: MessageBus;
  llm: ProviderRegistry;
  tools: ToolRegistry;
  sessions: SessionManager;
  context: ContextBuilder;
  skills: SkillLoader;
  learner: SkillLearner;
  agent: AgentLoop;
  cronService: CronService | null;
  subagentRegistry: SubagentRegistry;
  mcpClients: MCPClient[];
}

export async function createApp(config: JanusConfig): Promise<AppDeps> {
  // 0. Timezone (configurable or auto-detected from system)
  setTimezone(config.timezone);

  // 0b. File logging — mirror terminal output to daily files for debugging
  if (config.logging.file.enabled) {
    const logDir = resolve(config.workspace.dir, config.logging.file.dir);
    log.initFileLogging({ dir: logDir, retentionDays: config.logging.file.retentionDays });
    log.info(`File logging enabled → ${logDir} (retention ${config.logging.file.retentionDays}d)`);
  }

  // 1. Database (optional — falls back to file-based storage)
  const db = config.database.enabled
    ? tryCreateDatabase(resolve(config.workspace.dir, config.database.path))
    : null;

  // 1b. Gate audit log (requires DB)
  if (db) {
    initGateAudit(db.db);
  }

  // 2. Core components
  const bus = new MessageBus();

  const llm = new ProviderRegistry(new ProviderCircuitBreaker(config.llm.circuitBreaker));
  const { resolved } = config;
  if (resolved.providers.length > 0) {
    const sharedTokenStore = new FileTokenStore();
    // Register each provider+slot combination
    const defaultSlot = resolved.slots.find(s => s.name === 'default');
    const backgroundSlot = resolved.slots.find(s => s.name === 'background');

    // Register default slot entries (primary purpose)
    if (defaultSlot) {
      for (const entry of defaultSlot.entries) {
        const rp = resolved.providers.find(p => p.name === entry.provider);
        if (!rp) continue;
        const isOAuth = rp.auth === 'oauth';
        const apiKey = isOAuth ? '' : (loadApiKey(entry.provider) ?? config.llm.apiKey ?? '');
        llm.register({
          name: entry.provider,
          providerName: entry.provider,
          provider: await createProvider({
            provider: entry.provider, apiKey, model: entry.model,
            apiBase: rp.apiBase, auth: rp.auth, tokenStore: isOAuth ? sharedTokenStore : undefined,
          }),
          model: entry.model,
          purpose: [],
          priority: rp.priority,
          logLevel: rp.logLevel,
        });
      }
    }

    // Register background slot entries (for cron/heartbeat/summarization)
    if (backgroundSlot && backgroundSlot.entries.length > 0) {
      for (const entry of backgroundSlot.entries) {
        const rp = resolved.providers.find(p => p.name === entry.provider);
        if (!rp) continue;
        const isOAuth = rp.auth === 'oauth';
        const apiKey = isOAuth ? '' : (loadApiKey(entry.provider) ?? config.llm.apiKey ?? '');
        // Check if this provider+model is already registered in default slot
        const alreadyRegistered = defaultSlot?.entries.some(
          e => e.provider === entry.provider && e.model === entry.model,
        );
        if (!alreadyRegistered) {
          llm.register({
            name: `${entry.provider}-background`,
            // Health is keyed by the config name, so this entry is demoted
            // together with the default-slot entry for the same upstream.
            providerName: entry.provider,
            provider: await createProvider({
              provider: entry.provider, apiKey, model: entry.model,
              apiBase: rp.apiBase, auth: rp.auth, tokenStore: isOAuth ? sharedTokenStore : undefined,
            }),
            model: entry.model,
            purpose: ['background', 'summarize', 'cron', 'heartbeat'],
            priority: rp.priority,
            logLevel: rp.logLevel,
          });
        }
      }
    }
  }

  // 3. Tools
  const tools = new ToolRegistry();
  if (config.tools.execEnabled) {
    tools.register(new ExecTool());
  }
  tools.register(new ReadFileTool());
  tools.register(new WriteFileTool());
  tools.register(new AppendFileTool());
  tools.register(new EditFileTool());
  tools.register(new ListDirTool());
  // Message tool with cross-session injection: when agent sends a message to
  // another user's chat, a ghost message is appended to the recipient's session
  // so the agent remembers what it sent when the recipient replies.
  const defaultAgentId = config.defaultAgentId ?? 'main';
  const sessionInjector = async (channel: string, chatId: string, content: string) => {
    const sessionKey = `${defaultAgentId}:${channel}:${chatId}`;
    await sessions.append(sessionKey, [{
      role: 'assistant',
      content: `[Delivered message]: ${content}`,
    }]);
  };
  tools.register(new MessageTool(bus, sessionInjector));
  tools.register(new SendFileTool(bus));
  tools.register(new HeartbeatTool());
  // Web tools
  tools.register(new WebFetchTool());
  tools.register(new BrowserOperatorTool());
  const webSearchApiKey = config.tools.webSearchApiKey ?? process.env.BRAVE_API_KEY;
  if (webSearchApiKey) {
    tools.register(new WebSearchTool(webSearchApiKey));
  } else {
    tools.register(new WebSearchDDGTool());
  }

  tools.setContext({
    workspaceDir: config.workspace.dir,
    execDenyPatterns: [...config.tools.execDenyPatterns, ...(config.tools.execDenyPatternsExtra ?? [])],
    execTimeout: config.tools.execTimeout,
    maxFileSize: config.tools.maxFileSize,
    webFetchTimeoutMs: config.tools.webFetchTimeoutMs,
    webFetchMaxBytes: config.tools.webFetchMaxBytes,
    browserChromePath: config.browserOperator?.chromePath,
    browserProfileDir: config.browserOperator?.profileDir,
    browserHeadless: config.browserOperator?.headless,
  });

  // 4. Memory
  const memory = new MemoryStore(config);
  if (db) {
    const memoryIndex = new MemoryIndex(db);
    memory.setIndex(memoryIndex);
    await memory.reindex();
    // Vector embeddings — reindex with embeddings in background (non-blocking).
    // Delayed to let Grammy bot.start() and event loop settle first.
    if (config.memory?.vectorSearch) {
      setTimeout(() => {
        memory.reindexWithEmbeddings().catch(err => {
          // Non-fatal — FTS still works without embeddings
          console.warn(`Vector embedding indexing failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, 5_000);
    }
  }

  // 5. Learner
  const learnerStorage = db
    ? new SQLiteLearnerStorage(db)
    : new JSONLLearnerStorage(resolve(config.workspace.dir, config.workspace.memoryDir, 'learner.jsonl'));
  const learner = new SkillLearner(learnerStorage);

  // 6. Sessions, Skills, Context
  const sessions = new SessionManager(config);
  const skills = new SkillLoader(config);
  const context = new ContextBuilder({ skills, memory, config, learner, database: db ?? undefined });

  // 7. Cron service (requires database)
  const cronService = db ? new CronService(db, bus, config) : null;
  if (cronService) {
    tools.register(new CronTool(cronService, config));
  }

  // 8. MCP clients (external tool servers)
  const mcpClients: MCPClient[] = [];
  for (const spec of config.mcp.servers) {
    try {
      const client = new MCPClient(spec);
      await client.connect();
      const mcpTools = await client.listTools();
      for (const mcpTool of mcpTools) {
        tools.register(createMCPProxyTool(client, spec.name, mcpTool));
      }
      mcpClients.push(client);
      log.info(`MCP server "${spec.name}": ${mcpTools.length} tool(s) registered`);
    } catch (err) {
      log.warn(`MCP server "${spec.name}" failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 9. Agent loop (with spawn_agent tool + subagent registry)
  const subagentRegistry = new SubagentRegistry();
  const agentResolver = new AgentResolver(config);
  const agentDeps = { bus, llm, tools, sessions, context, skills, config, learner, memory, agentResolver, cronService: cronService ?? undefined };
  tools.register(new SpawnAgentTool(agentDeps, subagentRegistry));
  const agent = new AgentLoop(agentDeps);

  // Self-update tool (needs agent for pre-restart flush)
  tools.register(new SelfUpdateTool({
    workspaceDir: config.workspace.dir,
    onBeforeRestart: () => agent.flushAllSessions(),
  }));

  // Proactive OAuth token refresh (OD-C): check every 30 min, refresh tokens expiring within 1 hour
  const TOKEN_REFRESH_INTERVAL = 30 * 60_000;
  const refreshStore = new FileTokenStore();
  /** One alert per provider per process — the sweep runs every 30 min. */
  const deadCredentialsReported = new Set<string>();
  const tokenRefreshTimer = setInterval(async () => {
    const expiring = getExpiringProviders(3_600_000);
    for (const provider of expiring) {
      try {
        if (provider === 'anthropic') {
          const { anthropicRefresh } = await import('./auth/anthropic-oauth.js');
          await anthropicRefresh(refreshStore);
          log.info(`Proactive OAuth refresh: ${provider} token refreshed`);
        } else if (provider === 'codex') {
          const { codexRefresh } = await import('./auth/codex-oauth.js');
          await codexRefresh(refreshStore);
          log.info(`Proactive OAuth refresh: ${provider} token refreshed`);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!isNonRetryableClientError(error)) {
          log.warn(`Proactive OAuth refresh failed for ${provider}: ${error.message}`);
          continue;
        }
        // Dead credential (expired/consumed refresh token): no amount of
        // retrying fixes it, and a warn line every 30 min goes unread until
        // someone notices the agent has been on the fallback for days.
        if (!deadCredentialsReported.has(provider)) {
          deadCredentialsReported.add(provider);
          log.error(`OAuth credentials for "${provider}" are no longer valid — run "npm start -- setup" to log in again. (${error.message})`);
          notifyOwners(bus, config, `⚠️ Logowanie do "${provider}" wygasło — Janus działa na zapasowym providerze. Uruchom \`npm start -- setup\`, żeby się przelogować.`);
        }
      }
    }
  }, TOKEN_REFRESH_INTERVAL);
  tokenRefreshTimer.unref(); // Don't block process exit

  return { config, db, bus, llm, tools, sessions, context, skills, learner, agent, cronService, subagentRegistry, mcpClients };
}
