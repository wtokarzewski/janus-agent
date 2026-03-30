---
name: google-workspace
description: "Google Workspace: Gmail, Calendar, Drive, Contacts, Sheets, Docs. Use when the user asks about email, calendar events, files on Drive, contacts, spreadsheets, or documents."
version: "2.0.0"
always: false
---

# Google Workspace (via gws)

Use `npx gws` for all Google Workspace operations. Run commands via `exec`.
The `gws` binary is bundled as an optional dependency — no global install needed.

The CLI dynamically discovers all Google Workspace APIs via Google Discovery Service — when Google adds an endpoint, `gws` picks it up automatically.

## Setup (one-time)

Run `npx gws auth login -s drive,gmail,calendar,sheets,docs,contacts` — this opens a browser for Google OAuth consent. Only needed once; credentials are stored encrypted at `~/.config/gws/`.

For headless/Docker: export credentials from a machine with a browser, then set env var on the server:
```bash
# Machine with browser:
npx gws auth export --unmasked > credentials.json

# Server:
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json
```

## CLI Syntax

```bash
npx gws <service> <resource> <method> --params '{"key": "val"}' --json '{"key": "val"}'
```

Key flags:
| Flag | Description |
|------|-------------|
| `--params '{...}'` | URL/query parameters |
| `--json '{...}'` | Request body |
| `--dry-run` | Preview request without executing |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages (default: 10) |
| `-o, --output <PATH>` | Save binary response to file |
| `--upload <PATH>` | Upload file (multipart) |

Discover any method's schema:
```bash
npx gws schema <service>.<resource>.<method>
```

## Gmail

```bash
# Triage — unread inbox summary
npx gws gmail +triage

# Search messages
npx gws gmail users messages list --params '{"q": "newer_than:7d", "maxResults": 10}'
npx gws gmail users messages list --params '{"q": "from:amazon.com subject:order", "maxResults": 5}'

# Read a message
npx gws gmail +read --message-id <messageId>

# Send plain text
npx gws gmail +send --to recipient@example.com --subject "Subject" --body "Message"

# Send multi-line (heredoc via exec)
npx gws gmail +send --to recipient@example.com --subject "Subject" --body-file - <<'EOF'
Hi,

Message body here.

Regards
EOF

# Send HTML
npx gws gmail +send --to a@b.com --subject "Hi" --body "<p>Hello</p>" --html

# Send with attachment
npx gws gmail +send --to a@b.com --subject "Report" --body "See attached" -a report.pdf

# Draft
npx gws gmail +send --to a@b.com --subject "Hi" --body "Draft text" --draft

# Reply (handles threading automatically)
npx gws gmail +reply --message-id <messageId> --body "Reply text"

# Reply all
npx gws gmail +reply-all --message-id <messageId> --body "Reply text"

# Forward
npx gws gmail +forward --message-id <messageId> --to other@example.com

# Watch for new emails (streaming NDJSON)
npx gws gmail +watch
```

## Calendar

```bash
# Show upcoming events (uses Google account timezone)
npx gws calendar +agenda

# Show today's agenda in specific timezone
npx gws calendar +agenda --today --timezone Europe/Warsaw

# Create event
npx gws calendar +insert --summary "Meeting" --start 2026-03-10T10:00:00 --end 2026-03-10T11:00:00

# List events (raw API)
npx gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-03-08T00:00:00Z", "timeMax": "2026-03-15T00:00:00Z"}'

# Update event
npx gws calendar events patch --params '{"calendarId": "primary", "eventId": "<eventId>"}' --json '{"summary": "New Title"}'

# Delete event
npx gws calendar events delete --params '{"calendarId": "primary", "eventId": "<eventId>"}'

# Free/busy query
npx gws calendar freebusy query --json '{"timeMin": "2026-03-10T00:00:00Z", "timeMax": "2026-03-10T23:59:59Z", "items": [{"id": "primary"}]}'

# Show available colors
npx gws calendar colors get
```

## Drive

```bash
# Search files
npx gws drive files list --params '{"q": "name contains '\''budget 2026'\''", "pageSize": 10}'

# List files in folder
npx gws drive files list --params '{"q": "'\''<folderId>'\'' in parents", "pageSize": 20}'

# Upload file
npx gws drive +upload ./report.pdf --name "Q1 Report"

# Download file
npx gws drive files get --params '{"fileId": "<fileId>", "alt": "media"}' -o ./downloaded.pdf

# Create folder
npx gws drive files create --json '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'

# Share file
npx gws drive permissions create --params '{"fileId": "<fileId>"}' --json '{"role": "reader", "type": "user", "emailAddress": "user@example.com"}'
```

## Contacts

```bash
# Search contacts
npx gws people people searchContacts --params '{"query": "Jan Kowalski", "readMask": "names,emailAddresses,phoneNumbers"}'

# List contacts
npx gws people people connections list --params '{"resourceName": "people/me", "personFields": "names,emailAddresses,phoneNumbers", "pageSize": 20}'

# Search directory (Workspace)
npx gws people people searchDirectoryPeople --params '{"query": "Jan", "readMask": "names,emailAddresses", "sources": ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"]}'

# Create contact
npx gws people people createContact --json '{"names": [{"givenName": "Jan", "familyName": "Kowalski"}], "emailAddresses": [{"value": "jan@example.com"}]}'
```

## Sheets

```bash
# Read cells
npx gws sheets +read --spreadsheet <spreadsheetId> --range "Sheet1!A1:D10"

# Append row
npx gws sheets +append --spreadsheet <spreadsheetId> --values "Alice,95,Pass"

# Write cells (raw API)
npx gws sheets spreadsheets values update \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:B2", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name","Value"],["a","1"]]}'

# Clear range
npx gws sheets spreadsheets values clear \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A2:Z"}'

# Get spreadsheet metadata
npx gws sheets spreadsheets get --params '{"spreadsheetId": "<id>"}'

# Create spreadsheet
npx gws sheets spreadsheets create --json '{"properties": {"title": "Q1 Budget"}}'
```

**Shell tip:** Sheet ranges use `!` which zsh interprets as history expansion. Use double quotes:
```bash
npx gws sheets +read --spreadsheet ID --range "Sheet1!A1:D10"
```

## Docs

```bash
# Read document
npx gws docs documents get --params '{"documentId": "<docId>"}'

# Create document
npx gws docs documents create --json '{"title": "New Document"}'

# Append text
npx gws docs +write --document-id <docId> --text "Hello, world!"
```

## Workflow Helpers

```bash
# Morning standup summary (today's meetings + open tasks)
npx gws workflow +standup-report

# Prepare for next meeting (agenda, attendees, linked docs)
npx gws workflow +meeting-prep

# Weekly digest (this week's meetings + unread email count)
npx gws workflow +weekly-digest

# Convert email to task
npx gws workflow +email-to-task --message-id <messageId>

# Announce a Drive file in Chat space
npx gws workflow +file-announce --file-id <fileId> --space <spaceId>
```

## Rules

- Always confirm before sending email or creating/modifying events.
- Use `--dry-run` for destructive operations when possible.
- Use `npx gws schema <service>.<resource>.<method>` to discover parameters for any API method.
- JSON values in `--params` and `--json` must be wrapped in single quotes for shell escaping.
- Use ISO 8601 format for all dates/times.
- Use `--page-all` for large result sets.
