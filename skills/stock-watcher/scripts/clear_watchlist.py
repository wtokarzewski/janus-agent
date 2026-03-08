#!/usr/bin/env python3
"""
Clear the entire watchlist.
Usage: python3 clear_watchlist.py
"""
import os
from config import WATCHLIST_FILE, WATCHLIST_DIR


def clear_watchlist() -> None:
    """Clear the entire watchlist."""
    os.makedirs(WATCHLIST_DIR, exist_ok=True)

    with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
        pass

    print("Watchlist cleared.")


if __name__ == "__main__":
    clear_watchlist()
