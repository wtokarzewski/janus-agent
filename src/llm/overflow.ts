/**
 * Multi-provider context overflow detection.
 * Returns true if the error indicates the request exceeds the model's context window.
 */

const OVERFLOW_PATTERNS = [
  // Anthropic
  /request_too_large/i,
  /prompt is too long/i,
  // OpenAI / OpenRouter
  /maximum context length/i,
  /request too large/i,
  /context_length_exceeded/i,
  // Google / Gemini
  /exceeds the maximum/i,
  // Generic
  /token limit/i,
  /input too long/i,
];

export function isContextOverflow(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!message) return false;
  return OVERFLOW_PATTERNS.some(p => p.test(message));
}
