/**
 * Detect configured models a provider no longer serves.
 *
 * Providers retire models on their own schedule; the first symptom is usually a
 * 404 in the middle of a conversation. Checking the configured IDs against the
 * live list at update time turns that into a warning while someone is watching
 * the terminal.
 */

export interface ModelDrift {
  provider: string;
  /** The configured model ID that is no longer listed. */
  model: string;
  /** Newest model the provider does list, as a starting point for the fix. */
  suggestion?: string;
}

export function findModelDrift(input: {
  provider: string;
  configured: string[];
  available: string[];
}): ModelDrift[] {
  // An empty list means the fetch failed or the provider has no listing
  // endpoint — that is "unknown", not "everything is gone".
  if (input.available.length === 0) return [];

  const served = new Set(input.available);
  const reported = new Set<string>();
  const drift: ModelDrift[] = [];

  for (const model of input.configured) {
    if (served.has(model) || reported.has(model)) continue;
    reported.add(model);
    drift.push({ provider: input.provider, model, suggestion: input.available[0] });
  }

  return drift;
}
