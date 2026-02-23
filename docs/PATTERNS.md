# Wzorce (Patterns)

> Note: This document is in Polish. Translation contributions welcome.

## Przegląd

Janus używa sprawdzonych wzorców z PromptHub:

| Pattern | Użycie | Cel |
|---------|--------|-----|
| Q&A Loop | Zbieranie wymagań | Iteracyjne doprecyzowanie |
| 3×3 Workflow | Implementacja | Kontrolowana iteracja |
| Checkpoint | Długie procesy | Periodic review |
| Gates | Quality control | Approval + rollback |
| Error Recovery | Obsługa błędów | 3 opcje naprawy |
| Structured Summary | Podsumowania | Consistent format |

---

## Q&A Loop

### Cel

Zbieranie informacji przez iteracyjne pytania i odpowiedzi.

### Jak działa

```
START
  │
  ▼
AI generuje 10 pytań + rekomendacji
  │
  ▼
User odpowiada
  │
  ▼
User powiedział "summary"?
  │
  ├── NIE → wróć do generowania pytań
  │
  └── TAK ─┐
           ▼
    AI generuje structured summary
           │
           ▼
         END
```

### Prompt template

```markdown
You are an experienced [ROLE]...

Based on your analysis, generate a list of 10 questions and recommendations.

For each question:
1. Ask a specific question about [DOMAIN]
2. Provide a recommendation based on best practices

Continue this process, generating new questions and recommendations
based on the user's responses, until the user explicitly asks for a summary.
```

### Konfiguracja w skill.yaml

```yaml
- id: "1.1"
  name: "PRD Planning Session"
  pattern: "qa_loop"
  pattern_config:
    end_trigger: "summary"      # słowo kończące loop
    max_rounds: 10              # safety limit
    questions_per_round: 10     # ile pytań na raz
```

### Kiedy używać

- ✅ Zbieranie wymagań (PRD)
- ✅ Planowanie bazy danych
- ✅ Analiza architektury
- ✅ Discovery phase

### Kiedy NIE używać

- ❌ Proste, jasne zadania
- ❌ Implementacja (użyj 3×3)
- ❌ Gdy user zna dokładnie czego chce

---

## 3×3 Workflow

### Cel

Implementacja w małych, kontrolowanych krokach z feedbackiem.

### Jak działa

```
START
  │
  ▼
AI implementuje MAX 3 kroki
  │
  ▼
AI podsumowuje co zrobiło
  │
  ▼
AI opisuje plan na kolejne 3 kroki
  │
  ▼
STOP - czekaj na feedback
  │
  ▼
User feedback:
  │
  ├── "continue" → wróć do implementacji
  ├── "stop" → zakończ
  └── "change X" → dostosuj i kontynuuj
```

### Prompt template

```markdown
<implementation_approach>
Implement a maximum of 3 steps from the implementation plan.

After completing the steps:
1. Briefly summarize what you've done
2. Describe the plan for the next 3 actions
3. STOP and wait for my feedback

Do not continue without my explicit approval.
</implementation_approach>
```

### Konfiguracja w skill.yaml

```yaml
- id: "4.4"
  name: "API Implementation"
  pattern: "3x3"
  pattern_config:
    steps_per_iteration: 3
    require_feedback: true
    allow_skip: false          # czy user może pominąć feedback
```

### Kiedy używać

- ✅ Implementacja kodu
- ✅ Refactoring
- ✅ Długie zadania które można podzielić
- ✅ Gdy chcesz kontrolować postęp

### Kiedy NIE używać

- ❌ Proste, jednorazowe zadania
- ❌ Zbieranie informacji (użyj Q&A)
- ❌ Gdy user nie chce być angażowany

---

## Checkpoint

### Cel

Periodic review podczas długich procesów.

### Jak działa

```
Task 1 → Task 2 → Task 3 → [CHECKPOINT] → Task 4 → Task 5 → ...
                                │
                                ▼
                    "Checkpoint. Kontynuować?"
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                   YES                      NO
                    │                       │
                continue                stop/adjust
```

### Konfiguracja w skill.yaml

