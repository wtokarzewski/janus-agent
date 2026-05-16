#!/usr/bin/env python3
"""
List all stocks in the watchlist.
Usage: python3 list_stocks.py --user <userId>
"""
import argparse
import os
import sys
from config import watchlist_paths


def list_stocks(watchlist_file: str) -> None:
    """List all stocks in the watchlist."""
    if not os.path.exists(watchlist_file):
        print("Watchlist is empty.")
        return

    with open(watchlist_file, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip()]

    if not lines:
        print("Watchlist is empty.")
        return

    print("Stock Watchlist:")
    print("-" * 40)
    for i, line in enumerate(lines, 1):
        parts = line.split("|")
        if len(parts) == 2:
            code, name = parts
            print(f"{i}. {code} - {name}")
        else:
            print(f"{i}. {line}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="List stocks in watchlist")
    parser.add_argument("--user", required=True, help="Janus user ID")
    args = parser.parse_args()

    try:
        _watchlist_dir, watchlist_file = watchlist_paths(args.user)
        list_stocks(watchlist_file)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
