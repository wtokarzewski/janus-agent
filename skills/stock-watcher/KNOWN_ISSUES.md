# Known Issues — stock-watcher

## [FIXED 2026-09-23] Google Finance scraping broken

From EU/PL IPs, `google.com/finance` 302-redirects to `consent.google.com`. The scraper parsed the
consent page and produced fake data (identical bogus % change for every ticker, mangled prices),
later degrading to "no data available" for every ticker.

Fix: Yahoo Finance chart API — `https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}` (clean
JSON, no consent wall, no API key). Single shared fetch path: `config.fetch_yahoo_quote(ticker)`.

### Ticker → Yahoo symbol mapping

| Watchlist ticker      | Yahoo symbol tried                 |
| ---------------------- | ----------------------------------- |
| `TICKER:WSE`           | `TICKER.WA`                         |
| `TICKER:NASDAQ` / `:NYSE` | `TICKER`                         |
| bare `TICKER`          | `TICKER`, then `TICKER.WA`          |
| unknown `TICKER:EXCH`  | `TICKER.EXCH`, then `TICKER`        |

Recommend storing Warsaw tickers with an explicit `:WSE` suffix — a bare one costs a failed US
lookup first.

### Rejected alternatives

- Stooq CSV API — now requires a CAPTCHA-gated API key; the old unauthenticated endpoint returns 404.

### If Yahoo breaks

Next candidates: stockanalysis.com, or the `browser` tool (Playwright) for consent/CAPTCHA pages.
