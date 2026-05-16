// Explicit marker separating the stable (cacheable) system-prompt prefix from
// the dynamic suffix. The Anthropic provider applies `cache_control` at this
// boundary; other providers strip the marker and treat the prompt as plain text.
// See docs/superpowers/specs/2026-05-16-context-management-redesign.md.

export const CACHE_BOUNDARY = '\n<!-- JANUS_CACHE_BOUNDARY -->\n';

export interface BoundarySplit {
  stablePrefix: string;
  dynamicSuffix: string;
}

export function splitAtBoundary(systemPrompt: string): BoundarySplit | null {
  const idx = systemPrompt.indexOf(CACHE_BOUNDARY);
  if (idx === -1) return null;
  return {
    stablePrefix: systemPrompt.slice(0, idx).trimEnd(),
    dynamicSuffix: systemPrompt.slice(idx + CACHE_BOUNDARY.length).trimStart(),
  };
}

export function stripBoundary(text: string): string {
  return text.replaceAll(CACHE_BOUNDARY, '\n');
}

/**
 * Assemble a system prompt with explicit cache boundary between cacheable
 * static parts and per-request dynamic parts. Used by context-builder.
 */
export function assembleWithBoundary(staticParts: string[], dynamicParts: string[]): string {
  const SEP = '\n\n---\n\n';
  const stable = staticParts.filter(p => p.length > 0).join(SEP);
  const dynamic = dynamicParts.filter(p => p.length > 0).join(SEP);
  if (!stable && !dynamic) return '';
  if (!dynamic) return stable;
  if (!stable) return dynamic;
  return stable + CACHE_BOUNDARY + dynamic;
}
