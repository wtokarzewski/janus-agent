# Skill Format

## What is a Skill

A skill is a **competency** — a set of instructions that tells the agent how to approach a category of tasks.

Skills are defined as `SKILL.md` files with YAML frontmatter and a markdown body.

## File Format

```markdown
---
name: my-skill
description: "What this skill does"
version: "1.0.0"
requires:
  bins: [git, node]     # optional: required CLI tools
always: true            # true = always included in prompt, false = loaded on demand
---

# My Skill

Instructions for the agent when this skill is active.
Write these as if you're briefing a colleague on how to approach this type of work.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier (lowercase, hyphens) |
| `description` | yes | One-line description for matching |
| `version` | no | Semver version string |
| `requires.bins` | no | CLI tools that must be available |
| `always` | no | If `true`, skill body is always in the system prompt. Default: `false` (on-demand) |

### Body

The markdown body after the `---` separator contains the actual instructions. This is injected into the system prompt when the skill is active.

## Directory Structure

Skills are searched in order (first match wins):

1. `{workspace}/skills/` — project-specific skills
2. `~/.janus/skills/` — user-global skills
3. Built-in skills (shipped with Janus)

Each skill lives in its own directory. Skills may include helper scripts and reference docs:

```
skills/
├── programmer/
│   └── SKILL.md
├── home-assistant/
│   ├── SKILL.md
│   ├── scripts/
│   │   └── ha.sh            # CLI wrapper (exec via agent)
│   └── references/
│       └── api.md           # API docs (read_file on demand)
├── stock-watcher/
│   ├── SKILL.md
│   └── scripts/
│       ├── config.py        # Shared config (paths, validation)
│       ├── add_stock.py
│       ├── list_stocks.py
│       └── ...
└── personal-travel/
    └── SKILL.md
```

### Subdirectories

- **`scripts/`** — Helper scripts (bash, python) the agent runs via `exec`. Must validate all inputs.
- **`references/`** — Extended docs the agent reads via `read_file` on demand (keeps SKILL.md concise).

## Loading Behavior

- **`always: true`** — Full skill body is included in every system prompt
- **`always: false`** (default) — Only a stub (name + description + file path) is shown. The agent can read the full skill on demand using `read_file`

This lazy loading saves tokens when many skills are available.

## Examples

- `skills/example/SKILL.md` — Simple always-on skill (programmer)
- `skills/meal-planner/SKILL.md` — On-demand, pure LLM skill (no scripts)
- `skills/home-assistant/` — On-demand with bash CLI wrapper + API reference
- `skills/stock-watcher/` — On-demand with Python scripts + centralized config
- `skills/personal-travel/` — On-demand, pure LLM skill using native memory

## Creating a New Skill

1. Create a directory: `skills/my-skill/`
2. Write a `SKILL.md` with YAML frontmatter + markdown instructions
3. Optionally add `scripts/` (helpers) and `references/` (docs)
4. Restart Janus — the skill will be auto-discovered

## Security Guidelines

- **Validate all inputs** in scripts — never pass raw user/agent input to shell commands or URLs
- **Use `jq -n --arg`** (not string interpolation) for JSON construction in bash
- **Restrict file permissions** (`chmod 600`) on config files containing tokens or secrets
- **Sanitize data** written to files — prevent format injection (e.g., `|` in pipe-delimited files)
- **Re-validate** data read from files before using in URLs or commands
