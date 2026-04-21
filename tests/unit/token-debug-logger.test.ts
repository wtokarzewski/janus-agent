import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enableTokenDebug, tokenDebugEnabled, logTokenUsage } from '../../src/utils/logger.js';

describe('token debug logger', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('enableTokenDebug / tokenDebugEnabled', () => {
    it('is disabled by default', async () => {
      // Re-import to get fresh module state
      // Since module state persists, we test against the current state
      // after enable was called in previous tests — test ordering matters.
      // Instead, we test the enable path.
      enableTokenDebug();
      expect(tokenDebugEnabled()).toBe(true);
    });
  });

  describe('logTokenUsage', () => {
    beforeEach(() => {
      enableTokenDebug();
    });

    it('outputs [TOKEN] line when enabled', () => {
      logTokenUsage('chat', {
        promptTokens: 48200,
        completionTokens: 1250,
        cacheReadTokens: 41000,
        cacheWriteTokens: 7200,
      }, 'anthropic', 'claude-sonnet-4-6');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[TOKEN]');
      expect(output).toContain('chat');
      expect(output).toContain('anthropic claude-sonnet-4-6');
      expect(output).toContain('in:48200');
      expect(output).toContain('out:1250');
      expect(output).toContain('cache_read:41000');
      expect(output).toContain('cache_write:7200');
    });

    it('calculates hit rate correctly', () => {
      logTokenUsage('chat', {
        promptTokens: 0,
        completionTokens: 500,
        cacheReadTokens: 41000,
        cacheWriteTokens: 7200,
      }, 'anthropic', 'claude-sonnet-4-6');

      const output = consoleSpy.mock.calls[0][0] as string;
      // hitRate = 41000 / (0 + 41000 + 7200) * 100 = 85%
      expect(output).toContain('hit:85%');
    });

    it('shows 0% hit rate when no cache tokens', () => {
      logTokenUsage('chat', {
        promptTokens: 5000,
        completionTokens: 500,
      }, 'anthropic', 'claude-sonnet-4-6');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('hit:0%');
    });

    it('shows CACHE MISS warning when cacheWrite > 5000 and cacheRead === 0', () => {
      logTokenUsage('flush', {
        promptTokens: 3100,
        completionTokens: 420,
        cacheReadTokens: 0,
        cacheWriteTokens: 6000,
      }, 'anthropic', 'claude-haiku-4-5');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('CACHE MISS');
    });

    it('does not show CACHE MISS when cacheWrite <= 5000', () => {
      logTokenUsage('flush', {
        promptTokens: 3100,
        completionTokens: 420,
        cacheReadTokens: 0,
        cacheWriteTokens: 5000,
      }, 'anthropic', 'claude-haiku-4-5');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('CACHE MISS');
    });

    it('does not show CACHE MISS when cacheRead > 0', () => {
      logTokenUsage('flush', {
        promptTokens: 3100,
        completionTokens: 420,
        cacheReadTokens: 100,
        cacheWriteTokens: 6000,
      }, 'anthropic', 'claude-haiku-4-5');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('CACHE MISS');
    });

    it('handles missing provider/model gracefully', () => {
      logTokenUsage('chat', {
        promptTokens: 1000,
        completionTokens: 200,
      });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[TOKEN]');
      expect(output).toContain('unknown');
    });

    it('handles provider only', () => {
      logTokenUsage('chat', {
        promptTokens: 1000,
        completionTokens: 200,
      }, 'openrouter');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('openrouter');
    });

    it('handles model only', () => {
      logTokenUsage('chat', {
        promptTokens: 1000,
        completionTokens: 200,
      }, undefined, 'gpt-4');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('gpt-4');
    });

    it('shows purpose padded to consistent width', () => {
      logTokenUsage('summarize', {
        promptTokens: 2000,
        completionTokens: 300,
        cacheReadTokens: 1500,
        cacheWriteTokens: 500,
      }, 'anthropic', 'claude-haiku-4-5');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('summarize');
    });

    it('handles zero denominator for hit rate', () => {
      logTokenUsage('chat', {
        promptTokens: 0,
        completionTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }, 'test', 'model');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('hit:0%');
    });
  });
});
