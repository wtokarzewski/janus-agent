# Diet Tracker Installation

## When to trigger

- User says "install diet", "I want to track my diet", "set up diet tracking"
- Or: user writes about food but has no `profile.md` in food-diary/

## Reinstall / migration

If user already has `profile.md` and food diary files (e.g. migrating from manual tracking to skill):

1. Read existing `profile.md` and recent diary files
2. Don't re-ask what you already know — just confirm: "I see you have X, Y, Z — correct?"
3. Identify missing fields (day types, experience level, IF window, BF tracking, safety rules) and ask only about those
4. Update `profile.md` to match the current skill template
5. Check heartbeats — update times/format if needed
6. Don't touch existing diary files — they keep working as-is, new entries will follow skill format

## How to run setup

Setup is a **conversation**, not a form. Ask one question at a time, react to answers, build the profile in the background. Don't dump a list of questions.

### Natural sequence

1. **Start** — confirm what you're doing, ask about their goal (lose / gain / track)
2. **Basic data** — age, height, current weight (if not known from PROFILE.md)
3. **Target weight** — how much they want to weigh and by when
4. **Approach** — what diet style works for them? Let them tell you. Common: keto, low carb, standard, carnivore, Mediterranean, IIFYM. Ask about past experience — what worked, what didn't, how their body reacts (e.g. "carbs make me bloat")
5. **Eating patterns** — IF (intermittent fasting)? OMAD? Bone broth fasting? Egg fast? Not everyone uses these — only ask if relevant to their approach. If they mention fasting, ask about eating window (from-to, weekday vs weekend)
6. **Experience level** — are they new to dieting or experienced? This affects how much you explain. A keto veteran doesn't need lectures about ketosis. Note in profile.
7. **Restrictions** — what they don't eat, allergies, intolerances
8. **Activity** — what they do, how often, any limitations (injury, rehab)
9. **Supplements** — what they take daily
10. **Schedule** — when do they wake up? When do they want the weight reminder? Propose a time (wake-up + 15 min) but let the user decide — some people weigh themselves immediately, others after coffee. Check existing heartbeats in their HEARTBEAT.md and avoid conflicts with other reminders. Adapt all ping times to their routine.
11. **Chat** — which Telegram chat to use (private or group), get chatId

You don't have to ask everything at once. If the user volunteers info, don't repeat the question. If you already know something from PROFILE.md — confirm instead of asking again. Users often give info out of order — that's fine, just track what you have and what's missing.

### Mistakes to avoid

- DON'T ask 5 things in one message
- DON'T assume names, dates, events — verify (e.g. whose wedding it is)
- DON'T create profile before you have the basics (weight, goal, approach)
- DON'T lecture about BMI — user knows what it is, show it as a starting point and move on
- DON'T suggest fasting patterns (IF/OMAD/egg fast) unless the user brings them up — some people just want simple tracking
- DON'T explain keto/fasting basics to someone who already knows them — match explanation depth to experience
- DON'T set heartbeat times without checking existing heartbeats first — read user's HEARTBEAT.md and avoid conflicts

## Calculations

Once you have age, height, weight, and activity level — calculate:

```
BMR (Mifflin-St Jeor):
  Male:   10 × weight(kg) + 6.25 × height(cm) - 5 × age + 5
  Female: 10 × weight(kg) + 6.25 × height(cm) - 5 × age - 161

TDEE = BMR × activity factor:
  1.2   = sedentary
  1.375 = light activity (1-3x/week)
  1.55  = moderate (3-5x/week)
  1.725 = high (6-7x/week)

Deficit: TDEE - 500 kcal (~0.5 kg/week)
```

Default macros (adjust to approach):
- Protein: 1.5-2g / kg body weight
- Fat: ~30% of calories (more if low carb/keto)
- Carbs: remaining calories
- Fiber: 25-30g

Present calculations and targets to the user. Ask if they agree. Only save after confirmation.

## Creating profile.md

Save to `.janus/users/{userId}/files/food-diary/profile.md`:

