#!/usr/bin/env python3
"""
Remove stock from watchlist.
Usage: python3 remove_stock.py --user <userId> <ticker>
"""
import argparse
import sys
import os
from config import watchlist_paths, validate_ticker


def remove_stock(ticker: str, watchlist_file: str) -> bool:
    """Remove stock from watchlist."""
    ticker = validate_ticker(ticker)

    if not os.path.exists(watchlist_file):
        print("Watchlist is empty.")
        return False

    with open(watchlist_file, "r", encoding="utf-8") as f:
        existing = [line.strip() for line in f if line.strip()]

    updated = [s for s in existing if not s.startswith(f"{ticker}|")]

    if len(updated) == len(existing):
        print(f"{ticker} not found in watchlist")
        return False

    with open(watchlist_file, "w", encoding="utf-8") as f:
        for stock in updated:
            f.write(stock + "\n")

    print(f"Removed {ticker} from watchlist")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Remove stock from watchlist")
    parser.add_argument("--user", required=True, help="Janus user ID")
    parser.add_argument("ticker", help="Stock ticker to remove (e.g. AAPL or CDR:WSE)")
    args = parser.parse_args()

    try:
        _watchlist_dir, watchlist_file = watchlist_paths(args.user)
        remove_stock(args.ticker, watchlist_file)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
