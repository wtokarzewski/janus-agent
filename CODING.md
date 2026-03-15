# CODING.md

Coding conventions for this project. Follow these when writing or modifying code.

## Language & Tooling

- TypeScript, ESM (`"type": "module"`, `.js` extensions in imports)
- `strict: true` in tsconfig — no `any` unless unavoidable (comment why)
- Code and comments in English

## Naming

| What | Convention | Example |
|------|-----------|---------|
| Classes, interfaces, type aliases | PascalCase | `ExecTool`, `AgentDeps`, `LLMMessage` |
| Functions, methods, properties | camelCase | `execute()`, `workspaceDir`, `shouldGate()` |
| Constants (module-level) | SCREAMING_SNAKE_CASE | `DEFAULT_TIMEOUT_MS`, `MAX_CHUNK_CHARS` |
| Files | kebab-case matching primary export | `agent-loop.ts` → `AgentLoop` |
| Test files | `{module}.test.ts` in `tests/unit/` | `pattern-gate.test.ts` |

## Imports

1. Node builtins first (`node:path`, `node:fs/promises`)
2. External packages (`grammy`, `zod`, `better-sqlite3`)
3. Type-only imports (`import type { ... }`)
4. Local modules (relative, with `.js` extension)
5. Logger last (`import * as log from '...logger.js'`)

Always use `.js` extension. Always use `import type` for type-only imports (`verbatimModuleSyntax`).

```typescript
import { resolve } from 'node:path';
import { z } from 'zod';
import type { JanusConfig } from './config/schema.js';
import { MessageBus } from './bus/message-bus.js';
import * as log from './utils/logger.js';
```

## Types

- **Zod schemas** for runtime validation; infer types with `z.infer<typeof Schema>`
- **Interfaces** for dependency injection and public API contracts (`AgentDeps`, `Tool`)
- **Type aliases** for unions and simple shapes (`LLMMessage`, `LogLevel`)
- **Type guards** with `is` keyword for runtime narrowing (`isContextualTool()`)
- Export types alongside implementations, not in separate barrel files

## Functions & Classes

- **Classes** for stateful services and tools (`ExecTool`, `ToolRegistry`, `MessageBus`)
- **Plain functions** for stateless logic (`loadConfig()`, `splitMarkdownChunks()`)
- **Arrow functions** only for callbacks and inline closures
- **async/await** everywhere — no `.then()` chains
- Method chaining where natural (`.filter().map().sort()`)

## Error Handling

- No custom Error classes — use built-in `Error`
- Always check `err instanceof Error` before `.message` (errors are `unknown`)
- Tools return error strings, never throw: `return 'Error: ...'`
- Graceful fallbacks for optional components (return `null`, log warning)
- Validate early, return early

```typescript
try {
  const result = await doThing();
  return result;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(`Thing failed: ${msg}`);
  return `Error: ${msg}`;
}
```

## Logging

- Import as namespace: `import * as log from './utils/logger.js'`
- Four levels: `log.debug()`, `log.info()`, `log.warn()`, `log.error()`
- Template literals for messages: `` log.info(`Registered tool: ${name}`) ``
- No `console.log` in production code — use the logger

## Constants

- Magic numbers → named constants at module top (SCREAMING_SNAKE_CASE)
- Use numeric separators for readability: `30_000`, `2_097_152`
- Config-driven values read from `JanusConfig`, not hardcoded

```typescript
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 50_000;
```

## Module Structure

```
src/feature/
├── types.ts           # Interfaces, type aliases
├── feature.ts         # Primary implementation
└── sub-feature.ts     # Supporting code
```

- Feature modules are self-contained directories (max 2 levels deep)
- Types in dedicated `types.ts` when shared across files
- No barrel exports (`index.ts`) unless the module is a public API boundary (e.g. `auth/`)
- Direct file imports — avoids circular dependencies

## Dependency Injection

- Core services receive dependencies via constructor interface, not global imports
- Optional dependencies marked with `?` in the interface
- Registry pattern for extensible collections (tools, providers, skills)
- MessageBus decouples async communication between modules

```typescript
export interface AgentDeps {
  bus: MessageBus;
  llm: ProviderRegistry;
  tools: ToolRegistry;
  config: JanusConfig;
  memory?: MemoryStore;  // optional
}
```

## Testing

- **vitest** with `describe/it/expect`
- Tests in `tests/unit/`, not alongside source
- Descriptive names: `it('should gate rm commands', ...)`
- One logical assertion per test
- Shared setup via `const` in `describe` block (no `beforeEach` unless necessary)
- Integration tests with mock LLM in `tests/integration/`
- Run `npm test` before committing

## Tool Implementation

Every tool follows this contract:

```typescript
export class MyTool implements Tool {
  name = 'my_tool';
  description = '...';
  parameters = { /* JSON Schema */ };

  async execute(args: Record<string, unknown>): Promise<string> {
    // 1. Parse & validate args
    // 2. Execute logic
    // 3. Return result string (or error string, never throw)
  }
}
```

- Implement `ContextualTool` if the tool needs workspace/config context
- Register in `bootstrap.ts`
- Add test in `tests/unit/`

## Config

- New config fields → add to Zod schema in `config/schema.ts` with sensible default
- **Always** update `janus.example.json` with any new config field
- Merge priority: defaults → user config → workspace config → env vars → CLI overrides

## What Not To Do

- No `any` without a comment explaining why
- No `.then()` chains — use async/await
- No `console.log` — use the logger
- No magic numbers inline — extract to const
- No barrel re-exports except at module API boundaries
- No circular imports between modules
- No custom Error subclasses
- No unnecessary abstractions — three similar lines > premature helper
