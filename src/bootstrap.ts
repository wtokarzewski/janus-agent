/**
 * Shared bootstrap — creates all dependencies, wires them together.
 * Used by both CLI (index.ts) and gateway (gateway.ts).
 */

import { resolve } from 'node:path';
import type { JanusConfig } from './config/schema.js';
import { FileTokenStore } from './auth/token-store.js';
import { MessageBus } from './bus/message-bus.js';
import { createProvider } from './llm/openai-compatible-provider.js';
import { ProviderRegistry } from './llm/provider-registry.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ExecTool } from './tools/builtin/exec.js';
import { ReadFileTool } from './tools/builtin/read-file.js';
import { WriteFileTool } from './tools/builtin/write-file.js';
import { AppendFileTool } from './tools/builtin/append-file.js';
import { EditFileTool } from './tools/builtin/edit-file.js';
import { ListDirTool } from './tools/builtin/list-dir.js';
import { MessageTool } from './tools/builtin/message.js';
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
import { SubagentRegistry } from './agent/subagent-registry.js';
import { CronService } from './services/cron-service.js';
import { CronTool } from './tools/builtin/cron.js';
import { HeartbeatTool } from './tools/builtin/heartbeat.js';
import { WebFetchTool } from './tools/builtin/web-fetch.js';
import { WebSearchTool } from './tools/builtin/web-search.js';
import { WebSearchDDGTool } from './tools/builtin/web-search-ddg.js';
import { SelfUpdateTool } from './tools/builtin/self-update.js';
import { MCPClient, createMCPProxyTool } from './mcp/client.js';
import * as log from './utils/logger.js';

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
  // 1. Database (optional — falls back to file-based storage)
  const db = config.database.enabled
    ? tryCreateDatabase(resolve(config.workspace.dir, config.database.path))
    : null;

  // 2. Core components
  const bus = new MessageBus();

  const llm = new ProviderRegistry();
  if (config.llm.providers && config.llm.providers.length > 0) {
    for (const spec of config.llm.providers) {
      llm.register({
        name: spec.name,
        provider: await createProvider({ provider: spec.provider, apiKey: spec.apiKey, model: spec.model, apiBase: spec.apiBase }),
        model: spec.model,
        purpose: spec.purpose ?? [],
        priority: spec.priority ?? 0,
      });
    }
  } else {
    const apiKey = config.llm.apiKey ?? '';
    const isSubscription = ['claude-agent', 'codex'].includes(config.llm.provider);
    const auth = config.llm.auth ?? (isSubscription ? 'cli' : 'api_key');
    const isOAuth = auth === 'oauth';
    const tokenStore = isOAuth ? new FileTokenStore() : undefined;

    if (apiKey || isSubscription || isOAuth) {
      llm.register({
        name: 'default',
        provider: await createProvider({
          provider: config.llm.provider, apiKey, model: config.llm.model,
          apiBase: config.llm.apiBase, auth, tokenStore,
        }),
        model: config.llm.model,
        purpose: [],
        priority: 0,
      });
    }
  }

  // 3. Tools
  const tools = new ToolRegistry();
  tools.register(new ExecTool());
  tools.register(new ReadFileTool());
  tools.register(new WriteFileTool());
  tools.register(new AppendFileTool());
  tools.register(new EditFileTool());
  tools.register(new ListDirTool());
  tools.register(new MessageTool(bus));
  tools.register(new HeartbeatTool());
  // Web tools
  tools.register(new WebFetchTool());
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
    onSkillsChange: () => skills.clearCache(),
  });

  // 4. Memory
  const memory = new MemoryStore(config);
  if (db) {
    const memoryIndex = new MemoryIndex(db);
    memory.setIndex(memoryIndex);
    await memory.reindex();
    // Vector embeddings — reindex with embeddings in background (non-blocking)
    if (config.memory?.vectorSearch) {
      memory.reindexWithEmbeddings().catch(err => {
        // Non-fatal — FTS still works without embeddings
        console.warn(`Vector embedding indexing failed: ${err instanceof Error ? err.message : String(err)}`);
      });
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
  const context = new ContextBuilder({ skills, memory, config, learner });

  // 7. Cron service (requires database)
  const cronService = db ? new CronService(db, bus) : null;
  if (cronService) {
    tools.register(new CronTool(cronService));
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
  const agentDeps = { bus, llm, tools, sessions, context, skills, config, learner, memory };
  tools.register(new SpawnAgentTool(agentDeps, subagentRegistry));
  const agent = new AgentLoop(agentDeps);

  // Self-update tool (needs agent for pre-restart flush)
  tools.register(new SelfUpdateTool({
    workspaceDir: config.workspace.dir,
    onBeforeRestart: () => agent.flushAllSessions(),
  }));

  return { config, db, bus, llm, tools, sessions, context, skills, learner, agent, cronService, subagentRegistry, mcpClients };
}
