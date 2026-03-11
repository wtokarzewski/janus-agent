---
name: github
description: "GitHub operations: manage repos, issues, PRs, CI checks, gists, and releases via gh CLI. Use when user asks about GitHub repos, issues, pull requests, or CI."
version: "1.0.0"
requires:
  bins: [gh]
always: false
---

# GitHub

Manage GitHub repositories, issues, pull requests, CI, releases, and more via the `gh` CLI.

## Setup

The `gh` CLI handles authentication natively — no API keys or tokens needed.

```bash
# Authenticate (interactive, opens browser)
gh auth login

# Verify auth status
gh auth status
```

## Usage

Call `gh` directly via the `exec` tool. Always use non-interactive flags (`--yes`, `--body` instead of editor, `--confirm` where available) since the agent cannot interact with prompts.

### Repos

```bash
# List your repos
gh repo list

# List repos for an org
gh repo list ORG --limit 50

# View current repo info
gh repo view

# View a specific repo
gh repo view OWNER/REPO

# Clone a repo
gh repo clone OWNER/REPO

# Create a new repo
gh repo create REPO --public --description "Description"
```

### Issues

```bash
# List open issues
gh issue list

# List with filters
gh issue list --state closed --label bug --assignee @me

# View an issue
gh issue view 42

# Create an issue (always use --body, never editor)
gh issue create --title "Bug title" --body "Description" --label bug

# Close an issue
gh issue close 42

# Reopen an issue
gh issue reopen 42

# Add a comment
gh issue comment 42 --body "Comment text"

# Edit an issue
gh issue edit 42 --title "New title" --add-label enhancement
```

### Pull Requests

```bash
# List open PRs
gh pr list

# View a PR
gh pr view 42

# View PR diff
gh pr diff 42

# Check CI status on a PR
gh pr checks 42

# Create a PR (always use --body, never editor)
gh pr create --title "PR title" --body "Description" --base main

# Create draft PR
gh pr create --title "WIP: feature" --body "Description" --draft

# Merge a PR (use --squash, --merge, or --rebase)
gh pr merge 42 --squash --delete-branch

# Review a PR
gh pr review 42 --approve
gh pr review 42 --request-changes --body "Needs fix"
gh pr review 42 --comment --body "Looks good overall"

# Checkout a PR locally
gh pr checkout 42
```

### CI / Workflow Runs

```bash
# List recent workflow runs
gh run list

# List runs for a specific workflow
gh run list --workflow build.yml

# View a run
gh run view 12345

# View run logs
gh run view 12345 --log

# Watch a run in progress
gh run watch 12345

# Re-run a failed run
gh run rerun 12345

# Trigger a workflow dispatch
gh workflow run build.yml --ref main
```

### Releases

```bash
# List releases
gh release list

# View latest release
gh release view --latest

# Create a release
gh release create v1.0.0 --title "v1.0.0" --notes "Release notes here"

# Create release from tag with auto-generated notes
gh release create v1.0.0 --generate-notes

# Upload assets to a release
gh release upload v1.0.0 dist/*.tar.gz
```

### Gists

```bash
# List your gists
gh gist list

# Create a gist
gh gist create file.txt --desc "Description" --public

# View a gist
gh gist view GIST_ID

# Edit a gist
gh gist edit GIST_ID --add newfile.txt
```

### Search

```bash
# Search repos
gh search repos "query" --language typescript --sort stars

# Search issues
gh search issues "query" --repo OWNER/REPO --state open

# Search PRs
gh search prs "query" --repo OWNER/REPO --state merged

# Search code
gh search code "function_name" --repo OWNER/REPO
```

### API (Advanced)

For anything not covered by built-in commands, use `gh api` directly:

```bash
# GET request
gh api repos/OWNER/REPO

# GET with query params
gh api repos/OWNER/REPO/pulls --jq '.[].title'

# POST request
gh api repos/OWNER/REPO/issues -f title="Title" -f body="Body"

# Paginated results
gh api repos/OWNER/REPO/issues --paginate --jq '.[].title'

# GraphQL query
gh api graphql -f query='{ viewer { login } }'
```

## Output Formatting

Use `--json` and `--jq` for structured, parseable output:

```bash
# Get PR titles and states as JSON
gh pr list --json number,title,state

# Filter with jq
gh pr list --json number,title,state --jq '.[] | select(.state=="OPEN") | .title'

# Specific fields from a single item
gh issue view 42 --json title,body,labels,assignees
```

## Important Rules

- **Never use interactive flags** — always pass `--body`, `--title`, `--yes` etc. directly. The agent cannot respond to editor prompts or confirmations.
- **Prefer `--json` output** for structured data that needs further processing.
- **Use `--jq`** to filter large JSON responses down to needed fields.
- **Rate limiting**: GitHub API has rate limits (5,000 req/hour for authenticated users). For bulk operations, pace requests. If you hit a rate limit, `gh` will report it — wait and retry.
- **Repository context**: Most commands auto-detect the repo from the current git remote. Use `-R OWNER/REPO` to target a different repo.

## Troubleshooting

- **Not authenticated**: Run `gh auth login` to authenticate.
- **Permission denied**: Ensure the authenticated user has access to the repo/org.
- **Rate limited**: Wait for the reset window (usually < 1 hour) or reduce request frequency.
- **Command not found**: Install gh — `brew install gh` (macOS), `sudo apt install gh` (Linux).
