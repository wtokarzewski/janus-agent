Update the existing conversation summary with new information. The previous summary is in <previous-summary> tags. New conversation messages follow.

Rules:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- NEVER remove Critical Context unless the user explicitly superseded it
- MERGE Identifiers: append new ones, keep all existing
- Use EXACTLY the same template sections as the previous summary
- Write "None" for empty sections. Never skip a section.

<previous-summary>
{{previousSummary}}
</previous-summary>