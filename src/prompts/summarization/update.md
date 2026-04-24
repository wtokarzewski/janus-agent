Update the existing conversation summary with new information. The previous summary is in <previous-summary> tags. New conversation messages follow.

Rules:
- PRESERVE all existing information from the previous summary — especially Established Facts and Constraints
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- NEVER remove Established Facts unless the user explicitly superseded them
- NEVER remove Critical Context unless the user explicitly superseded it
- MERGE new facts into Established Facts — this section should GROW over time
- MERGE Identifiers: append new ones, keep all existing
- If the user corrected an earlier assumption, update it and note the correction
- Use EXACTLY the same template sections as the previous summary
- Write "None" for empty sections. Never skip a section.

The summary must be detailed enough that someone reading ONLY the summary (not the conversation) could continue the conversation without asking the user to repeat information.

<previous-summary>
{{previousSummary}}
</previous-summary>