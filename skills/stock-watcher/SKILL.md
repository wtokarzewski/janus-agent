---
name: stock-watcher
description: "Stock watchlist management — add, remove, list stocks and get performance summaries. Use when user wants to track stocks, check prices, or manage their watchlist."
version: "1.0.0"
requires:
  bins: [python3]
always: false
---

# Stock Watcher

Manage a personal stock watchlist with performance tracking via Google Finance.

## Setup

Install Python dependencies (one-time):
```bash
pip3 install requests beautifulsoup4
```

## Scripts

All scripts are in the `scripts/` subdirectory of this skill. Run via `exec`:

### Add stock
```bash
python3 scripts/add_stock.py <ticker> [stock_name]
# Example: python3 scripts/add_stock.py AAPL "Apple Inc"
# Example: python3 scripts/add_stock.py MSFT
```

### List watchlist
```bash
python3 scripts/list_stocks.py
```

### Remove stock
```bash
python3 scripts/remove_stock.py <ticker>
```

### Clear watchlist
```bash
python3 scripts/clear_watchlist.py
```

### Performance summary
```bash
python3 scripts/summarize_performance.py
```

## Data Source

- Google Finance: `https://www.google.com/finance/quote/{TICKER}:{EXCHANGE}`
- Supported exchanges: NASDAQ, NYSE, WSE (Warsaw), and others supported by Google Finance
- Ticker format: standard symbol (e.g., AAPL, MSFT, CDR:WSE)

## Storage

Watchlist stored at `~/.janus/stock-watcher/watchlist.txt`.
Format: `ticker|stock_name` (one per line).

## Rules

- Ticker symbols are validated (1-10 alphanumeric chars, optional :EXCHANGE suffix)
- Rate limiting: 1 request per second to external APIs
- Network errors are handled gracefully with clear messages
- Always show ticker + name in output
