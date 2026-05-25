"""Lazy `du -sh` with a 5-minute in-memory cache.

Backs /api/disk/<issue>/<repo>. `du` is slow on big trees (the
worktree contains the repo history + node_modules + build output),
so we cache for DISK_CACHE_TTL. No other awlib deps.
"""
from __future__ import annotations

import subprocess
import time
from datetime import datetime
from pathlib import Path

DISK_CACHE: dict[str, tuple[float, str]] = {}
DISK_CACHE_TTL = 5 * 60   # `du -sh` is slow on big trees; 5 min is plenty


def disk_usage(wt: Path) -> dict:
    """Return {size, computed_at} via `du -sh`. Cached for DISK_CACHE_TTL."""
    key = str(wt)
    now = time.time()
    cached = DISK_CACHE.get(key)
    if cached and (now - cached[0]) < DISK_CACHE_TTL:
        size = cached[1]
        return {
            "size": size,
            "computed_at": datetime.fromtimestamp(cached[0]).strftime("%H:%M:%S"),
        }
    if not wt.is_dir():
        return {"size": "—", "computed_at": None}
    try:
        out = subprocess.run(
            ["du", "-sh", str(wt)],
            capture_output=True, text=True, check=False, timeout=30,
        )
        size = out.stdout.split("\t", 1)[0].strip() if out.stdout else "?"
    except Exception:  # noqa: BLE001
        size = "?"
    DISK_CACHE[key] = (now, size)
    return {
        "size": size,
        "computed_at": datetime.fromtimestamp(now).strftime("%H:%M:%S"),
    }
