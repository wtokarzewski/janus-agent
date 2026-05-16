#!/usr/bin/env python3
"""
Clear the entire watchlist.
Usage: python3 clear_watchlist.py --user <userId>
"""
import argparse
import os
import sys
from config import watchlist_paths


def clear_watchlist(watchlist_dir: str, watchlist_file: str) -> None:
    """Clear the entire watchlist."""
    os.makedirs(watchlist_dir, exist_ok=True)

    with open(watchlist_file, "w", encoding="utf-8") as f:
        pass

    print("Watchlist cleared.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clear the entire watchlist")
    parser.add_argument("--user", required=True, help="Janus user ID")
    args = parser.parse_args()

    try:
        watchlist_dir, watchlist_file = watchlist_paths(args.user)
        clear_watchlist(watchlist_dir, watchlist_file)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
