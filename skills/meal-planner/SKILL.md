---
name: meal-planner
description: "Weekly meal planning with shopping list, based on family preferences and available ingredients"
version: "1.0.0"
always: false
---

# Meal Planner

Plan weekly meals for the family based on individual dietary preferences, available ingredients, and recipe sources.

## Data sources

1. **User preferences** — read each family member's PROFILE.md for dietary restrictions, allergies, likes/dislikes, calorie targets
2. **Available ingredients** — check family memory for recent "fridge update" or "pantry" notes from any family member
3. **Recipe sources** — use `web_fetch` on recipe URLs provided by users or stored in family memory. If no URLs available, use `web_search` to find recipes matching the constraints

## Procedure

1. **Gather preferences** — read profiles of all family members in the current family group. Note allergies, restrictions, and preferences for each person
2. **Check ingredients** — search memory for recent ingredient updates (fridge, pantry, what we have). If none found, skip and plan without ingredient constraints
3. **Plan meals** — create a 7-day plan with the configured meals per day (default: breakfast, lunch, dinner). Each meal must:
   - Respect ALL dietary restrictions and allergies (hard constraints — never violate)
   - Try to accommodate preferences (soft constraints — best effort)
   - Provide variety — don't repeat the same main ingredient on consecutive days
   - Use available ingredients first to minimize waste
4. **Generate shopping list** — list all ingredients needed that aren't already available, grouped by category (produce, dairy, meat, pantry, frozen)
5. **Format output** — use the output format below

## Output format

```
## Plan posilkow: [date range]

### Poniedzialek [date]
- Sniadanie: [meal] — [short description]
- Obiad: [meal] — [short description]
- Kolacja: [meal] — [short description]

[repeat for each day]

## Lista zakupow

### Warzywa i owoce
- [item] — [amount]

### Nabiał
- [item] — [amount]

### Mieso/Ryby
- [item] — [amount]

### Sypkie/Spizarnia
- [item] — [amount]

### Mrozonki
- [item] — [amount]

## Uwagi
- [any notes about substitutions, leftover usage, etc.]
```

## Rules

- Output always in Polish
- Prefer simple, practical meals over complex recipes
- If a recipe URL was provided by a user, try to incorporate it
- Mark allergens clearly if a meal contains common allergens
- If conflicting preferences exist (one person wants meat, another is vegetarian), suggest variants or sides that work for both
- Don't repeat the full recipe — just name, short description, and key ingredients. User can ask for details if needed
