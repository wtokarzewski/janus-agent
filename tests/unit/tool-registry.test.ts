import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { Tool } from '../../src/tools/types.js';

function makeTool(name: string, opts?: { parameters?: Tool['parameters']; execute?: Tool['execute'] }): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: opts?.parameters ?? { type: 'object', properties: {} },
    async execute(args) { return opts?.execute ? opts.execute(args) : 'ok'; },
  };
}

describe('ToolRegistry', () => {
  it('list() returns tools sorted by name', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('zebra'));
    reg.register(makeTool('alpha'));
    reg.register(makeTool('middle'));

    const names = reg.list().map(t => t.function.name);
    expect(names).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('summaries() returns tools sorted by name', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('write_file'));
    reg.register(makeTool('exec'));
    reg.register(makeTool('read_file'));

    const names = reg.summaries().map(s => s.name);
    expect(names).toEqual(['exec', 'read_file', 'write_file']);
  });

  it('names() preserves insertion order', () => {
    const reg = new ToolRegistry();
    reg.register(makeTool('zebra'));
    reg.register(makeTool('alpha'));

    // names() is NOT sorted (used internally, not for LLM)
    expect(reg.names()).toEqual(['zebra', 'alpha']);
  });

  describe('coerceToolArgs', () => {
    it('coerces string to number when schema expects number', async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('test', {
        parameters: {
          type: 'object',
          properties: { count: { type: 'number' } },
        },
        execute: async (args) => JSON.stringify(args),
      }));

      const result = await reg.execute('test', { count: '5' });
      expect(JSON.parse(result)).toEqual({ count: 5 });
    });

    it('coerces string to integer', async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('test', {
        parameters: {
          type: 'object',
          properties: { page: { type: 'integer' } },
        },
        execute: async (args) => JSON.stringify(args),
      }));

      const result = await reg.execute('test', { page: '3' });
      expect(JSON.parse(result)).toEqual({ page: 3 });
    });

    it('coerces string to boolean', async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('test', {
        parameters: {
          type: 'object',
          properties: { verbose: { type: 'boolean' } },
        },
        execute: async (args) => JSON.stringify(args),
      }));

      const result = await reg.execute('test', { verbose: 'true' });
      expect(JSON.parse(result)).toEqual({ verbose: true });

      const result2 = await reg.execute('test', { verbose: 'false' });
      expect(JSON.parse(result2)).toEqual({ verbose: false });
    });

    it('does not coerce non-numeric strings to number', async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('test', {
        parameters: {
          type: 'object',
          properties: { count: { type: 'number' } },
        },
        execute: async (args) => JSON.stringify(args),
      }));

      const result = await reg.execute('test', { count: 'abc' });
      expect(JSON.parse(result)).toEqual({ count: 'abc' });
    });

    it('passes through args when no schema properties', async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('test'));

      const result = await reg.execute('test', { foo: '42' });
      expect(result).toBe('ok');
    });
  });
});
