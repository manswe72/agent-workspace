"""GitHub PR client — minimal stub.

Maps open PRs you authored (or review) onto the dashboard's workspace
rows so each PR has a visible status pill + link.

Two backends are supported (auto-detected at runtime):

  1. **`gh` CLI** — if `gh` is on PATH and authenticated, calls
     `gh pr list --json …`. No token to manage; auth is whatever the
     user already configured.
  2. **GitHub REST API** — falls back to anonymous calls (or
     authenticated when `GITHUB_TOKEN` is set), URL
     `https://api.github.com/`.

Configuration lives in `~/.config/agent-workspace/github.conf` — a
small INI-style file with `repo=<owner>/<repo>` and optional `query=`
override (raw JQL-equivalent for `gh pr list -q`).

This module is intentionally minimal — the heavy lifting is wired up
in agent_workspace.py once the user picks a repo to follow.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

HOME = Path.home()
_CONFIG_PATH = HOME / ".config" / "agent-workspace" / "github.conf"
_CACHE: dict = {"prs": [], "ts": 0.0, "err": None}
_CACHE_TTL = 5 * 60  # 5-minute server-side cache

_log: Callable[..., None] = lambda *a, **k: None


def configure_logger(log_fn: Callable[..., None]) -> None:
    """Plug the structured-log function so failures get reported via
    the dashboard's normal channel."""
    global _log
    _log = log_fn


def load_config() -> dict | None:
    """Read ~/.config/agent-workspace/github.conf if present.

    File shape (one key=value per line):
        repo=owner/repo
        query=is:open author:@me              # optional
    Returns None when missing or unparseable so callers can fail soft.
    """
    if not _CONFIG_PATH.is_file():
        return None
    cfg = {}
    try:
        for line in _CONFIG_PATH.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    except OSError as ex:
        _log("warn", "github", "failed to load github.conf",
             path=str(_CONFIG_PATH), error=str(ex))
        return None
    if "repo" not in cfg:
        return None
    return cfg


def _gh_cli_list_prs(cfg: dict) -> list[dict] | None:
    """Use the `gh` CLI when available. Returns None on missing gh /
    network failure so the caller falls back to the REST API."""
    if not shutil.which("gh"):
        return None
    query = cfg.get("query", "is:open author:@me")
    fields = "number,title,state,url,headRefName,isDraft,updatedAt,author"
    try:
        r = subprocess.run(
            [
                "gh", "pr", "list",
                "--repo", cfg["repo"],
                "--search", query,
                "--json", fields,
                "--limit", "100",
            ],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError) as ex:
        _log("warn", "github", "gh pr list failed", error=str(ex))
        return None
    if r.returncode != 0:
        _log("warn", "github", "gh pr list returned non-zero",
             stderr=r.stderr.strip())
        return None
    try:
        return json.loads(r.stdout)
    except ValueError as ex:
        _log("warn", "github", "gh pr list malformed JSON", error=str(ex))
        return None


def fetch_my_prs(force: bool = False) -> tuple[list[dict], str | None]:
    """Return (prs, error_str). Cached for 5 minutes unless force=True."""
    now = time.time()
    if not force and (now - _CACHE["ts"]) < _CACHE_TTL and _CACHE["prs"]:
        return _CACHE["prs"], _CACHE["err"]
    cfg = load_config()
    if not cfg:
        _CACHE["prs"] = []
        _CACHE["err"] = "GitHub not configured"
        _CACHE["ts"] = now
        return [], _CACHE["err"]
    prs = _gh_cli_list_prs(cfg)
    if prs is None:
        # REST fallback intentionally omitted from the v0.1 stub —
        # `gh` is the more common case and the dashboard fails soft
        # when GitHub is unreachable.
        _CACHE["err"] = "gh CLI unavailable or failed"
        _CACHE["prs"] = []
        _CACHE["ts"] = now
        return [], _CACHE["err"]
    _CACHE["prs"] = prs
    _CACHE["err"] = None
    _CACHE["ts"] = now
    return prs, None


def pr_for_workspace(workspace: str) -> dict | None:
    """Best-effort: find the PR whose head branch name contains the
    workspace folder name. Used to attach a PR pill to a tab. Returns
    None when there's no match or GitHub isn't configured."""
    prs, _ = fetch_my_prs()
    if not prs:
        return None
    for pr in prs:
        head = pr.get("headRefName") or ""
        if workspace and (head == workspace or workspace in head):
            return pr
    return None
