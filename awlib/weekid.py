"""ISO week-id math. Two pure functions used by the week-summary
code paths; no other awlib deps.
"""
from __future__ import annotations

from datetime import datetime, timedelta


def iso_week_id(d: datetime | None = None) -> str:
    """ISO 'YYYY-Www' for the given date (default: today)."""
    d = d or datetime.now()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def week_bounds(week_id: str) -> tuple[str, str]:
    """(monday, sunday) ISO date strings for an ISO week id 'YYYY-Www'."""
    year, w = week_id.split("-W")
    monday = datetime.fromisocalendar(int(year), int(w), 1)
    sunday = monday + timedelta(days=6)
    return monday.date().isoformat(), sunday.date().isoformat()
