# Diet Tracker Uninstallation

## When to trigger

User says "uninstall diet", "stop tracking diet", "remove diet tracker".

## Step 1: Remove heartbeats

Remove from the user's HEARTBEAT.md (`.janus/users/{userId}/HEARTBEAT.md`):
- `## Morning weigh-in`
- `## Food check-in`
- `## Evening diet close`
- `## Weekly diet summary`

Leave other heartbeats untouched.

## Step 2: Remove cron jobs

Check user's cron jobs and delete any related to diet (food check-in, evening diet, weekly diet, morning weigh-in).

## Step 3: Data — DON'T delete

Files in `food-diary/` (profile.md, daily diaries) stay. This is user data — don't delete without explicit request.

If user explicitly says "delete data too" / "clean everything":
- Move `food-diary/` to `food-diary-archive-YYYY-MM-DD/`
- Or delete if user confirms twice

## Step 4: Confirm

```
✅ Diet tracker uninstalled!

🗑️ Removed heartbeats: weight 7:15, check-in 13:00, close 21:00, weekly Mon 8:30
📁 food-diary/ data kept (manual deletion available on request)

To reinstall: "install diet"
```

## Channel preference cleanup

Remove the `diet-tracker` entry from `.janus/users/{userId}/skill-channels.json`:
1. Read the file
2. Delete the `diet-tracker` key
3. Write back (preserve other skills' entries)
4. If no entries remain, delete the file
