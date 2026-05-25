"""Small date-arithmetic helpers used across the codebase. Both
return -1 on parse failure so callers don't have to remember to
catch ValueError.
"""
from __future__ import annotations

from datetime import datetime, timezone


def minutes_since(ts: str | None) -> int:
    """Whole minutes between an ISO timestamp and now (UTC).
    Returns -1 on null / parse failure."""
    if not ts:
        return -1
    try:
        # Timestamps in jsonl are ISO 8601 UTC like "2026-05-07T18:30:00Z"
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return max(0, int((now - dt).total_seconds() // 60))
    except (ValueError, TypeError):
        return -1


def days_since(iso_or_str: str) -> int:
    """Whole days between an ISO date/datetime string and now.
    Returns -1 on null / parse failure."""
    if not iso_or_str:
        return -1
    try:
        # Accept either YYYY-MM-DD or full ISO
        if "T" in iso_or_str:
            dt = datetime.fromisoformat(iso_or_str.replace("Z", "+00:00"))
        else:
            dt = datetime.combine(
                datetime.fromisoformat(iso_or_str).date(),
                datetime.min.time())
    except ValueError:
        return -1
    return max(0, (datetime.now(dt.tzinfo) - dt).days)
