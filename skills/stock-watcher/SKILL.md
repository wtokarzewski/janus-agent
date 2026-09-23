---
name: stock-watcher
description: "Stock watchlist management — add, remove, list stocks and get performance summaries. Use when user wants to track stocks, check prices, or manage their watchlist."
version: "2.1.0"
requires:
  bins: [python3]
always: false
pinned:
  - stocks/watchlist.txt
---

# Stock Watcher

Manage a personal stock watchlist with performance tracking via Yahoo Finance.

## Setup

Install Python dependencies (one-time):
```bash
pip3 install requests
```

## Storage

Watchlist stored per-user at `.janus/users/{userId}/files/stocks/watchlist.txt`.
Format: `ticker|stock_name` (one per line).

The watchlist is automatically loaded into your context as `<pinned_skill_state>` —
you do NOT need to call `list_stocks.py` to see what's tracked. Read from
`<pinned_skill_state>` instead.

## Scripts

All scripts are in the `scripts/` subdirectory of this skill. Run via `exec`.
Every script requires `--user {userId}` — substitute the actual user ID when calling.

### Add stock
```bash
python3 scripts/add_stock.py --user {userId} <ticker> [stock_name]
# Example: python3 scripts/add_stock.py --user {userId} AAPL "Apple Inc"
# Example: python3 scripts/add_stock.py --user {userId} CDR:WSE
```

### List watchlist
```bash
python3 scripts/list_stocks.py --user {userId}
```

### Remove stock
```bash
python3 scripts/remove_stock.py --user {userId} <ticker>
```

### Clear watchlist
```bash
python3 scripts/clear_watchlist.py --user {userId}
```

### Performance summary
```bash
python3 scripts/summarize_performance.py --user {userId}
```

## Data Source

- Yahoo Finance chart API: `https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}`
- Ticker → Yahoo symbol mapping:
  - `TICKER:WSE` → `TICKER.WA`
  - `TICKER:NASDAQ` / `TICKER:NYSE` → `TICKER`
  - Bare `TICKER` (no exchange) → tries `TICKER`, then `TICKER.WA`
  - Unknown `TICKER:EXCH` → tried as `TICKER.EXCH` suffix, then bare `TICKER`
- Ticker format: standard symbol (e.g., AAPL, MSFT, CDR:WSE)

### Known issues

See `KNOWN_ISSUES.md` in this skill's directory for data-source history and rejected alternatives.

## Rules

- Ticker symbols are validated (1-10 alphanumeric chars, optional :EXCHANGE suffix)
- Rate limiting: ~0.3 s between tickers (a ticker may take two requests when the exchange is guessed)
- Network errors are handled gracefully with clear messages
- Always show ticker + name in output
- **State uncertainty.** If the watchlist content is unclear, missing from `<pinned_skill_state>`,
  or contradicts what you remember: re-read it via `python3 scripts/list_stocks.py --user {userId}`
  OR ask the user. NEVER explain confusion in terms of memory, sessions, summarization,
  or other Janus internals.
- If the summary prints a WARNING or exits non-zero, say plainly that quotes are unavailable —
  never estimate or reuse old prices.
