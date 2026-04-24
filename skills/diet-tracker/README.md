# Diet Tracker Skill

Diet tracking skill for Janus — meal logging, calorie/macro tracking, weigh-ins, body composition, daily and weekly summaries.

## Features

- **Meal logging** — natural language ("I ate 4 eggs and bacon"), auto-estimates calories/macros
- **Photo estimation** — send a food photo, get calorie estimates
- **Day types** — Normal IF, OMAD, bone broth fasting, egg fast, refeed, or any user-defined type
- **Weight & body composition** — daily weigh-ins, BF% tracking, weekly trends
- **Fixed units** — learn user-specific portions ("porcja rosołu = 250 kcal") for quick logging
- **Safety guardrails** — max restrictive days per week, no back-to-back, health warnings
- **Automated heartbeats** — morning weigh-in, midday check-in, evening close, weekly summary
- **Corrections** — update logged data anytime, recalculates from scratch
- **Late additions** — add food after day close, totals update automatically
- **Diet-agnostic** — keto, low carb, standard, carnivore, Mediterranean, IIFYM — any approach

## File Structure

```
skills/diet-tracker/
  SKILL.md          # Main skill — rules, formats, commands
  install.md        # Setup flow — conversational onboarding
  uninstall.md      # Cleanup — remove heartbeats, keep data
  README.md         # This file
  formats/
    day-close.md    # End-of-day report format (macros + micros + supplements)
    weekly.md       # Weekly summary format (table + trends + countdown)
    photo.md        # Photo calorie estimation flow
```

## User Data

Per-user data stored in `.janus/users/{userId}/files/food-diary/`:

```
food-diary/
  profile.md        # Diet profile: targets, day types, preferences, milestones
  2026-04-20.md     # Daily food diary (one file per day)
  2026-04-21.md
  ...
```

## Reports

Three report types, each with a defined format:

| Report | When | Content |
|--------|------|---------|
| **DAY STATUS** | After every meal log | Calories/macros vs targets, progress bars, supplements |
| **Day Close** | Evening or "close day" | Full meal list, macros, micros, supplements, trend |
| **Weekly Summary** | Monday or on demand | 7-day table, weight trend, day type distribution, goal countdown |

## Install / Uninstall

- **Install**: User says "install diet" → conversational setup (goal, data, approach, day types, heartbeats)
- **Reinstall**: Existing data detected → only asks about missing fields, updates profile
- **Uninstall**: Removes heartbeats, keeps food diary data

## Day Types

Users can define multiple calorie/macro targets for different eating patterns:

| Type | Example use |
|------|-------------|
| Normal | Standard daily targets, optional IF window |
| OMAD | One meal a day, lower calorie target |
| Fasting | Bone broth / liquid day, very low calorie |
| Egg fast | Eggs + fat, keto plateau breaker |
| Refeed | Planned higher calorie day |

Not all users need day types — skill works fine with just "Normal".

## Key Rules

- Overestimate calories rather than underestimate
- Don't moralize about food choices — just show numbers
- One event = one report (never send DAY STATUS + Day Close together)
- Calculate before reporting (no stale numbers)
- Diet day = first meal to sleep (not midnight boundary)
- Adapt explanation depth to experience level
