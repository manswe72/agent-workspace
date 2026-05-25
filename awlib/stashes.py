"""Git stash inspection across the dashboard's primary repos.

Stashes live in `<primary>/.git/refs/stash` so they're scoped per
underlying repo, not per worktree. This module walks every primary
under `--primaries`, runs `git stash list` on each, and returns a
unified view for the dashboard's General Agent → Stashes sub-tab.

Adding a stash is left to the agent (`git stash push` inside whichever
worktree is interesting). The dashboard only surfaces / inspects /
drops — the destructive surface is small and explicit.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

# stash@{N} — N is unsigned; the safety regex is used to validate
# any ref a client passes before we hand it to `git stash …`.
STASH_REF_RE = re.compile(r"^stash@\{\d+\}$")


def _git_capture(cwd: Path, *args: str, timeout: float = 5.0) -> str:
    """Run `git <args>` in `cwd` and return stdout (str). Empty string
    on any error so callers don't need to handle exceptions."""
    try:
        r = subprocess.run(["git", *args], cwd=str(cwd),
                            capture_output=True, text=True,
                            timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout if r.returncode == 0 else ""


def list_primary_repos(primaries_root: Path) -> list[str]:
    """Names of every directory under primaries_root that has a
    `.git` entry (file or dir — both are valid)."""
    if not primaries_root.is_dir():
        return []
    out: list[str] = []
    for p in sorted(primaries_root.iterdir()):
        if p.is_dir() and (p / ".git").exists():
            out.append(p.name)
    return out


def list_stashes(primaries_root: Path) -> list[dict]:
    """Walk every primary repo and collect its `git stash list`
    entries. Returns one row per stash with enough metadata for the
    dashboard's list view; the underlying repo name (`repo`) plus
    the ref string (`ref`) are the identity tuple the drop/show
    routes accept.

    Format string passed to git uses ASCII 0x1f (Unit Separator) as
    the field delimiter — it cannot appear in stash messages, branch
    names, or sha output, so the parse is robust.
    """
    out: list[dict] = []
    sep = "\x1f"
    fmt = sep.join(["%gd", "%h", "%cI", "%gs"])  # ref · hash · iso-date · subject
    for repo in list_primary_repos(primaries_root):
        primary = primaries_root / repo
        text = _git_capture(primary, "stash", "list", f"--format={fmt}")
        if not text:
            continue
        for line in text.splitlines():
            parts = line.split(sep, 3)
            if len(parts) != 4:
                continue
            ref, sha, iso, subject = parts
            # `%gs` is the reflog subject: "WIP on <branch>: <hash> <msg>"
            branch = ""
            msg = subject
            m = re.match(
                r"^(?:WIP on|On) ([^:]+): (?:[0-9a-f]+ )?(.*)$", subject)
            if m:
                branch = m.group(1)
                msg = m.group(2) or subject
            out.append({
                "repo": repo,
                "ref": ref,
                "hash": sha,
                "date": iso,
                "branch": branch,
                "message": msg,
                "subject": subject,  # raw — handy if the parse misses
            })
    # Newest-first across every repo. Without this the order would
    # be "alphabetical by repo, then newest-first within the repo",
    # which buries a recent stash under an older one from a repo
    # earlier in the alphabet. ISO-8601 sorts lexicographically.
    out.sort(key=lambda s: s.get("date") or "", reverse=True)
    return out


def show_stash(primaries_root: Path, repo: str, ref: str) -> dict:
    """Return the file-level breakdown for one stash. Body is the
    `git stash show --stat` output split into rows for the UI plus
    a one-line summary (the trailing "N files changed…" line)."""
    if not STASH_REF_RE.match(ref):
        return {"error": "invalid ref"}
    primary = primaries_root / repo
    if not (primary / ".git").exists():
        return {"error": "unknown repo"}
    # --numstat gives `<added>\t<removed>\t<path>` per file — easy
    # to parse, exact counts, no '+' / '-' bar rendering to undo.
    raw = _git_capture(primary, "stash", "show", "--numstat", ref)
    if not raw:
        return {"error": "empty or unreadable stash"}
    files: list[dict] = []
    for line in raw.splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        added, removed, path = parts
        files.append({
            "path": path,
            # Binary files report '-' for both fields — keep as None
            # so the UI can render "binary" instead of "0 / 0".
            "added": int(added) if added.isdigit() else None,
            "removed": int(removed) if removed.isdigit() else None,
        })
    return {"repo": repo, "ref": ref, "files": files}


def drop_stash(primaries_root: Path, repo: str, ref: str) -> dict:
    """Hard-drop one stash. Returns {ok, ref} on success or
    {error: …} when the ref/repo is bad. No undo."""
    if not STASH_REF_RE.match(ref):
        return {"error": "invalid ref"}
    primary = primaries_root / repo
    if not (primary / ".git").exists():
        return {"error": "unknown repo"}
    try:
        r = subprocess.run(["git", "stash", "drop", ref],
                            cwd=str(primary),
                            capture_output=True, text=True,
                            timeout=5.0, check=False)
    except (OSError, subprocess.SubprocessError) as ex:
        return {"error": f"git failed: {ex}"}
    if r.returncode != 0:
        return {"error": (r.stderr or "git stash drop failed").strip()}
    return {"ok": True, "repo": repo, "ref": ref}
