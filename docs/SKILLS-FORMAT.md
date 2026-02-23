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

Each skill lives in its own directory:

```
skills/
├── programmer/
│   └── SKILL.md
├── researcher/
│   └── SKILL.md
└── my-custom-skill/
    └── SKILL.md
```

## Loading Behavior

- **`always: true`** — Full skill body is included in every system prompt
- **`always: false`** (default) — Only a stub (name + description + file path) is shown. The agent can read the full skill on demand using `read_file`

This lazy loading saves tokens when many skills are available.

## Example

See `skills/example/SKILL.md` for a complete working example.

## Creating a New Skill

1. Create a directory: `skills/my-skill/`
2. Write a `SKILL.md` with YAML frontmatter + markdown instructions
3. Restart Janus — the skill will be auto-discovered
