#!/usr/bin/env python3
"""
Centralized configuration for stock-watcher skill.
All scripts import paths from here to avoid desync.
"""
import os
import re
import requests

# Ticker validation: 1-10 alphanumeric chars, optional :EXCHANGE suffix
TICKER_PATTERN = re.compile(r"^[A-Za-z0-9]{1,10}(:[A-Za-z]{2,10})?$")

# User ID validation: alphanumeric, underscore, hyphen
_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

# Yahoo Finance chart API (no consent wall, no API key needed as of 2026-08)
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}
REQUEST_TIMEOUT = 10

# Exchange suffix mapping: our watchlist format (":EXCHANGE") -> Yahoo Finance suffix
EXCHANGE_TO_YAHOO_SUFFIX = {
    "WSE": "WA",
    "NASDAQ": "",
    "NYSE": "",
}


def _candidate_yahoo_symbols(ticker: str) -> list[str]:
    """Build an ordered list of Yahoo Finance symbols to try for a ticker.

    Handles two watchlist ticker formats:
    - "TICKER:EXCHANGE" (e.g. "CBF:WSE") -> mapped via EXCHANGE_TO_YAHOO_SUFFIX
    - "TICKER" bare (e.g. "NVDA", "PZU") -> tried as-is first (covers US tickers),
      then with ".WA" appended as fallback (covers WSE tickers stored without
      an explicit exchange suffix, e.g. historical entries like "PZU").
    """
    if ":" in ticker:
        symbol, exchange = ticker.split(":", 1)
        suffix = EXCHANGE_TO_YAHOO_SUFFIX.get(exchange.upper())
        if suffix is None:
            # Unknown exchange code -- try it verbatim as a Yahoo suffix too
            return [f"{symbol}.{exchange.upper()}", symbol]
        return [f"{symbol}.{suffix}"] if suffix else [symbol]
    return [ticker, f"{ticker}.WA"]


def fetch_yahoo_quote(ticker: str) -> dict | None:
    """Fetch a live quote for `ticker` from Yahoo Finance's chart API.

    Returns a dict with keys: ticker, symbol, price, change_pct, currency, name.
    Returns None if no candidate symbol resolved to a valid quote.
    """
    for symbol in _candidate_yahoo_symbols(ticker):
        try:
            resp = requests.get(
                f"{YAHOO_CHART_URL}/{symbol}",
                timeout=REQUEST_TIMEOUT,
                headers=YAHOO_HEADERS,
            )
            if resp.status_code != 200:
                continue
            data = resp.json()
            result = data.get("chart", {}).get("result")
            if not result:
                continue
            meta = result[0].get("meta", {})
            price = meta.get("regularMarketPrice")
            prev_close = meta.get("previousClose") or meta.get("chartPreviousClose")
            if price is None:
                continue
            change_pct = None
            if prev_close:
                change_pct = (price - prev_close) / prev_close * 100
            return {
                "ticker": ticker,
                "symbol": symbol,
                "price": price,
                "change_pct": change_pct,
                "currency": meta.get("currency"),
                "name": meta.get("longName") or meta.get("shortName"),
            }
        except (requests.RequestException, ValueError):
            continue
    return None


def watchlist_paths(user_id: str, workspace_dir: str | None = None) -> tuple[str, str]:
    """Return (watchlist_dir, watchlist_file) for the given user.

    Args:
        user_id: The Janus user ID (required).
        workspace_dir: Workspace root. Defaults to JANUS_WORKSPACE_DIR env var
                       or the current working directory.

    Returns:
        A tuple of (directory, file_path) for the user's watchlist.

    Raises:
        ValueError: If user_id is empty or contains invalid characters.
    """
    if not user_id:
        raise ValueError("--user <userId> is required")
    if not _USER_ID_PATTERN.fullmatch(user_id):
        raise ValueError(f"Invalid user id: {user_id!r}")
    workspace = workspace_dir or os.environ.get("JANUS_WORKSPACE_DIR") or os.getcwd()
    directory = os.path.join(workspace, ".janus", "users", user_id, "files", "stocks")
    return directory, os.path.join(directory, "watchlist.txt")


def validate_ticker(ticker: str) -> str:
    """Validate and return sanitized ticker, or raise ValueError."""
    ticker = ticker.strip().upper()
    if not TICKER_PATTERN.match(ticker):
        raise ValueError(
            f"Invalid ticker: '{ticker}'. Expected format: AAPL or CDR:WSE"
        )
    return ticker
