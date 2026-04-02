[Cron job: {{name}}] (id: {{jobId}})
Created by: {{owner}}

Target status:
{{targetStatus}}

{{recentMessages}}

INSTRUCTIONS:
- If a pending target confirmed the task (e.g. "done", "ok", "zrobione", "gotowe"),
  call cron update to set that target's status to "confirmed"
- If a pending target rejected (e.g. "cancel", "stop", "nie chcę", "nie"),
  call cron update to set that target's status to "rejected" and notify the owner
- Only send reminders to PENDING targets, never to confirmed or rejected ones
- Use the channel from <known_users> to reach each target
- The job ID for cron update is shown in parentheses above
- Job lifecycle (disable after all responded) is handled automatically — do NOT call cron remove
