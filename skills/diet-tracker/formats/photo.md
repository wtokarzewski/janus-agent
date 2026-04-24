# Photo Calorie Estimation

## When

User sends a photo of food (with or without description).

## Procedure

1. Identify all visible ingredients in the photo
2. Estimate weight of each ingredient (based on proportions, plate size, comparisons)
3. Calculate calories and macros (protein, fat, carbs, fiber) for each
4. Present a table with estimates
5. Ask user to confirm or correct
6. After confirmation — save to food-diary as a normal meal
7. Send DAY STATUS report

## Estimation rules

- Overestimate rather than underestimate (safer for deficit)
- Give ranges if uncertain (e.g. "150-200g")
- Account for preparation method (fried = more fat than boiled)
- If you can't identify an ingredient — ask
- Standard dinner plate ≈ 26cm — use as scale reference

## Response format

```
📸 I see on the photo:

| Ingredient | Weight (est.) | kcal | Protein | Fat | Carbs | Fiber |
|------------|---------------|------|---------|-----|-------|-------|
| ... | ~Xg | X | Xg | Xg | Xg | Xg |
| **Total** | | **X** | **Xg** | **Xg** | **Xg** | **Xg** |

Does this look right? I can adjust weights if something's off.
```

Translate all labels to the user's preferred language when sending.
