# Context Management

> Note: This document is in Polish. Translation contributions welcome.

## Problem

AI ma ograniczone context window. Gdy projekt rośnie:

```
prd.md           ~2000 słów
tech-stack.md    ~500 słów
db-schema.md     ~500 linii
api-plan.md      ~2000 słów (37 endpointów)
types.ts         ~300 linii
ui-plan.md       ~1500 słów
─────────────────────────────
SUMA             ~7300 słów + prompt = OVERFLOW
```

Wrzucenie wszystkiego do kontekstu:
- Przekracza limity
- AI się gubi w szczegółach
- Kosztuje $$$ (płacisz za tokeny)
- Odpowiedzi są słabsze (too much noise)

## Rozwiązanie: Pre-filled Prompts

### Koncepcja

Zamiast dawać AI całość, dajemy **tylko to co potrzebne** dla konkretnego taska.

```
api-plan.md (2000 słów, 37 endpointów)
                    │
                    ▼
            [Context Minimizer]
                    │
                    ▼
    ┌───────────────┼───────────────┐
    ▼               ▼               ▼
01-profiles     02-families     03-receipts
(200 słów)      (250 słów)      (400 słów)
(3 endpointy)   (4 endpointy)   (7 endpointów)
```

**Redukcja: 95%**

### Jak to działało w PromptHub (ręcznie)

1. Autor czytał duży plik (api-plan.md)
2. Ręcznie kopiował tylko relevantne sekcje
3. Wklejał do nowego promptu
4. Wysyłał do AI

**Problem:** Czasochłonne, podatne na błędy

### Jak ma działać w Janusie (automatycznie)

```
┌─────────────────────────────────────────┐
│          CONTEXT MINIMIZER              │
├─────────────────────────────────────────┤
│                                         │
│  1. Domain Decomposer                   │
│     └─ Rozbij artifacts na domeny       │
│                                         │
│  2. Relevant Extractor                  │
│     └─ Wyciągnij tylko potrzebne        │
│                                         │
│  3. Pre-filled Generator                │
│     └─ Wygeneruj gotowy prompt          │
│                                         │
└─────────────────────────────────────────┘
```

## Strategie dekompozycji

### By Domain (domyślna)

Grupowanie po encjach/domenach biznesowych.

```
API Plan (37 endpoints)
         │
         ▼
┌────────┬────────┬────────┬────────┐
│Profiles│Families│Receipts│Tags    │
│(3 ep)  │(4 ep)  │(7 ep)  │(4 ep)  │
└────────┴────────┴────────┴────────┘
```

**Kiedy używać:** API, bazy danych, CRUD

### By Feature

Grupowanie po funkcjonalnościach.

```
App Features
         │
         ▼
┌────────┬────────┬────────┐
│Auth    │Scan    │Search  │
│Flow    │Receipt │& Filter│
└────────┴────────┴────────┘
```

**Kiedy używać:** UI, user flows

### By Layer

Grupowanie po warstwach architektury.

```
Codebase
         │
         ▼
┌────────┬────────┬────────┐
│Database│API     │Frontend│
│Layer   │Layer   │Layer   │
└────────┴────────┴────────┘
```

**Kiedy używać:** Refactoring, debugging

## Artifact Handoff

### Zasada

Każda faza produkuje **skondensowany artifact** który jest inputem dla następnej.

```
Faza 1: PRD Planning
        │
        ▼
    prd.md (decisions, requirements, stories)
        │
        ▼
Faza 3: Database Design
        │
        ▼
    db-plan.md (entities, relationships)
        │
        ▼
    db-schema.md (DDL only)
        │
        ▼
Faza 4: API Design
        │
        ▼
    api-plan.md (endpoints, payloads)
        │
        ▼
    types.ts (TypeScript types)
```

### Co NIE przechodzi

- Pełna historia konwersacji
- Wcześniejsze drafty
- Odrzucone opcje
- Kontekst który został "skonsumowany"

### Artifact Handoff Matrix

| Z Fazy | Artifact | Rozmiar | Co zawiera | Do Fazy |
|--------|----------|---------|------------|---------|
| 1 | prd.md | ~2000 | Requirements, Stories | 3, 4, 5 |
| 1 | tech-stack.md | ~500 | Decisions | 2, 3, 4 |
| 3 | db-plan.md | ~1000 | Entities, Relations | 4 |
| 3 | db-schema.md | ~500 | DDL only | 4 |
| 4 | api-plan.md | ~2000 | Endpoints, Payloads | 5 |
| 4 | types.ts | ~300 | DTOs, Commands | 5 |
| 5 | ui-plan.md | ~1500 | Views, Navigation | 5.5 |

## Pre-filled Prompt Generator

### Input

```yaml
task: "4.4-profiles-implementation"
domain: "profiles"
required_context:
  - api-plan.md
  - db-schema.md
  - types.ts
```

### Process

1. **Load artifacts**
   ```
   api-plan.md    → 2000 słów
   db-schema.md   → 500 linii
   types.ts       → 300 linii
   ```

2. **Extract relevant**
   ```
   api-plan.md    → tylko endpoints /profiles/* → 200 słów
   db-schema.md   → tylko CREATE TABLE profiles → 30 linii
   types.ts       → tylko ProfileDTO → 20 linii
   ```

3. **Generate pre-filled prompt**

### Output

