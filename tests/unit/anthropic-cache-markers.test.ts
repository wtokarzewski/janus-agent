import { describe, it, expect } from 'vitest';
import { applyCacheMarkers } from '../../src/llm/anthropic-provider.js';

describe('applyCacheMarkers', () => {
  it('marks only last tool when no MCP tools present', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks built-in/MCP boundary AND last tool when MCP tools present', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
      { name: 'read_file', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_search', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_github_pr', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
    expect((tools[3] as any).cache_control).toEqual({ type: 'ephemeral' });
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[2] as any).cache_control).toBeUndefined();
  });

  it('handles all-MCP tools list (no built-in)', () => {
    const tools = [
      { name: 'mcp_a_tool1', description: '', input_schema: { type: 'object' } },
      { name: 'mcp_b_tool2', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toBeUndefined();
    expect((tools[1] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles single tool', () => {
    const tools = [
      { name: 'exec', description: '', input_schema: { type: 'object' } },
    ];
    applyCacheMarkers(tools);
    expect((tools[0] as any).cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles empty tools list', () => {
    const tools: any[] = [];
    applyCacheMarkers(tools);
    expect(tools.length).toBe(0);
  });
});