```yaml
- id: "4.4"
  name: "API Implementation"
  pattern: "checkpoint"
  pattern_config:
    checkpoint_every: 3         # co ile tasków
    checkpoint_message: "Completed {n} tasks. Continue?"
    allow_adjust: true          # czy user może zmienić plan
```

### Różnica: 3×3 vs Checkpoint

| Aspekt | 3×3 | Checkpoint |
|--------|-----|------------|
| Granularity | Po każdych 3 krokach | Co N tasków |
| Feedback | Required | Optional continue |
| Użycie | Implementacja | Długie procesy |

---

## Gates

### Cel

Quality control z możliwością rollback.

### Typy

#### Manual Approval

User musi zatwierdzić przed kontynuacją.

```yaml
gate:
  type: "manual_approval"
  message: "Sprawdź PRD. Zatwierdzić?"
  rollback_to: "1.1"           # gdzie wrócić gdy odrzucone
```

```
Task 1.2 → Output → [GATE: Manual Approval]
                            │
                    ┌───────┴───────┐
                    ▼               ▼
               APPROVED         REJECTED
                    │               │
                    ▼               ▼
               Task 1.3      Rollback to 1.1
```

#### Auto Validation

Automatyczne sprawdzenie bez pytania usera.

```yaml
gate:
  type: "auto_validation"
  validations:
    - contract: "prd"          # sprawdź artifact contract
    - file_exists: "prd.md"    # sprawdź czy plik istnieje
    - custom: "validate_prd"   # custom validator
  on_fail: "rollback"          # lub "ask_user"
  rollback_to: "1.1"
```

#### Checkpoint Gate

Zapisuje stan, można wrócić później.

```yaml
gate:
  type: "checkpoint"
  message: "Checkpoint saved. Continue or stop?"
  save_state: true
```

### Rollback mechanizm

```
Current: Task 3.3 (Schema Generation)
Gate: REJECTED
Rollback to: 3.1

Process:
1. Discard output of 3.3
2. Discard output of 3.2 (depends on 3.1)
3. Return to 3.1 (Database Planning Session)
4. User can re-do Q&A with new info
```

### Konfiguracja w skill.yaml

```yaml
phases:
  - id: 1
    tasks:
      - id: "1.3"
        name: "Complete PRD"
        gate:
          type: "manual_approval"
          message: "PRD ready for review"
          rollback_to: "1.1"
          
  - id: 3
    tasks:
      - id: "3.3"
        name: "Schema Generation"
        gate:
          type: "auto_validation"
          validations:
            - contract: "db_schema"
            - custom: "validate_foreign_keys"
          on_fail: "ask_user"
          rollback_to: "3.1"
```

---

## Error Recovery

### Cel

Graceful handling błędów z opcjami naprawy.

### 3 opcje

```
ERROR during Task execution
            │
            ▼
Show error details:
• Task: 4.4-profiles-implementation
• Step: Create migration
• Error: Syntax error in SQL
• Context: Line 15, missing comma
            │
            ▼
Options:
a) Fix and retry current task
b) Skip task and continue
c) Stop completely

Choose: _
```

### Konfiguracja

```yaml
settings:
  error_handling:
    show_details: true
    allow_retry: true
    allow_skip: true
    max_retries: 3
    on_max_retries: "ask_user"   # lub "skip" lub "stop"
```

### Implementacja

```typescript
interface ErrorRecovery {
  handleError(task: Task, error: Error): RecoveryAction;
}

type RecoveryAction =
  | { type: "retry"; task: Task; fix?: string }
  | { type: "skip"; reason: string }
  | { type: "stop"; error: Error }
  | { type: "ask_user"; options: RecoveryOption[] };

async function handleError(task: Task, error: Error): Promise<RecoveryAction> {
  // Log error
  logger.error({
    task: task.id,
    step: task.currentStep,
    error: error.message,
    context: error.context
  });
  
  // Check retry count
  if (task.retryCount >= config.maxRetries) {
    return { type: "ask_user", options: ["skip", "stop"] };
  }
  
  // Ask user
  const choice = await prompt({
    message: `Error in ${task.name}: ${error.message}`,
    choices: [
      { name: "Fix and retry", value: "retry" },
      { name: "Skip this task", value: "skip" },
      { name: "Stop execution", value: "stop" }
    ]
  });
  
  return { type: choice };
}
```