```markdown
# Diet Profile

## Data
- Age: X
- Height: X cm
- Starting weight: X kg
- Start date: YYYY-MM-DD
- Experience: [beginner / intermediate / veteran — affects explanation depth]
- Body fat tracking: [smart scale / calipers / visual / none]

## Goal
- Target weight: X kg
- Deadline: YYYY-MM-DD ([reason if given])
- Pace: ~X kg/week

## Approach
- Type: [low carb / keto / standard / carnivore / Mediterranean / etc.]
- IF window: [e.g. 10:00-22:00 weekdays, flexible weekends — omit if no IF]
- Notes: [e.g. "keto works great, carbs cause bloating", body reactions]

## Day Types

### Normal
- Calories: X kcal
- Protein: Xg
- Fat: Xg
- Carbs: Xg
- Fiber: Xg

[Additional day types only if user uses them — examples:]

### OMAD
- Calories: X kcal
- Protein: Xg
- Fat: Xg
- Carbs: Xg

### Fasting (bone broth / rosół)
- Calories: X kcal
- Description: [e.g. "3-4 portions of rosół"]

### Egg fast
- Calories: X kcal
- Rule: [e.g. "1 tbsp fat per egg"]

[Not everyone has multiple day types. Only add what the user actually uses.]

## Safety rules
- Max restrictive days per week: [default 2]
- Back-to-back restrictive days: no
[Only include if user has restrictive day types]

## Food preferences
- Likes: [what they like]
- Won't eat: [what they don't eat and why]
- Notes: [e.g. "carbs cause bloating", "keto works great"]

## Fixed units
[fill in as the user establishes them — e.g.]
- porcja rosołu (~1 kufel) = 250 kcal, 15g protein, 12g fat, 18g carbs
- 1 scoop SFD WPC80 = 20g powder

## Supplements
- [list]

## Milestones
| Week | Date | Target weight |
|------|------|---------------|
| 1 | DD.MM | XX.X kg |
[etc. — calculate based on pace]
```

## Adding heartbeats

**Before adding:** Read the user's existing HEARTBEAT.md to check for time conflicts with other reminders (briefings, reflections, market updates, etc.). Adjust times to avoid overlap. Also ask what time they wake up — morning weigh-in should be 15-30 min after usual wake-up.

After saving profile — add to the user's HEARTBEAT.md (`.janus/users/{userId}/HEARTBEAT.md`):

```markdown
## Morning weigh-in
- schedule: at {wake_up + 15min}
- chat: {chatId}
- task: Ask user for morning weight. Keep it short. If they have multiple day types, also ask what type of day today. If they reply — save to food-diary/{date}.md

## Food check-in
- schedule: at {adjusted_time, default 13:00}
- chat: {chatId}
- task: Ask user what they've eaten so far today. Save to food-diary/{date}.md, calculate calories/macros using today's day type targets, show DAY STATUS report (progress bars, calories/macros/supplements). Read diet-tracker skill for format.

## Evening diet close
- schedule: at {adjusted_time, default 21:00}
- chat: {chatId}
- task: Close the diet day — ask what else they ate, summarize calories/macros, save to food-diary/{date}.md. Show DAY CLOSED summary (progress bars, deficit, weight trend, supplements). Read formats/day-close.md from diet-tracker skill for format.

## Weekly diet summary
- schedule: cron 30 8 * * 1
- chat: {chatId}
- task: Weekly diet summary. Read food-diary/ for last 7 days. Calculate average weight, average calories, trend, day type distribution. Show countdown to goal. Read formats/weekly.md from diet-tracker skill for format.
```

Times are examples — adjust to user's schedule and existing heartbeats. If the user already has an evening reflection at 21:00, combine diet close with it or shift by 30 min.

## First day

Create `food-diary/YYYY-MM-DD.md` with today's date and day number 1. If user already gave weight or a meal — save it immediately.

## Confirmation

Summarize what you set up — keep it short:

```
✅ Diet tracker ready!

📋 [start weight] → [goal] by [deadline]
🔥 [kcal] kcal / day
📊 P [X]g / F [X]g / C [X]g / Fb [X]g
⏰ Heartbeats: 7:15, 13:00, 21:00, Mon 8:30
📱 Chat: [name/id]
```
