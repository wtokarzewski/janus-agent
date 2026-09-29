import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js';
import { OpenAICompatibleProvider } from '../../src/llm/openai-compatible-provider.js';
import { CodexProvider } from '../../src/llm/codex-provider.js';
import { ClaudeAgentProvider } from '../../src/llm/claude-agent-provider.js';

const sdk = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn(), run: vi.fn(), query: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: sdk.create, stream: sdk.stream }; } }));
vi.mock('openai', () => ({ default: class { chat = { completions: { create: sdk.create } }; } }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class { startThread() { return { run: sdk.run }; } } }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }));

describe('Provider SDK cancellation boundaries', () => {
  it.each(['anthropic', 'openai'])('passes signal to %s chat and streaming SDK requests', async name => {
    const ctrl = new AbortController();
    const provider = name === 'anthropic'
      ? new AnthropicProvider({ apiKey: 'synthetic', defaultModel: 'test' })
      : new OpenAICompatibleProvider({ apiKey: 'synthetic', defaultModel: 'test', name: 'openai', apiBase: 'https://synthetic.invalid' });
    sdk.create.mockRejectedValue(new Error('synthetic stop'));
    sdk.stream.mockImplementation(() => { throw new Error('synthetic stop'); });
    const request = { model: 'test', messages: [], signal: ctrl.signal };
    await expect(provider.chat(request)).rejects.toThrow('synthetic stop');
    expect(sdk.create.mock.calls.at(-1)![1]).toEqual({ signal: ctrl.signal });
    await expect(provider.chatStream(request, () => {})).rejects.toThrow('synthetic stop');
    expect((name === 'anthropic' ? sdk.stream : sdk.create).mock.calls.at(-1)![1]).toEqual({ signal: ctrl.signal });
  });

  it('passes the request signal into the Codex turn', async () => {
    sdk.run.mockResolvedValue({ finalResponse: 'ok' });
    const ctrl = new AbortController();
    await new CodexProvider({ model: 'test' }).chat({ model: 'test', messages: [], signal: ctrl.signal });
    expect(sdk.run.mock.calls.at(-1)![1]).toEqual({ signal: ctrl.signal });
  });

  it('aborts the Claude query controller and rejects its late result', async () => {
    const ctrl = new AbortController();
    sdk.query.mockImplementation(({ options }) => (async function* () {
      ctrl.abort();
      expect(options.abortController.signal.aborted).toBe(true);
      yield { type: 'result', subtype: 'success', result: 'late' };
    })());
    await expect(new ClaudeAgentProvider({ model: 'test' }).chat({ model: 'test', messages: [], signal: ctrl.signal })).rejects.toThrow();
  });
});
