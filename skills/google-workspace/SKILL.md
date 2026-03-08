---
name: google-workspace
description: "Google Workspace: Gmail, Calendar, Drive, Contacts, Sheets, Docs. Use when the user asks about email, calendar events, files on Drive, contacts, spreadsheets, or documents."
version: "1.0.0"
requires:
  bins: [gog]
always: false
---

# Google Workspace (via gogcli)

Use `gog` CLI for all Google Workspace operations. Run commands via `exec`.

## Setup (one-time)

### Install gog

- **macOS**: `brew install steipete/tap/gogcli`
- **Linux**: `curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz | tar -xz -C /usr/local/bin`
- **Docker**: Pre-installed in Janus Docker image

### Configure OAuth

1. Import credentials: `gog auth credentials /path/to/client_secret.json`
2. Add account: `gog auth add user@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
3. Verify: `gog auth list`

Set default account to avoid `--account` on every command:
```bash
export GOG_ACCOUNT=user@gmail.com
```

## Gmail

```bash
# Search (threads)
gog gmail search 'newer_than:7d' --max 10
gog gmail search 'from:amazon.com subject:order' --max 5

# Search (individual messages, ignores threading)
gog gmail messages search "in:inbox from:bank.com" --max 20

# Send plain text
gog gmail send --to recipient@example.com --subject "Subject" --body "Message"

# Send multi-line (heredoc via stdin)
gog gmail send --to recipient@example.com --subject "Subject" --body-file - <<'EOF'
Hi,

Message body here.

Regards
EOF

# Send HTML
gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"

# Draft
gog gmail drafts create --to a@b.com --subject "Hi" --body "Draft text"
gog gmail drafts send <draftId>

# Reply
gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>
```

## Calendar

```bash
# List events
gog calendar events <calendarId> --from 2026-03-08T00:00:00Z --to 2026-03-15T00:00:00Z

# Create event
gog calendar create <calendarId> --summary "Meeting" --from 2026-03-10T10:00:00Z --to 2026-03-10T11:00:00Z

# Create with color (IDs 1-11)
gog calendar create <calendarId> --summary "Lunch" --from <iso> --to <iso> --event-color 5

# Update event
gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4

# Show available colors
gog calendar colors
```

Calendar color IDs: 1=#a4bdfc, 2=#7ae7bf, 3=#dbadff, 4=#ff887c, 5=#fbd75b, 6=#ffb878, 7=#46d6db, 8=#e1e1e1, 9=#5484ed, 10=#51b749, 11=#dc2127

## Drive

```bash
# Search files
gog drive search "budget 2026" --max 10

# List files in folder
gog drive list <folderId> --max 20
```

## Contacts

```bash
gog contacts list --max 20
gog contacts search "Jan Kowalski"
```

## Sheets

```bash
# Read
gog sheets get <sheetId> "Sheet1!A1:D10" --json

# Write
gog sheets update <sheetId> "Sheet1!A1:B2" --values-json '[["Name","Value"],["a","1"]]' --input USER_ENTERED

# Append row
gog sheets append <sheetId> "Sheet1!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS

# Clear range
gog sheets clear <sheetId> "Sheet1!A2:Z"

# Metadata (tabs, row counts)
gog sheets metadata <sheetId> --json
```

## Docs

```bash
# Read document
gog docs cat <docId>

# Export to file
gog docs export <docId> --format txt --out /tmp/doc.txt
```

## Rules

- Always confirm before sending email or creating/modifying events.
- Use `--json` and `--no-input` for structured output in automation.
- `--body` does not interpret `\n` — use `--body-file -` with heredoc for multi-line.
- `gog gmail search` returns threads; use `gog gmail messages search` for individual messages.
- Use ISO 8601 format for all dates/times.
