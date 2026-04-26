---
name: diet-tracker
description: "Diet tracking — logging meals, calories/macros, weigh-ins, daily summaries, weekly reports. Use when user mentions food, weight, calories, macros, diet, or asks about their food diary."
version: "2.0.0"
always: false
---

# Diet Tracker

Meal logging, calorie/macro tracking, weigh-ins, daily and weekly summaries.

Communicate with the user in their preferred language (from PROFILE.md). All report labels, comments, and messages adapt to the user's language. The templates below show structure — translate labels when sending.

## Storage

```
.janus/users/{userId}/files/food-diary/
  profile.md        # Diet profile: targets, supplements, fixed units, milestones
  YYYY-MM-DD.md     # Daily food diary (one file per day)
```

## Install / Uninstall

- **New user** or command "install diet" → read [install.md](install.md)
- **Command "uninstall diet"** → read [uninstall.md](uninstall.md)

## Rules

- Always read `profile.md` before calculating — each user has different targets and day types
- When estimating calories: overestimate rather than underestimate
- Don't moralize — if the user ate too much, just show the numbers
- Diet day = first meal to sleep (not midnight to midnight)
- Physical activity: log as a separate section, estimate calories burned
- Weight: track weekly trend, don't react to daily fluctuations (creatine, water, salt)
- Adapt explanation depth to user's experience level (noted in profile) — don't lecture a keto veteran about ketosis
- The skill supports ANY diet approach — keto, low carb, standard, carnivore, Mediterranean, whatever the user chooses. Don't push a specific diet.
- **Never delete food diary files.** To fix dates or correct data, use `edit_file` or `write_file` to update the existing file. Never use `exec` with `rm`, `del`, or any delete command on food diary files.
- **One event = one report.** Never send both DAY STATUS and Day Close for the same food log. Pick the right format for the moment.
- **Calculate BEFORE reporting.** Always add the new item to totals first, then generate the report. Never send a report with stale numbers.
- **Stick to the defined formats.** Use progress bars (▓░), not tables or custom layouts. Consistency matters — the user should recognize the format instantly.

## Channel Preference

This skill supports dedicated channel routing via `skill-channels.json`.

### Checking preference
Before any output, check `<skill_channels>` in the system prompt:
- If `diet-tracker` has a preferred channel → use it for ALL output
- If no preference → trigger first-use setup (see below)

### First use (no preference)
1. Check if this is a fresh install or existing user without preference
2. Default suggestion = current chat (the one user is writing from)
3. Show other available chats from `<your_chats>` if present
4. Ask: "Where should diet updates go? Default: **this chat** ([name])"
5. Save to `skill-channels.json` via `write_file`:
   ```json
   {
     "diet-tracker": {
       "channel": "[channel]",
       "chatId": "[chatId]",
       "chatName": "[name]",
       "setAt": "[ISO timestamp]"
     }
   }
   ```
   Path: `.janus/users/{userId}/skill-channels.json`
   If file exists, read first and merge (don't overwrite other skills' preferences).

### Routing rules
- **Preferred channel = current chat:** respond normally
- **Preferred channel ≠ current chat:** brief redirect on current chat ("→ [channel name]"), then send full response via `message` tool to preferred channel
- **No preference set + first interaction:** ask user (first-use flow above)

### Changing channel
User says "change diet channel to X" or "move diet to [chat name]":
1. Update `skill-channels.json`
2. Update ALL diet heartbeat entries in user's `HEARTBEAT.md` — change `chat:` field
3. Confirm: "Diet → [new channel]. Heartbeats updated."

### Heartbeat alignment
When creating or updating heartbeats (install, channel change), always set `- chat: {preferredChatId}` using the value from `skill-channels.json`. Never leave heartbeat chat field empty for this skill.

## Day Types

Users can define multiple day types, each with its own calorie/macro targets. Common examples:

- **Normal** — standard daily targets (may include IF eating window)
- **OMAD** (one meal a day) — lower calorie target, single meal
- **Fasting day** (bone broth, rosół) — very low calorie, liquid-based
- **Egg fast** — eggs + fat only, keto staple for plateaus
- **Refeed / cheat** — planned higher calorie day

Day types are user-defined during install. Not everyone uses them — some users just have a single "normal" type. Don't suggest fasting patterns unless the user brings them up.

### Day type declaration

- If user has multiple day types defined, ask in the morning check-in: "what type of day today?"
- User can declare anytime: "today is OMAD", "rosół day", etc.
- If no declaration, assume "normal"
- Day type determines which calorie/macro targets to use for DAY STATUS

### Safety rules for restrictive days

Any day type with targets below 70% of normal calories counts as "restrictive":

- Max 2 restrictive days per week
- Never back-to-back restrictive days
- If user declares a 3rd restrictive day or back-to-back → warn, suggest normal day, but don't block (user decides)
- If user reports feeling unwell (dizziness, weakness, brain fog) → recommend normal day immediately
- Track restrictive day count in the weekly summary

## Logging a Meal

After every "I ate X" — mandatory sequence:

