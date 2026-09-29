export function structuredSummary(facts = 'Limit: 17; do not publish without approval.'): string {
  return `## Goal
Continue the task.
## Constraints & Preferences
${facts}
## Established Facts
${facts}
## Progress
### Done
None
### In Progress
Review pending.
## Key Decisions
None
## Open TODOs
Ask before publishing.
## Critical Context
${facts}
## Identifiers
None`;
}