```markdown
# Domain Implementation: Profiles

## Endpoint Specifications (pre-extracted)

### GET /profiles/me
**Description:** Get current user profile
**Response:**
```json
{ "id": "uuid", "email": "string", "name": "string" }
```
**Errors:** 401 Unauthorized, 404 Not Found

### PATCH /profiles/me
**Description:** Update current user profile
**Payload:**
```json
{ "name": "string", "avatar_url": "string" }
```
**Response:** Updated profile
**Errors:** 401 Unauthorized, 400 Bad Request

### POST /profiles
**Description:** Create profile for new user
...

## Database Schema (pre-extracted)

```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_profiles_user_id ON profiles(user_id);
```

## Type Definitions (pre-extracted)

```typescript
// From types.ts, lines 42-58
export interface ProfileDTO {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface UpdateProfileCommand {
  name?: string;
  avatarUrl?: string;
}
```

## Task

Implement the Profiles domain:
1. Create database migration
2. Implement API endpoints
3. Add validation
4. Write tests
```

### Porównanie

| Bez Context Minimizer | Z Context Minimizer |
|-----------------------|---------------------|
| ~7300 słów | ~400 słów |
| Wszystkie 37 endpointów | Tylko 3 relevantne |
| Cały schema | Tylko profiles table |
| Wszystkie typy | Tylko ProfileDTO |
| **Overflow / słaba jakość** | **Fits / świetna jakość** |

## Implementacja w Janusie

### Interface

```typescript
interface ContextMinimizer {
  // Rozbij artifact na domeny
  decompose(
    artifact: Artifact,
    strategy: "by_domain" | "by_feature" | "by_layer"
  ): Domain[];

  // Wyciągnij relevantne sekcje
  extractRelevant(
    artifact: Artifact,
    domain: string,
    sections?: string[]
  ): string;

  // Wygeneruj pre-filled prompt
  generatePrefilled(
    task: Task,
    domain: string,
    artifacts: Artifact[]
  ): string;

  // Estymuj rozmiar kontekstu
  estimateTokens(context: string): number;
}
```

### Domain Decomposer

```typescript
function decompose(artifact: Artifact, strategy: string): Domain[] {
  switch (strategy) {
    case "by_domain":
      // Szukaj patterns: /profiles/*, /families/*, etc.
      return extractDomainsByUrlPattern(artifact);
      
    case "by_feature":
      // Szukaj sekcji: ## Authentication, ## Scanning, etc.
      return extractDomainsBySections(artifact);
      
    case "by_layer":
      // Szukaj keywords: database, api, frontend
      return extractDomainsByLayer(artifact);
  }
}
```

### Relevant Extractor

```typescript
function extractRelevant(
  artifact: Artifact,
  domain: string
): string {
  const lines = artifact.content.split('\n');
  const relevant: string[] = [];
  
  let inRelevantSection = false;
  
  for (const line of lines) {
    // Sprawdź czy to początek relevantnej sekcji
    if (isRelevantHeader(line, domain)) {
      inRelevantSection = true;
    }
    
    // Sprawdź czy to koniec sekcji
    if (inRelevantSection && isNewSection(line)) {
      inRelevantSection = false;
    }
    
    if (inRelevantSection) {
      relevant.push(line);
    }
  }
  
  return relevant.join('\n');
}
```

### Pre-filled Generator

```typescript
function generatePrefilled(
  task: Task,
  domain: string,
  artifacts: Artifact[]
): string {
  const sections: string[] = [];
  
  // Header
  sections.push(`# Domain Implementation: ${domain}\n`);
  
  // Extract from each artifact
  for (const artifact of artifacts) {
    const relevant = extractRelevant(artifact, domain);
    if (relevant) {
      sections.push(`## ${artifact.name} (pre-extracted)\n`);
      sections.push(relevant);
      sections.push('');
    }
  }
  
  // Add task prompt
  sections.push(`## Task\n`);
  sections.push(task.prompt);
  
  return sections.join('\n');
}
```

## Konfiguracja w skill.yaml

```yaml
settings:
  context_management:
    # Włącz pre-filled prompts
    pre_filled_prompts: true
    
    # Max tokenów na prompt
    max_context_tokens: 8000
    
    # Domyślna strategia dekompozycji
    decomposition_strategy: "by_domain"
    
    # Włącz auto-chunking gdy przekracza limit
    auto_chunk: true
    chunk_size: 4000
```

## Monitoring

### Metryki do śledzenia

```typescript
interface ContextMetrics {
  // Przed minimizacją
  originalTokens: number;
  
  // Po minimizacji
  minimizedTokens: number;
  
  // Redukcja
  reductionPercent: number;
  
  // Czy zmieściło się
  fitsInContext: boolean;
  
  // Koszt
  estimatedCostUSD: number;
}
```

### Logi

```
[Context] Task: 4.4-profiles-implementation
[Context] Domain: profiles
[Context] Original: 7340 tokens
[Context] Minimized: 412 tokens
[Context] Reduction: 94.4%
[Context] Estimated cost: $0.0008
```

## Best Practices

### 1. Artifacts powinny być strukturyzowane

**Dobrze:**
```markdown
## Profiles Domain

### GET /profiles/me
...

### PATCH /profiles/me
...

## Families Domain

### GET /families
...
```

**Źle:**
```markdown
GET /profiles/me returns user profile
PATCH /profiles/me updates it
GET /families returns families
mixed content everywhere
```

### 2. Używaj consistent naming

```
Domain w API:     /profiles/*
Domain w schema:  profiles table
Domain w types:   ProfileDTO
Domain w tasks:   profiles-implementation
```

### 3. Nie duplikuj informacji

Jeśli PRD zawiera "user can scan receipts", nie powtarzaj tego w:
- db-plan.md
- api-plan.md
- ui-plan.md

Referencuj: "As per PRD, scanning feature..."

### 4. Artifact contracts

Definiuj wymagane sekcje:

```yaml
contracts:
  api_plan:
    required_sections:
      - "# Endpoints"
      - "# Authentication"
```

To pozwala Context Minimizer wiedzieć gdzie szukać.

