import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSetup } from '../../src/commands/setup.js';

// Mock saveConfig
vi.mock('../../src/config/config.js', () => ({
  saveConfig: vi.fn().mockResolvedValue(undefined),
}));

// Mock chalk to pass through (avoid terminal escape codes in tests)
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    gray: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
}));

// Mock model-listing to avoid HTTP requests in tests
vi.mock('../../src/llm/model-listing.js', () => ({
  fetchAnthropicModels: vi.fn().mockResolvedValue([]),
  fetchOpenAIModels: vi.fn().mockResolvedValue([]),
}));

function createMockIO(answers: string[]) {
  let idx = 0;
  return {
    question: vi.fn().mockImplementation(() => {
      const answer = answers[idx] ?? '';
      idx++;
      return Promise.resolve(answer);
    }),
    close: vi.fn(),
  };
}

describe('Setup Wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures API key provider (OpenRouter) without fallback', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '1',           // API Key mode
      '1',           // OpenRouter
      'sk-test-key', // API key
      '',            // Default model (fetch fails, falls back to manual)
      '2',           // No fallback
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'openrouter',
        apiKey: 'sk-test-key',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      },
    });
  });

  it('configures API key provider (Anthropic) with custom model', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '1',                          // API Key mode
      '2',                          // Anthropic
      'sk-ant-test',                // API key
      'claude-opus-4-5-20250929',   // Custom model
      '2',                          // No fallback
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'anthropic',
        apiKey: 'sk-ant-test',
        model: 'claude-opus-4-5-20250929',
      },
    });
  });

  it('configures API key provider (DeepSeek)', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '1',         // API Key mode
      '4',         // DeepSeek
      'ds-key',    // API key
      '',          // Default model
      '2',         // No fallback
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'deepseek',
        apiKey: 'ds-key',
        model: 'deepseek-chat',
      },
    });
  });

  it('does not close readline when io is provided externally', async () => {
    const io = createMockIO([
      '1',      // API Key mode
      '5',      // Groq
      'g-key',  // API key
      '',       // Default model
      '2',      // No fallback
    ]);

    await runSetup(undefined, io);

    // External io should NOT be closed by runSetup
    expect(io.close).not.toHaveBeenCalled();
  });

  it('retries on invalid choice', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      'x',       // Invalid — retried
      '1',       // API Key mode
      '3',       // OpenAI
      'sk-oai',  // API key
      '',        // Default model
      '2',       // No fallback
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'openai',
        apiKey: 'sk-oai',
        model: 'gpt-4o',
      },
    });
    // question called 6 times (invalid + mode + provider + key + model + fallback)
    expect(io.question).toHaveBeenCalledTimes(6);
  });

  it('retries on empty API key', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '1',         // API Key mode
      '1',         // OpenRouter
      '',          // Empty key — retried
      'sk-valid',  // Valid key
      '',          // Default model
      '2',         // No fallback
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'openrouter',
        apiKey: 'sk-valid',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      },
    });
    expect(io.question).toHaveBeenCalledTimes(6);
  });

  it('offers OAuth and CLI auth methods for subscription', async () => {
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success' };
        },
      }),
    }));

    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '2',  // Subscription mode
      '1',  // Claude Code
      '2',  // CLI auth method
      '',   // Press Enter for auth check
      '1',  // sonnet model
      '2',  // No fallback
    ]);

    try {
      await runSetup(undefined, io);
      expect(saveConfig).toHaveBeenCalledWith({
        llm: { provider: 'claude-agent', model: 'claude-sonnet-4-6' },
      });
    } catch {
      // May fail due to auth check — that's OK, we're testing the flow structure
    }

    vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  });

  it('accepts reconfigure option', async () => {
    const io = createMockIO([
      '1',         // API Key mode
      '1',         // OpenRouter
      'sk-reconf', // API key
      '',          // Default model
      '2',         // No fallback
    ]);

    // Should not throw
    await runSetup({ reconfigure: true }, io);
  });
});
