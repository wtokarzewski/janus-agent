import type { ChatResponse } from '../llm/types.js';

export const SUMMARY_HEADINGS = [
  '## Goal', '## Constraints & Preferences', '## Established Facts',
  '## Progress', '### Done', '### In Progress', '## Key Decisions',
  '## Open TODOs', '## Critical Context', '## Identifiers',
];

/** Validate completion and structure, not semantic truth or a minimum length. */
export function validatedSummary(response: ChatResponse): string | null {
  if (response.finishReason !== 'stop' || response.toolCalls.length) return null;
  const content = response.content.trim();
  if (!content) return null;
  const summary = content.startsWith('## Goal\n') ? content : `## Goal\n${content}`;
  const headings = [...summary.matchAll(/^#{2,3} .+$/gm)];
  if (headings.length !== SUMMARY_HEADINGS.length || headings.some((match, i) => match[0].trim() !== SUMMARY_HEADINGS[i])) return null;
  for (let i = 0; i < headings.length; i++) {
    if (SUMMARY_HEADINGS[i] === '## Progress') continue; // its two subsections carry the content
    const body = summary.slice(headings[i].index! + headings[i][0].length, headings[i + 1]?.index ?? summary.length).trim();
    if (!body) return null;
  }
  return summary;
}
