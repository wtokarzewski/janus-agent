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

  it('configures API key provider (OpenRouter)', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '1',           // API Key mode
      '1',           // OpenRouter
      'sk-test-key', // API key
      '',            // Default model
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
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'openai',
        apiKey: 'sk-oai',
        model: 'gpt-4o',
      },
    });
    // question called 5 times (invalid + mode + provider + key + model)
    expect(io.question).toHaveBeenCalledTimes(5);
  });

  it('retries on empty API key', async () => {
    const { saveConfig } = await import('../../src/config/config.js');
    const io = createMockIO([
      '1',         // API Key mode
      '1',         // OpenRouter
      '',          // Empty key — retried
      'sk-valid',  // Valid key
      '',          // Default model
    ]);

    await runSetup(undefined, io);

    expect(saveConfig).toHaveBeenCalledWith({
      llm: {
        provider: 'openrouter',
        apiKey: 'sk-valid',
        model: 'anthropic/claude-sonnet-4-5-20250929',
      },
    });
    expect(io.question).toHaveBeenCalledTimes(5);
  });

  it('accepts reconfigure option', async () => {
    const io = createMockIO([
      '1',         // API Key mode
      '1',         // OpenRouter
      'sk-reconf', // API key
      '',          // Default model
    ]);

    // Should not throw
    await runSetup({ reconfigure: true }, io);
  });
});
