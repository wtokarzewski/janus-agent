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


def summarize_performance(watchlist_file: str) -> tuple[int, int]:
    """Summarize performance of all stocks in watchlist.

    Returns:
        (attempted, failed) counts of valid tickers whose fetch was attempted,
        and how many of those failed.
    """
    if not os.path.exists(watchlist_file):
        print("Watchlist is empty.")
        return 0, 0

    with open(watchlist_file, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]

    if not lines:
        print("Watchlist is empty.")
        return 0, 0

    attempted = 0
    failed = 0

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

        attempted += 1
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
            failed += 1
            print(f"{ticker} ({name}): fetch failed")

        time.sleep(RATE_LIMIT_SECONDS)

    return attempted, failed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Summarize performance of watchlist stocks")
    parser.add_argument("--user", required=True, help="Janus user ID")
    args = parser.parse_args()

    try:
        _watchlist_dir, watchlist_file = watchlist_paths(args.user)
        attempted, failed = summarize_performance(watchlist_file)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if failed > 0:
        print(
            f"WARNING: {failed}/{attempted} tickers failed to fetch — the quote source "
            "may be down; do not report prices for them.",
            file=sys.stderr,
        )

    if attempted > 0 and failed == attempted:
        sys.exit(1)
