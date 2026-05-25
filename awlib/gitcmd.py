"""Thin wrappers around `git -C <wt> <args>` used throughout the
dashboard. Both wrappers swallow FileNotFoundError so `git` not being
on PATH doesn't crash the server, and neither raises on non-zero
exit — they just return the captured stdout (possibly empty).

_git strips trailing whitespace; _git_raw preserves the leading
space in `git status --porcelain` output, which is meaningful
(' M path' = unstaged modified). Pick whichever fits the call site.

upstream_for returns origin's HEAD ref or falls back to
origin/master.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def _git(wt: Path, *args: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(wt), *args],
            capture_output=True, text=True, check=False,
        )
        return out.stdout.strip()
    except FileNotFoundError:
        return ""


def _git_raw(wt: Path, *args: str) -> str:
    """Variant of _git that preserves leading whitespace — needed for
    `git status --porcelain` where the first column being a space
    (' M path' = unstaged modified) is meaningful. _git's `.strip()` would
    silently chop the leading space and corrupt the path parser."""
    try:
        out = subprocess.run(
            ["git", "-C", str(wt), *args],
            capture_output=True, text=True, check=False,
        )
        return out.stdout.rstrip("\n")
    except FileNotFoundError:
        return ""


def upstream_for(wt: Path) -> str:
    """Resolve origin's HEAD ref (e.g. origin/master), fall back to origin/master."""
    out = _git(wt, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    return out if out else "origin/master"
