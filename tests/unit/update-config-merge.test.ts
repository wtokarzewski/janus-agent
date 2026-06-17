import { describe, it, expect } from 'vitest';
import { mergeMissingTopLevelSections } from '../../src/commands/update.js';

describe('mergeMissingTopLevelSections', () => {
  it('adds a missing top-level section using the example value', () => {
    const config = { llm: { x: 1 } };
    const example = { llm: { x: 9 }, logging: { file: { enabled: false } } };
    const { merged, added } = mergeMissingTopLevelSections(config, example);
    expect(merged.logging).toEqual({ file: { enabled: false } });
    expect(added).toEqual(['logging']);
  });

  it('never overwrites an existing section, even if the example value differs', () => {
    const config = { telegram: { token: 'REAL_SECRET', allowlist: ['123'] } };
    const example = { telegram: { token: 'PLACEHOLDER', allowlist: [] } };
    const { merged, added } = mergeMissingTopLevelSections(config, example);
    expect(merged.telegram).toEqual({ token: 'REAL_SECRET', allowlist: ['123'] });
    expect(added).toEqual([]);
  });

  it('adds nothing when config already has every section', () => {
    const config = { a: 1, b: 2 };
    const example = { a: 9, b: 9 };
    const { merged, added } = mergeMissingTopLevelSections(config, example);
    expect(added).toEqual([]);
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it('adds multiple missing sections while preserving existing ones', () => {
    const config = { a: 1 };
    const example = { a: 9, b: { x: 1 }, c: [1, 2] };
    const { merged, added } = mergeMissingTopLevelSections(config, example);
    expect(merged).toEqual({ a: 1, b: { x: 1 }, c: [1, 2] });
    expect([...added].sort()).toEqual(['b', 'c']);
  });

  it('orders merged keys to match the example, with config-only keys appended last', () => {
    const config = { streaming: { enabled: true }, llm: { x: 1 }, customUserKey: 1 };
    const example = { llm: { x: 9 }, streaming: { enabled: false }, logging: { file: {} } };
    const { merged } = mergeMissingTopLevelSections(config, example);
    expect(Object.keys(merged)).toEqual(['llm', 'streaming', 'logging', 'customUserKey']);
  });

  it('deep-clones the example value so the example object is not aliased', () => {
    const example = { logging: { file: { enabled: false } } };
    const config: Record<string, unknown> = {};
    const { merged } = mergeMissingTopLevelSections(config, example);
    (merged.logging as { file: { enabled: boolean } }).file.enabled = true;
    expect(example.logging.file.enabled).toBe(false);
  });
});
