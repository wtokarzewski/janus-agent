#!/usr/bin/env python3
"""
Summarize performance of all stocks in the watchlist.
Uses Google Finance for data.
Usage: python3 summarize_performance.py --user <userId>
"""
import argparse
import os
import sys
import re
import time
import requests
from bs4 import BeautifulSoup
from config import watchlist_paths, GOOGLE_FINANCE_URL, validate_ticker

REQUEST_TIMEOUT = 10
RATE_LIMIT_SECONDS = 1


def guess_google_url(ticker: str) -> str:
    """Build Google Finance URL for a ticker."""
    if ":" in ticker:
        symbol, exchange = ticker.split(":", 1)
        return f"{GOOGLE_FINANCE_URL}/{symbol}:{exchange}"
    return f"{GOOGLE_FINANCE_URL}/{ticker}:NASDAQ"


def fetch_stock_data(ticker: str) -> dict | None:
    """Fetch stock data from Google Finance."""
    url = guess_google_url(ticker)

    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT)
        response.encoding = "utf-8"

        if response.status_code != 200:
            return None

        soup = BeautifulSoup(response.text, "html.parser")

        # Extract price and change from Google Finance page
        price = None
        change = None

        # Google Finance uses specific data attributes and classes
        # Look for price in the main price display
        price_el = soup.find("div", class_="YMlKec fxKbKc")
        if price_el:
            price = price_el.get_text().strip()

        # Look for change percentage
        change_el = soup.find("div", class_="JwB6zf")
        if change_el:
            change = change_el.get_text().strip()

        # Fallback: parse percentages from text
        if not change:
            text = soup.get_text()
            pcts = re.findall(r"[-+]?\d+\.?\d*%", text)
            if pcts:
                change = pcts[0]

        return {
            "ticker": ticker,
            "url": url,
            "price": price,
            "change": change,
        }

    except (requests.RequestException, ValueError) as e:
        print(f"Error fetching {ticker}: {e}", file=sys.stderr)
        return None


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
        data = fetch_stock_data(ticker)

        if data and (data["price"] or data["change"]):
            price_str = data["price"] or "N/A"
            change_str = data["change"] or "N/A"
            print(f"{ticker} ({name}): {price_str} ({change_str})")
        elif data:
            print(f"{ticker} ({name}): no data available")
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
