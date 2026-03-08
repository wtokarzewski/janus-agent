# Per-User Configuration

Janus supports per-user overrides for profiles, agent behavior, and scheduled tasks. Each user's files live in the workspace under `.janus/users/{userId}/`.

## Directory Structure

```
{workspace}/
├── AGENTS.md                              # Global agent behavior (all users)
├── HEARTBEAT.md                           # Global scheduled tasks (all users)
├── JANUS.md                               # Project instructions (all users)
├── .janus/
│   └── users/
│       ├── wojtek/
│       │   ├── PROFILE.md                 # Preferences, dietary restrictions, etc.
│       │   ├── AGENTS.md                  # Behavior override (appended to global)
│       │   └── HEARTBEAT.md               # Personal scheduled tasks
│       └── asia/
│           ├── PROFILE.md
│           ├── AGENTS.md
│           └── HEARTBEAT.md
```

## Files

### PROFILE.md (per-user)

User preferences, auto-updated by the agent during conversations.

```markdown
## Preferences
- Language: Polish in conversation, English in code
- Style: concise, no long explanations
- Timezone: Europe/Warsaw

## Dietary
- Vegetarian
- Allergic to nuts
```

**Location:** `.janus/users/{userId}/PROFILE.md`
**Loaded by:** `user-resolver.ts` → `loadProfileMd()`
**Updated by:** Agent (via `write_file`/`edit_file` when it learns new preferences)

### AGENTS.md (global + per-user)

Agent behavior rules. Global file applies to everyone; per-user file appends additional rules.

**Global** (`./AGENTS.md`):
```markdown
# Agent Rules
- Be helpful and concise
- Ask before taking destructive actions
- Show your work
```

**Per-user** (`.janus/users/wojtek/AGENTS.md`):
```markdown
# Wojtek
- Always respond in Polish
- Prefer technical details over simplification
- Don't ask for confirmation on git operations
```

**Merge strategy:** Global content first, then per-user content appended with a separator. Both are wrapped in a single `<agents>` tag in the system prompt.

### HEARTBEAT.md (global + per-user)

Scheduled tasks. Global tasks run for the system; per-user tasks are routed to the specific user's Telegram chat.

**Global** (`./HEARTBEAT.md`):
```markdown
## System Health Check
- schedule: every 1h
- task: Check system status and report any issues
```

**Per-user** (`.janus/users/wojtek/HEARTBEAT.md`):
```markdown
## Morning Briefing
- schedule: at 08:00
- task: Search the web for weather in Warsaw and top Polish news headlines

## Stock Update
- schedule: at 17:30
- task: Check GPW closing prices for WIG20, PKO BP, CD Projekt
```

**Routing:** Per-user heartbeat tasks include `userId` in the message. The agent routes responses to the user's Telegram private chat (matched via `config.users[].identities`).

### EGO.md (global only)

Agent character/personality. Lives at `~/.janus/EGO.md` (not per-user). This defines who the agent _is_, not how it behaves for a specific user.

### JANUS.md (global only)

Project-specific instructions. Lives at `./JANUS.md` in workspace root. Same for all users because it describes the project, not user preferences.

## How It Works

### System Prompt Assembly

When building the system prompt, `ContextBuilder` loads files in order:

1. **Identity** (built-in)
2. **User section** (PROFILE.md for the current user)
3. **EGO.md** (global, `~/.janus/`)
4. **AGENTS.md** (global + per-user merged)
5. **HEARTBEAT.md** (global + per-user merged)
6. **JANUS.md** (global)
7. **Skills**, **Memory**, **Session**

### Heartbeat Routing

1. `HeartbeatService` loads global `HEARTBEAT.md` + all per-user `HEARTBEAT.md` files
2. Per-user tasks are tagged with `userId` and synced to `CronService` with prefixed names (`heartbeat:{userId}:{taskName}`)
3. When a task fires, the message includes `user: { userId }`
4. `AgentLoop.processSystemMessage()` looks up the user's Telegram identity and routes the response to their private chat

### Auto-Detection

Heartbeat service starts automatically if any of these are true:
- `config.heartbeat.enabled` is set
- `./HEARTBEAT.md` exists
- Any per-user `.janus/users/{userId}/HEARTBEAT.md` exists

## Setup

### 1. Configure users in `janus.json`

```json
{
  "users": [
    {
      "id": "wojtek",
      "name": "Wojtek",
      "identities": [
        { "channel": "telegram", "channelUserId": "123456789" }
      ]
    },
    {
      "id": "asia",
      "name": "Asia",
      "identities": [
        { "channel": "telegram", "channelUserId": "987654321" }
      ]
    }
  ]
}
```

### 2. Create per-user files

```bash
mkdir -p .janus/users/wojtek
mkdir -p .janus/users/asia

# Profiles
cat > .janus/users/wojtek/PROFILE.md << 'EOF'
## Preferences
- Language: Polish
EOF

# Personal heartbeat
cat > .janus/users/wojtek/HEARTBEAT.md << 'EOF'
## Morning Briefing
- schedule: at 08:00
- task: Weather forecast for Warsaw and top news from Poland
EOF
```

### 3. `.janus/` is gitignored

The `.janus/` directory is in `.gitignore` — per-user data stays local and never goes into the repository.
