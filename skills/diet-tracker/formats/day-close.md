# Day Close

## When

- User says "close day"
- Evening heartbeat (21:00) — ask what else they ate, then close

## Procedure

1. Read today's file `food-diary/YYYY-MM-DD.md`
2. Read `profile.md` (targets, supplements)
3. Ask if they ate anything else (if heartbeat trigger)
4. Show **full list of everything eaten** (with weight and brand)
5. Summarize macros: calories, protein, fat, carbs, fiber vs targets
6. Summarize micros (from food + supplements)
7. Write `## DAY CLOSED ✅` to the daily file
8. Send report

## Report format

```
✅ DAY N CLOSED — DD.MM.YYYY [Day Type]

⚖️ Weight: XX.X kg (BF: XX.X% — if tracked)

### What I ate:
- Breakfast: [product list with grams]
- Lunch: [product list with grams]
- Dinner: [product list with grams]
- Snacks: [list]
- Activity: [workout description]

MACROS:
🔥 Calories: X / TARGET  →  deficit: X kcal
   (with exercise: ~X kcal deficit)
🥩 Protein: Xg / TARGETg  ▓▓▓▓▓▓░░░░ XX%
🧈 Fat:     Xg / TARGETg  ▓▓▓▓░░░░░░ XX%
🍞 Carbs:   Xg / TARGETg  ▓▓▓░░░░░░░ XX%
🌾 Fiber:   Xg / TARGETg  ▓▓░░░░░░░░ XX%

MICROS:
💊 Magnesium: Xmg / 400mg ✅/⚠️
💊 Potassium: Xmg / 3500mg ✅/⚠️
💊 Zinc: Xmg / 11mg ✅/⚠️
💊 Copper: Xmg / 0.9mg ✅/⚠️
💊 Vitamin D3: XIU / 2000IU ✅/⚠️
💊 Vitamin B6: Xmg / 1.3mg ✅/⚠️
💊 Vitamin B12: Xµg / 2.4µg ✅/⚠️
💊 Iron: Xmg / 8mg ✅/⚠️
💊 Calcium: Xmg / 1000mg ✅/⚠️
💊 Selenium: Xµg / 55µg ✅/⚠️
💊 Omega-3: Xmg ✅/⚠️
💊 Creatine: ✅/❌

SUPPLEMENTS: [list with ✅/❌]

📈 Trend: [X kg from start, X kg to goal, X days remaining]
⚠️ Restrictive days this week: X/2
```

`[Day Type]` in the header shows the day's mode (Normal, OMAD, Rosół, Egg Fast, etc.). TARGET values in the report come from this day type's targets in profile.md.

Show restrictive day count only if user has restrictive day types defined. Warn if approaching limit (2/2).

Translate all labels to the user's preferred language when sending.

## Daily file entry

Write at the end of the daily file:
```markdown
## DAY CLOSED ✅
- Calories: X / TARGET (deficit: ~X kcal)
- Protein: Xg / TARGETg
- Fat: Xg / TARGETg
- Carbs: Xg / TARGETg
- Fiber: Xg / TARGETg
- Activity: [description] (~X kcal burned)
- Deficit with exercise: ~X kcal
```
