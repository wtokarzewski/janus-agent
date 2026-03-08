#!/usr/bin/env python3
"""
Remove stock from watchlist.
Usage: python3 remove_stock.py <ticker>
"""
import sys
import os
from config import WATCHLIST_FILE, validate_ticker


def remove_stock(ticker: str) -> bool:
    """Remove stock from watchlist."""
    ticker = validate_ticker(ticker)

    if not os.path.exists(WATCHLIST_FILE):
        print("Watchlist is empty.")
        return False

    with open(WATCHLIST_FILE, "r", encoding="utf-8") as f:
        existing = [line.strip() for line in f if line.strip()]

    updated = [s for s in existing if not s.startswith(f"{ticker}|")]

    if len(updated) == len(existing):
        print(f"{ticker} not found in watchlist")
        return False

    with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
        for stock in updated:
            f.write(stock + "\n")

    print(f"Removed {ticker} from watchlist")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 remove_stock.py <ticker>")
        sys.exit(1)

    try:
        remove_stock(sys.argv[1])
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
