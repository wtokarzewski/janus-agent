/**
 * Shared bootstrap — creates all dependencies, wires them together.
 * Used by both CLI (index.ts) and gateway (gateway.ts).
 */

import { resolve } from 'node:path';
import type { JanusConfig } from './config/schema.js';
import { MessageBus } from './bus/message-bus.js';
import { createProvider } from './llm/openai-compatible-provider.js';
import { ProviderRegistry } from './llm/provider-registry.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { ExecTool } from './tools/builtin/exec.js';
import { ReadFileTool } from './tools/builtin/read-file.js';
import { WriteFileTool } from './tools/builtin/write-file.js';
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
import { CronService } from './services/cron-service.js';
import { CronTool } from './tools/builtin/cron.js';

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
    if (apiKey || isSubscription) {
      llm.register({
        name: 'default',
        provider: await createProvider({ provider: config.llm.provider, apiKey, model: config.llm.model, apiBase: config.llm.apiBase }),
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
  tools.register(new EditFileTool());
  tools.register(new ListDirTool());
  tools.register(new MessageTool(bus));
  tools.setContext({
    workspaceDir: config.workspace.dir,
    execDenyPatterns: config.tools.execDenyPatterns,
    execTimeout: config.tools.execTimeout,
    maxFileSize: config.tools.maxFileSize,
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

  // 8. Agent loop (with spawn_agent tool)
  const agentDeps = { bus, llm, tools, sessions, context, skills, config, learner, memory };
  tools.register(new SpawnAgentTool(agentDeps));
  const agent = new AgentLoop(agentDeps);

  return { config, db, bus, llm, tools, sessions, context, skills, learner, agent, cronService };
}
