---
name: google-workspace
description: "Google Workspace: Gmail, Calendar, Drive, Contacts, Sheets, Docs. Use when the user asks about email, calendar events, files on Drive, contacts, spreadsheets, or documents."
version: "2.0.0"
requires:
  bins: [gws]
always: false
---

# Google Workspace (via gws)

Use `gws` CLI (googleworkspace/cli) for all Google Workspace operations. Run commands via `exec`.

The CLI dynamically discovers all Google Workspace APIs via Google Discovery Service — when Google adds an endpoint, `gws` picks it up automatically.

## Setup (one-time)

### Install gws

- **macOS**: `brew install googleworkspace-cli`
- **npm** (all platforms): `npm install -g @googleworkspace/cli`
- **From source**: `cargo install --git https://github.com/googleworkspace/cli --locked`

### Configure OAuth

Interactive (creates GCP project automatically if `gcloud` is installed):
```bash
gws auth setup
gws auth login -s drive,gmail,calendar,sheets,docs,contacts
```

Manual (no gcloud):
1. Create OAuth Desktop client at https://console.cloud.google.com/apis/credentials
2. Download `client_secret.json` to `~/.config/gws/client_secret.json`
3. Add yourself as test user in OAuth consent screen
4. Run `gws auth login`

Headless / Docker:
```bash
# On host with browser:
gws auth login
gws auth export --unmasked > credentials.json

# In container:
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json
```

Set env vars in `.env` if needed:
```
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json
```

## CLI Syntax

```bash
gws <service> <resource> <method> --params '{"key": "val"}' --json '{"key": "val"}'
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
gws schema <service>.<resource>.<method>
```

## Gmail

```bash
# Triage — unread inbox summary
gws gmail +triage

# Search messages
gws gmail users messages list --params '{"q": "newer_than:7d", "maxResults": 10}'
gws gmail users messages list --params '{"q": "from:amazon.com subject:order", "maxResults": 5}'

# Read a message
gws gmail +read --message-id <messageId>

# Send plain text
gws gmail +send --to recipient@example.com --subject "Subject" --body "Message"

# Send multi-line (heredoc via exec)
gws gmail +send --to recipient@example.com --subject "Subject" --body-file - <<'EOF'
Hi,

Message body here.

Regards
EOF

# Send HTML
gws gmail +send --to a@b.com --subject "Hi" --body "<p>Hello</p>" --html

# Send with attachment
gws gmail +send --to a@b.com --subject "Report" --body "See attached" -a report.pdf

# Draft
gws gmail +send --to a@b.com --subject "Hi" --body "Draft text" --draft

# Reply (handles threading automatically)
gws gmail +reply --message-id <messageId> --body "Reply text"

# Reply all
gws gmail +reply-all --message-id <messageId> --body "Reply text"

# Forward
gws gmail +forward --message-id <messageId> --to other@example.com

# Watch for new emails (streaming NDJSON)
gws gmail +watch
```

## Calendar

```bash
# Show upcoming events (uses Google account timezone)
gws calendar +agenda

# Show today's agenda in specific timezone
gws calendar +agenda --today --timezone Europe/Warsaw

# Create event
gws calendar +insert --summary "Meeting" --start 2026-03-10T10:00:00 --end 2026-03-10T11:00:00

# List events (raw API)
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2026-03-08T00:00:00Z", "timeMax": "2026-03-15T00:00:00Z"}'

# Update event
gws calendar events patch --params '{"calendarId": "primary", "eventId": "<eventId>"}' --json '{"summary": "New Title"}'

# Delete event
gws calendar events delete --params '{"calendarId": "primary", "eventId": "<eventId>"}'

# Free/busy query
gws calendar freebusy query --json '{"timeMin": "2026-03-10T00:00:00Z", "timeMax": "2026-03-10T23:59:59Z", "items": [{"id": "primary"}]}'

# Show available colors
gws calendar colors get
```

## Drive

```bash
# Search files
gws drive files list --params '{"q": "name contains '\''budget 2026'\''", "pageSize": 10}'

# List files in folder
gws drive files list --params '{"q": "'\''<folderId>'\'' in parents", "pageSize": 20}'

# Upload file
gws drive +upload ./report.pdf --name "Q1 Report"

# Download file
gws drive files get --params '{"fileId": "<fileId>", "alt": "media"}' -o ./downloaded.pdf

# Create folder
gws drive files create --json '{"name": "New Folder", "mimeType": "application/vnd.google-apps.folder"}'

# Share file
gws drive permissions create --params '{"fileId": "<fileId>"}' --json '{"role": "reader", "type": "user", "emailAddress": "user@example.com"}'
```

## Contacts

```bash
# Search contacts
gws people people searchContacts --params '{"query": "Jan Kowalski", "readMask": "names,emailAddresses,phoneNumbers"}'

# List contacts
gws people people connections list --params '{"resourceName": "people/me", "personFields": "names,emailAddresses,phoneNumbers", "pageSize": 20}'

# Search directory (Workspace)
gws people people searchDirectoryPeople --params '{"query": "Jan", "readMask": "names,emailAddresses", "sources": ["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"]}'

# Create contact
gws people people createContact --json '{"names": [{"givenName": "Jan", "familyName": "Kowalski"}], "emailAddresses": [{"value": "jan@example.com"}]}'
```

## Sheets

```bash
# Read cells
gws sheets +read --spreadsheet <spreadsheetId> --range "Sheet1!A1:D10"

# Append row
gws sheets +append --spreadsheet <spreadsheetId> --values "Alice,95,Pass"

# Write cells (raw API)
gws sheets spreadsheets values update \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:B2", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name","Value"],["a","1"]]}'

# Clear range
gws sheets spreadsheets values clear \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A2:Z"}'

# Get spreadsheet metadata
gws sheets spreadsheets get --params '{"spreadsheetId": "<id>"}'

# Create spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Q1 Budget"}}'
```

**Shell tip:** Sheet ranges use `!` which zsh interprets as history expansion. Use double quotes:
```bash
gws sheets +read --spreadsheet ID --range "Sheet1!A1:D10"
```

## Docs

```bash
# Read document
gws docs documents get --params '{"documentId": "<docId>"}'

# Create document
gws docs documents create --json '{"title": "New Document"}'

# Append text
gws docs +write --document-id <docId> --text "Hello, world!"
```

## Workflow Helpers

```bash
# Morning standup summary (today's meetings + open tasks)
gws workflow +standup-report

# Prepare for next meeting (agenda, attendees, linked docs)
gws workflow +meeting-prep

# Weekly digest (this week's meetings + unread email count)
gws workflow +weekly-digest

# Convert email to task
gws workflow +email-to-task --message-id <messageId>

# Announce a Drive file in Chat space
gws workflow +file-announce --file-id <fileId> --space <spaceId>
```

## Rules

- Always confirm before sending email or creating/modifying events.
- Use `--dry-run` for destructive operations when possible.
- Use `gws schema <service>.<resource>.<method>` to discover parameters for any API method.
- JSON values in `--params` and `--json` must be wrapped in single quotes for shell escaping.
- Use ISO 8601 format for all dates/times.
- Use `--page-all` for large result sets.