---

## Structured Summary

### Cel

Consistent format dla podsumowań.

### Template

```markdown
<conversation_summary>

<decisions>
1. [Decision 1] — Reasoning, Impact
2. [Decision 2] — Reasoning, Impact
</decisions>

<recommendations>
1. [Recommendation 1] — matched to decision/question
2. [Recommendation 2] — matched to decision/question
</recommendations>

<summary>
[Detailed summary of the planning session]
</summary>

<unresolved_issues>
1. [Issue 1] — Owner, Deadline, Next step
2. [Issue 2] — Owner, Deadline, Next step
</unresolved_issues>

<action_items>
1. [Action 1] — Priority, Assignee
2. [Action 2] — Priority, Assignee
</action_items>

</conversation_summary>
```

### Użycie w skill

```yaml
- id: "1.2"
  name: "PRD Summary"
  pattern: "single"
  output_format: "structured_summary"
  output_sections:
    - decisions
    - recommendations
    - summary
    - unresolved_issues
```

### Walidacja

```typescript
function validateStructuredSummary(output: string): ValidationResult {
  const required = [
    "<decisions>",
    "<recommendations>", 
    "<summary>",
    "</conversation_summary>"
  ];
  
  const missing = required.filter(tag => !output.includes(tag));
  
  if (missing.length > 0) {
    return { valid: false, missing };
  }
  
  return { valid: true };
}
```

---

## Mini Plan (dla MEDIUM tier, score 4-6)

### Cel

Szybkie planowanie dla średnich zadań (nie wymaga pełnych faz).

### Template

```yaml
mini_plan_template:
  steps:
    - name: "Understand"
      description: "Zrozum zadanie i kontekst"
      output: "task_understanding.md"
      
    - name: "Locate"
      description: "Znajdź pliki do zmiany"
      output: "files_to_change.md"
      
    - name: "Implement"
      description: "Zaimplementuj zmiany"
      
    - name: "Test"
      description: "Przetestuj zmiany"
      
    - name: "Cleanup"
      description: "Posprzątaj kod"
      optional: true
```

### Flow

```
User: "Dodaj dark mode do aplikacji"
            │
            ▼
Classifier: score = 5/10 → MEDIUM tier
            │
            ▼
Mini Plan:
1. Understand: Co to dark mode?
   → Kolory, toggle, persistence

2. Locate: Gdzie są style?
   → global.css, theme context

3. Implement: Zrób zmiany
   → CSS variables, toggle component

4. Test: Sprawdź
   → Manual test, unit test

5. Cleanup: Posprzątaj
   → Remove unused, format
            │
            ▼
        Execute
```

---

## Porównanie: Kiedy który pattern

| Sytuacja | Pattern |
|----------|---------|
| Zbieranie wymagań | Q&A Loop |
| Nie wiem czego chcę | Q&A Loop |
| Implementacja kodu | 3×3 |
| Długi refactoring | 3×3 + Checkpoint |
| Quality checkpoint | Gate (manual) |
| Auto-walidacja | Gate (auto) |
| Błąd podczas execution | Error Recovery |
| Średnie zadanie (4-6) | Mini Plan |
| Proste zadanie (1-3) | Execute immediately |

---

## Kompozycja patterns

Patterns można łączyć:

```yaml
- id: "4.4"
  name: "API Implementation"
  pattern: "3x3"                    # główny pattern
  pattern_config:
    steps_per_iteration: 3
    checkpoint_every: 3             # + checkpoint co 3 iteracje
  gate:
    type: "auto_validation"         # + gate na końcu
    validations:
      - contract: "api_code"
  error_handling:
    allow_retry: true               # + error recovery
    max_retries: 3
```

Flow:
```
3×3 iteration 1 → 3×3 iteration 2 → 3×3 iteration 3 → [CHECKPOINT]
                                                            │
                                        User: "continue" ───┘
                                                            │
3×3 iteration 4 → Error! → [RETRY] → 3×3 iteration 4 (fixed)
                                                            │
... → Task complete → [GATE: validation] → PASS → Next task
```