1. Read `profile.md` (targets, fixed units, day types)
2. Read/create today's file `food-diary/YYYY-MM-DD.md`
3. Check today's day type (declared in file header, or ask if not set)
4. Add meal to the appropriate section (breakfast/lunch/dinner/snack)
5. Recalculate totals using **this day type's targets**
6. Choose ONE report to send:
   - If it's near day-close time (evening heartbeat) → send **Day Close** only (read formats/day-close.md)
   - Otherwise → send **DAY STATUS** only (format below)
   - **NEVER send both reports for the same event** — one event = one report

### Daily file format

```markdown
# YYYY-MM-DD (weekday) — Day N [Day Type]

## Weight
- Morning: **XX.X kg**

## Meals

### Breakfast (~HH:MM)
| Product | kcal | Protein | Fat | Carbs | Fiber |
|---------|------|---------|-----|-------|-------|
| ... | ... | ... | ... | ... | ... |
| **Total** | **X** | **Xg** | **Xg** | **Xg** | **Xg** |
```

`[Day Type]` = the declared type for today (e.g. `[Normal IF]`, `[OMAD]`, `[Rosół]`, `[Egg Fast]`). Omit if user has only one day type.

### DAY STATUS report format (required)

```
📊 DAY STATUS N — DD.MM.YYYY (HH:MM) [Day Type]

🔥 Calories: X / TARGET (remaining: X)

MACROS:
🥩 Protein: Xg / TARGETg  (remaining: Xg) ▓▓░░░░░░░░ XX%
🧈 Fat:     Xg / TARGETg  (remaining: Xg) ▓▓▓▓░░░░░░ XX%
🍞 Carbs:   Xg / TARGETg  (remaining: Xg) ░░░░░░░░░░  X%
🌾 Fiber:   Xg / TARGETg  (remaining: Xg) ▓░░░░░░░░░  X%

SUPPLEMENTS:
💊 Creatine: ✅/❌
💊 Vitamins: ✅/❌
[other supplements from profile]
```

`[Day Type]` shows which day type's targets are used. TARGET values come from the matching day type in profile.md. If user has IF window and it's outside the window, note it.

Progress bar: 10 characters, ▓ = filled, ░ = empty. Round to whole blocks.

## Corrections

When user corrects previously logged data ("actually it was 51 min not 31", "that was 3 eggs not 4"):

1. Read today's file
2. Find and update the incorrect entry
3. Recalculate all totals from scratch (don't just adjust the delta — recalculate everything)
4. Send updated DAY STATUS with corrected numbers
5. Don't apologize excessively — just fix and show the updated report

## Body Composition

If the user tracks body fat %, measurements, or other body composition data:

1. Add to the Weight section in the daily file:
   ```
   ## Weight
   - Morning: **XX.X kg**
   - Body fat: **XX.X%** (method: scale/caliper/visual)
   ```
2. Include BF% in reports when available
3. Track BF% trend in weekly summaries alongside weight
4. Store measurement method in profile.md (smart scale, calipers, visual estimate) — different methods have different accuracy, don't compare across methods

Body composition fields are optional — only track what the user actually provides.

## Logging Weight

1. Open/create today's file
2. Write weight in `## Weight` section (and BF% if provided)
3. Compare with weekly milestone from profile.md
4. Comment on trend (if you have data from previous days)

### Missed weight

- If morning weigh-in gets no response → remind once in the midday food check-in: "btw, weight today?"
- If user reports weight later in the day ("forgot, I was 80.3 this morning") → log it, note the time wasn't ideal but it's better than nothing
- If no weight for the whole day → leave `## Weight` section empty, mark as `—` in weekly summary
- Don't nag more than once — one reminder in the check-in is enough. If they skip, they skip.

## Day Close

When user says "close day" or evening heartbeat fires → read [formats/day-close.md](formats/day-close.md)

### Reopening a closed day

If user reports food AFTER day close ("I had a snack before bed", "forgot to log the wine"):

1. Add the item to today's file (new section `### Late snack (~HH:MM)` after the close marker)
2. Recalculate all totals from scratch
3. Update the `## DAY CLOSED` summary at the bottom of the file with corrected numbers
4. Send a short confirmation with updated totals — not a full Day Close report again, just the delta:
   ```
   ➕ Added: [item] (+X kcal)
   📊 Updated day total: X kcal (was: X kcal)
   ```
5. This is normal — diet day = first meal to sleep, not to close report

## Weekly Summary

Monday heartbeat or command "weekly summary" → read [formats/weekly.md](formats/weekly.md)

## Photo Estimation

User sends a food photo → read [formats/photo.md](formats/photo.md)

## Common Commands

- "I ate X" → log meal + DAY STATUS report
- "weight XX.X" → log weight
- "what's my status?" / "how much left?" → DAY STATUS report
- "today is OMAD" / "rosół day" / "egg fast" → set day type, adjust targets
- "close day" → summary + close
- "how much to goal?" → countdown (kg + days)
- "install diet" → setup profile + heartbeats
- "uninstall diet" → cleanup heartbeats
- [food photo] → recognize and log
