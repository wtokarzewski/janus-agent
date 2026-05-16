#!/usr/bin/env python3
"""
Centralized configuration for stock-watcher skill.
All scripts import paths from here to avoid desync.
"""
import os
import re

# Ticker validation: 1-10 alphanumeric chars, optional :EXCHANGE suffix
TICKER_PATTERN = re.compile(r"^[A-Za-z0-9]{1,10}(:[A-Za-z]{2,10})?$")

# Google Finance base URL
GOOGLE_FINANCE_URL = "https://www.google.com/finance/quote"

# User ID validation: alphanumeric, underscore, hyphen
_USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def watchlist_paths(user_id: str, workspace_dir: str | None = None) -> tuple[str, str]:
    """Return (watchlist_dir, watchlist_file) for the given user.

    Args:
        user_id: The Janus user ID (required).
        workspace_dir: Workspace root. Defaults to JANUS_WORKSPACE_DIR env var
                       or the current working directory.

    Returns:
        A tuple of (directory, file_path) for the user's watchlist.

    Raises:
        ValueError: If user_id is empty or contains invalid characters.
    """
    if not user_id:
        raise ValueError("--user <userId> is required")
    if not _USER_ID_PATTERN.fullmatch(user_id):
        raise ValueError(f"Invalid user id: {user_id!r}")
    workspace = workspace_dir or os.environ.get("JANUS_WORKSPACE_DIR") or os.getcwd()
    directory = os.path.join(workspace, ".janus", "users", user_id, "files", "stocks")
    return directory, os.path.join(directory, "watchlist.txt")


def validate_ticker(ticker: str) -> str:
    """Validate and return sanitized ticker, or raise ValueError."""
    ticker = ticker.strip().upper()
    if not TICKER_PATTERN.match(ticker):
        raise ValueError(
            f"Invalid ticker: '{ticker}'. Expected format: AAPL or CDR:WSE"
        )
    return ticker
