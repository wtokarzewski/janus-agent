#!/usr/bin/env python3
"""
Centralized configuration for stock-watcher skill.
All scripts import paths from here to avoid desync.
"""
import os
import re

WATCHLIST_DIR = os.path.expanduser("~/.janus/stock-watcher")
WATCHLIST_FILE = os.path.join(WATCHLIST_DIR, "watchlist.txt")

# Ensure directory exists
os.makedirs(WATCHLIST_DIR, exist_ok=True)

# Ticker validation: 1-10 alphanumeric chars, optional :EXCHANGE suffix
TICKER_PATTERN = re.compile(r"^[A-Za-z0-9]{1,10}(:[A-Za-z]{2,10})?$")

# Google Finance base URL
GOOGLE_FINANCE_URL = "https://www.google.com/finance/quote"


def validate_ticker(ticker: str) -> str:
    """Validate and return sanitized ticker, or raise ValueError."""
    ticker = ticker.strip().upper()
    if not TICKER_PATTERN.match(ticker):
        raise ValueError(
            f"Invalid ticker: '{ticker}'. Expected format: AAPL or CDR:WSE"
        )
    return ticker
