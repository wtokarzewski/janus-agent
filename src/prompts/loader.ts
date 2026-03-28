/**
 * Prompt loader — reads .md files from src/prompts/ and interpolates {{variables}}.
 * Files are cached in memory after first read.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROMPTS_DIR = resolve(import.meta.dirname ?? '.', '.');
const cache = new Map<string, string>();

/**
 * Load a prompt by name (e.g. 'cron/param-target-user-id').
 * Resolves to src/prompts/{name}.md, caches result, replaces {{var}} placeholders.
 */
export function loadPrompt(name: string, vars?: Record<string, string>): string {
  let text = cache.get(name);
  if (!text) {
    text = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), 'utf-8').trim();
    cache.set(name, text);
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{{${k}}}`, v);
    }
  }
  return text;
}
