import { MessageBus } from '../../src/bus/message-bus.js';
import { ProviderRegistry } from '../../src/llm/provider-registry.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { SessionManager } from '../../src/session/session-manager.js';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { SkillLoader } from '../../src/skills/skill-loader.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { AgentResolver } from '../../src/agent/agent-resolver.js';
import type { AgentDeps } from '../../src/agent/agent-loop.js';
import type { LLMProvider } from '../../src/llm/types.js';
import { createTestConfig } from './test-fixtures.js';

export function agentFixture(provider: LLMProvider, overrides?: Partial<Record<string, unknown>>): AgentDeps {
  const config = createTestConfig(overrides);
  const llm = new ProviderRegistry();
  llm.register({ name: 'mock', providerName: 'mock', provider, model: 'test-model', purpose: [], priority: 0 });
  const memory = new MemoryStore(config);
  const skills = new SkillLoader(config);
  return { config, llm, memory, skills, bus: new MessageBus(), tools: new ToolRegistry(),
    sessions: new SessionManager(config), context: new ContextBuilder({ config, memory, skills }),
    agentResolver: new AgentResolver(config) };
}
