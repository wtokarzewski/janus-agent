---
name: skill-creator
description: "Create new skills when a task pattern has no existing skill. Use when building a reusable solution the agent can apply in future interactions."
version: "1.0.0"
always: false
---

# Skill Creator

Create new Janus skills when you identify a repeatable task pattern that no existing skill covers.

## When to Create a Skill

- User asks for something you've done before (or will likely need again)
- The task requires specific steps, scripts, or API knowledge worth preserving
- A wrapper script would make future executions reliable and fast

Do NOT create a skill for one-off tasks or things already covered by an existing skill.

## Skill Anatomy

```
skills/{skill-name}/
  SKILL.md              # Required — frontmatter + instructions
  scripts/              # Optional — executable scripts (Python, Bash)
  references/           # Optional — API docs, specs for context
  assets/               # Optional — templates, config samples
```

### SKILL.md Structure

```markdown
---
name: skill-name
description: "One-line description of WHEN this skill applies"
version: "1.0.0"
requires:
  bins: [curl, jq]        # Optional — required CLI tools
  env: [API_KEY]           # Optional — required env vars
always: false              # true = always loaded in context; false = on-demand
---

# Skill Name

Brief explanation of what this skill does.

## Setup (if needed)

Installation steps, config file locations, API key instructions.

## Usage

How to use the skill — commands, script invocations, examples.

## Rules

Constraints, rate limits, security considerations.
```

## Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Kebab-case identifier (e.g., `stock-watcher`) |
| `description` | Yes | One line explaining WHEN to use this skill — the agent matches on this |
| `version` | Yes | Semver string |
| `requires.bins` | No | CLI tools that must exist in PATH |
| `requires.env` | No | Environment variables that must be set |
| `always` | No | `true` = full instructions always in context. Default `false` (on-demand) |

## Design Principles

### 1. Description is the trigger
The `description` field determines when the agent picks this skill. Write it as a trigger condition, not a feature list:
- Good: `"Control Home Assistant devices — lights, switches, climate, scenes"`
- Bad: `"A skill for smart home automation"`

### 2. Scripts for deterministic work
If a task involves API calls, data processing, or anything where LLM hallucination would be costly — write a script. The agent calls scripts via `exec`, which is reliable and repeatable.

### 3. Progressive disclosure
- **Frontmatter** (~30 words) — always visible to agent as skill summary
- **SKILL.md body** — loaded only when skill is triggered (via `read_file`)
- **scripts/references/** — loaded by agent only when executing the skill

This keeps context lean. Never set `always: true` unless the skill applies to nearly every interaction.

### 4. Config and secrets
Store config/secrets outside the skill directory:
- `~/.janus/{skill-name}/config.json` — user-level config
- Environment variables — for API keys
- Never hardcode secrets in SKILL.md or scripts

## Creation Steps

1. **Choose a name** — kebab-case, descriptive (e.g., `dns-lookup`, `image-resize`)
2. **Create directory** — `skills/{name}/`
3. **Write SKILL.md** — frontmatter + clear instructions
4. **Add scripts/** — if the skill needs deterministic execution (API calls, data parsing)
5. **Test** — verify scripts work, verify the skill loads (agent sees it next interaction)

## Where to Create

- **Workspace skills** (`skills/` in project root) — shared with team, committed to repo
- **User skills** (`.janus/skills/` in workspace) — local to this workspace, not committed

## Example: Minimal Skill

```markdown
---
name: dns-lookup
description: "DNS record lookup — A, AAAA, MX, CNAME, TXT records for any domain"
version: "1.0.0"
requires:
  bins: [dig]
---

# DNS Lookup

Query DNS records using `dig`.

## Usage

\`\`\`bash
# A record
dig +short example.com A

# All records
dig +noall +answer example.com ANY

# Specific nameserver
dig @8.8.8.8 example.com MX
\`\`\`

## Rules

- Always use `+short` for concise output unless user wants full details
- Show TTL when relevant (use `+noall +answer` format)
```

## Example: Skill with Scripts

```markdown
---
name: api-monitor
description: "Monitor API endpoints — check status, response time, alert on failures"
version: "1.0.0"
requires:
  bins: [python3, curl]
---

# API Monitor

Monitor HTTP endpoints with alerting.

## Scripts

\`\`\`bash
# Check single endpoint
python3 scripts/check.py https://api.example.com/health

# Check all monitored endpoints
python3 scripts/check_all.py

# Add endpoint to monitor list
python3 scripts/add_endpoint.py https://api.example.com/health --name "Example API"
\`\`\`

## Storage

Endpoints stored at `~/.janus/api-monitor/endpoints.json`.
```

Then create `scripts/check.py`, `scripts/check_all.py`, etc. with the actual implementation.
