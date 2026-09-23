#!/usr/bin/env python3
"""
Add stock to watchlist.
Usage: python3 add_stock.py --user <userId> <ticker> [stock_name]
"""
import argparse
import sys
import os
from config import watchlist_paths, validate_ticker, fetch_yahoo_quote


def get_stock_name(ticker: str) -> str | None:
    """Get stock name from Yahoo Finance."""
    data = fetch_yahoo_quote(ticker)
    if data and data.get("name"):
        return data["name"]
    return None


def sanitize_name(name: str) -> str:
    """Remove pipe and newline chars to prevent watchlist format corruption."""
    return name.replace("|", " ").replace("\n", " ").replace("\r", "").strip()


def add_stock(ticker: str, watchlist_dir: str, watchlist_file: str, stock_name: str | None = None) -> bool:
    """Add stock to watchlist."""
    ticker = validate_ticker(ticker)

    if not stock_name:
        stock_name = get_stock_name(ticker)
        if not stock_name:
            stock_name = ticker  # fallback
    stock_name = sanitize_name(stock_name)

    os.makedirs(watchlist_dir, exist_ok=True)

    # Read existing watchlist
    existing_stocks: list[str] = []
    if os.path.exists(watchlist_file):
        with open(watchlist_file, "r", encoding="utf-8") as f:
            existing_stocks = [line.strip() for line in f if line.strip()]

    # Check duplicate
    for existing in existing_stocks:
        if existing.startswith(f"{ticker}|"):
            print(f"{ticker} already in watchlist")
            return False

    existing_stocks.append(f"{ticker}|{stock_name}")

    with open(watchlist_file, "w", encoding="utf-8") as f:
        for stock in existing_stocks:
            f.write(stock + "\n")

    print(f"Added {ticker} ({stock_name}) to watchlist")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Add stock to watchlist")
    parser.add_argument("--user", required=True, help="Janus user ID")
    parser.add_argument("ticker", help="Stock ticker (e.g. AAPL or CDR:WSE)")
    parser.add_argument("stock_name", nargs="?", default=None, help="Optional stock name")
    args = parser.parse_args()

    try:
        watchlist_dir, watchlist_file = watchlist_paths(args.user)
        add_stock(args.ticker, watchlist_dir, watchlist_file, args.stock_name)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
