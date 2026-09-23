#!/usr/bin/env python3
"""
Summarize performance of all stocks in the watchlist.
Uses Yahoo Finance chart API for data (no consent wall, no API key needed).
Usage: python3 summarize_performance.py --user <userId>
"""
import argparse
import os
import sys
import time
from config import watchlist_paths, validate_ticker, fetch_yahoo_quote

RATE_LIMIT_SECONDS = 0.3


def summarize_performance(watchlist_file: str) -> None:
    """Summarize performance of all stocks in watchlist."""
    if not os.path.exists(watchlist_file):
        print("Watchlist is empty.")
        return

    with open(watchlist_file, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]

    if not lines:
        print("Watchlist is empty.")
        return

    for line in lines:
        parts = line.split("|")
        if len(parts) != 2:
            continue

        ticker, name = parts
        # Re-validate ticker read from file
        try:
            ticker = validate_ticker(ticker)
        except ValueError:
            print(f"{ticker} ({name}): invalid ticker, skipping")
            continue
        data = fetch_yahoo_quote(ticker)

        if data:
            currency = data["currency"] or ""
            price_str = f"{data['price']:.2f} {currency}".strip()
            if data["change_pct"] is not None:
                change_str = f"{data['change_pct']:+.2f}%"
            else:
                change_str = "N/A"
            print(f"{ticker} ({name}): {price_str} ({change_str})")
        else:
            print(f"{ticker} ({name}): fetch failed")

        time.sleep(RATE_LIMIT_SECONDS)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Summarize performance of watchlist stocks")
    parser.add_argument("--user", required=True, help="Janus user ID")
    args = parser.parse_args()

    try:
        _watchlist_dir, watchlist_file = watchlist_paths(args.user)
        summarize_performance(watchlist_file)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
