import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { Tool } from '../../src/tools/types.js';

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: {} },
    async execute() { return 'ok'; },
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
});
