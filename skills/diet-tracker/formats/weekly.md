# Weekly Summary

## When

- Monday heartbeat (8:30)
- User says "weekly summary", "how was the week"

## Procedure

1. Read `food-diary/` files from the last 7 days
2. Read `profile.md` (targets, milestones)
3. Calculate: average weight, average calories, weight trend
4. Compare plan vs reality (planned kcal vs actually eaten)
5. Compare with weekly milestone (weight)
6. Show countdown to goal

## Report format

```
📊 Diet Week — DD-DD.MM.YYYY

| Day | Type | Weight | Calories | Protein | Fat | Carbs | Fiber |
|-----|------|--------|----------|---------|-----|-------|-------|
| Mon DD.MM | Normal | XX.X kg | XXXX kcal ✅/⚠️ | XXXg ✅/⚠️ | XXXg ✅/⚠️ | XXg ✅/⚠️ | XXg ✅/⚠️ |
| Tue DD.MM | OMAD | XX.X kg | XXXX kcal ✅/⚠️ | XXXg ✅/⚠️ | XXXg ✅/⚠️ | XXg ✅/⚠️ | XXg ✅/⚠️ |
| ... | | | | | | | |

Legend: ✅ = on target (for that day type), ⚠️ = exceeded, 🔄 = day in progress

Omit Type column if user has only one day type.

### ⚖️ Weight:
- Week start: X kg (BF: XX.X%)
- Week end: X kg (BF: XX.X%)
- Change: ±X kg (BF: ±X.X%)
- Weekly target: X kg ✅/⚠️

BF% lines only if user tracks body composition. Omit otherwise.

### 🔥 Calories:
- Plan: X kcal × 7 = X kcal
- Eaten: X kcal total
- Difference: ±X kcal (deficit/surplus)

### 📊 Macros (daily average):
- 🥩 Protein: Xg (target: Xg)
- 🧈 Fat: Xg (target: Xg)
- 🍞 Carbs: Xg (target: Xg)
- 🌾 Fiber: Xg (target: Xg)

### 🎯 Countdown to goal:
- Goal: X kg by [date]
- Remaining: X kg in X days
- Required pace: X kg/week
- Current pace: X kg/week ✅/⚠️

### 📋 Day type distribution:
- Normal: X days
- OMAD: X days
- Fasting: X days
- Restrictive days: X/2 max

### 📝 Week assessment:
[comment + recommendations — what went well, what to improve]
```

Omit day type distribution if user has only one day type.

Translate all labels to the user's preferred language when sending.
