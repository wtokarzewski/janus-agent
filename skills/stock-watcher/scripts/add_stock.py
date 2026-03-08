#!/usr/bin/env python3
"""
Add stock to watchlist.
Usage: python3 add_stock.py <ticker> [stock_name]
"""
import sys
import os
import requests
from bs4 import BeautifulSoup
from config import WATCHLIST_FILE, GOOGLE_FINANCE_URL, validate_ticker

REQUEST_TIMEOUT = 10

# Default exchange mapping for common tickers
DEFAULT_EXCHANGES = {
    "NASDAQ": ["AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "TSLA", "NVDA", "NFLX"],
}


def guess_google_url(ticker: str) -> str:
    """Build Google Finance URL for a ticker."""
    if ":" in ticker:
        symbol, exchange = ticker.split(":", 1)
        return f"{GOOGLE_FINANCE_URL}/{symbol}:{exchange}"
    # Try NASDAQ first, then NYSE — Google redirects anyway
    return f"{GOOGLE_FINANCE_URL}/{ticker}:NASDAQ"


def get_stock_name(ticker: str) -> str | None:
    """Get stock name from Google Finance."""
    try:
        url = guess_google_url(ticker)
        response = requests.get(url, timeout=REQUEST_TIMEOUT)
        response.encoding = "utf-8"

        if response.status_code == 200:
            soup = BeautifulSoup(response.text, "html.parser")
            # Google Finance puts the company name in the first h1 or specific div
            heading = soup.find("div", class_="zzDege")
            if heading:
                return heading.get_text().strip()
            # Fallback: try title
            title = soup.find("title")
            if title:
                text = title.get_text()
                # Title format: "AAPL Stock Price - Apple Inc" or similar
                if "-" in text:
                    return text.split("-")[0].strip()
    except (requests.RequestException, ValueError):
        pass
    return None


def sanitize_name(name: str) -> str:
    """Remove pipe and newline chars to prevent watchlist format corruption."""
    return name.replace("|", " ").replace("\n", " ").replace("\r", "").strip()


def add_stock(ticker: str, stock_name: str | None = None) -> bool:
    """Add stock to watchlist."""
    ticker = validate_ticker(ticker)

    if not stock_name:
        stock_name = get_stock_name(ticker)
        if not stock_name:
            stock_name = ticker  # fallback
    stock_name = sanitize_name(stock_name)

    # Read existing watchlist
    existing_stocks: list[str] = []
    if os.path.exists(WATCHLIST_FILE):
        with open(WATCHLIST_FILE, "r", encoding="utf-8") as f:
            existing_stocks = [line.strip() for line in f if line.strip()]

    # Check duplicate
    for existing in existing_stocks:
        if existing.startswith(f"{ticker}|"):
            print(f"{ticker} already in watchlist")
            return False

    existing_stocks.append(f"{ticker}|{stock_name}")

    with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
        for stock in existing_stocks:
            f.write(stock + "\n")

    print(f"Added {ticker} ({stock_name}) to watchlist")
    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 add_stock.py <ticker> [stock_name]")
        sys.exit(1)

    try:
        t = sys.argv[1]
        n = sys.argv[2] if len(sys.argv) > 2 else None
        add_stock(t, n)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
