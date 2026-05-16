import { describe, it, expect } from 'vitest';
import { CACHE_BOUNDARY, splitAtBoundary, stripBoundary, assembleWithBoundary } from '../../src/prompts/cache-boundary.js';

describe('cache-boundary', () => {
  describe('splitAtBoundary', () => {
    it('splits at boundary correctly', () => {
      const sp = `static stuff${CACHE_BOUNDARY}dynamic stuff`;
      const r = splitAtBoundary(sp);
      expect(r).not.toBeNull();
      expect(r!.stablePrefix).toBe('static stuff');
      expect(r!.dynamicSuffix).toBe('dynamic stuff');
    });

    it('returns null when no boundary present', () => {
      expect(splitAtBoundary('no marker here at all')).toBeNull();
    });

    it('trims whitespace at boundary edges', () => {
      const sp = `static\n\n${CACHE_BOUNDARY}\n\ndynamic`;
      const r = splitAtBoundary(sp)!;
      expect(r.stablePrefix).toBe('static');
      expect(r.dynamicSuffix).toBe('dynamic');
    });

    it('splits at FIRST boundary if multiple present', () => {
      const sp = `a${CACHE_BOUNDARY}b${CACHE_BOUNDARY}c`;
      const r = splitAtBoundary(sp)!;
      expect(r.stablePrefix).toBe('a');
      expect(r.dynamicSuffix).toContain('b');
    });
  });

  describe('stripBoundary', () => {
    it('replaces boundary with single newline', () => {
      expect(stripBoundary(`a${CACHE_BOUNDARY}b`)).toBe('a\nb');
    });

    it('handles multiple boundaries', () => {
      expect(stripBoundary(`a${CACHE_BOUNDARY}b${CACHE_BOUNDARY}c`)).toBe('a\nb\nc');
    });

    it('leaves text unchanged when no boundary', () => {
      expect(stripBoundary('plain text')).toBe('plain text');
    });
  });

  describe('assembleWithBoundary', () => {
    it('joins static + dynamic with boundary between them', () => {
      const out = assembleWithBoundary(['A', 'B'], ['C', 'D']);
      expect(out).toContain('A\n\n---\n\nB');
      expect(out).toContain('C\n\n---\n\nD');
      expect(out).toContain(CACHE_BOUNDARY);
    });

    it('omits boundary when only static parts', () => {
      const out = assembleWithBoundary(['A', 'B'], []);
      expect(out).not.toContain(CACHE_BOUNDARY);
      expect(out).toBe('A\n\n---\n\nB');
    });

    it('omits boundary when only dynamic parts', () => {
      const out = assembleWithBoundary([], ['C']);
      expect(out).not.toContain(CACHE_BOUNDARY);
      expect(out).toBe('C');
    });

    it('returns empty string when both empty', () => {
      expect(assembleWithBoundary([], [])).toBe('');
    });

    it('filters out empty strings from parts', () => {
      const out = assembleWithBoundary(['', 'A', ''], ['', 'C', '']);
      expect(out).toBe(`A${CACHE_BOUNDARY}C`);
    });
  });
});
