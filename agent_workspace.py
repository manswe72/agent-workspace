#!/usr/bin/env python3
"""
agent-workspace — local HTTP server that produces a status dashboard for
~/github/worktrees/<issue>/<repo>/.

Architecture
------------
- Single-file stdlib server (http.server.ThreadingHTTPServer).
- GET  /                → dashboard HTML (status data inlined).
- GET  /api/status      → JSON of current status (used by the Refresh button).
- GET  /api/heatmap     → zero-filled commit count per day for the last
                          365 days, used to render the activity heatmap.
- GET  /static/*        → CSS / JS files.

The server only inspects git state. It never spawns terminals or calls the
Claude CLI, so no Claude auth is required server-side. Open a terminal
yourself with `bin/agent-worktrees` when you want a tabbed claude session
across worktrees.
"""

from __future__ import annotations

import argparse
import atexit
import gzip
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from awlib import agent_mcp, agentterm
from awlib import github as _github
from awlib import pricing as _pricing
from awlib import stashes as _stashes
from awlib import updater as _updater
from awlib import user as _user_mod  # noqa: F401
from awlib.backup import (
    backup_loop as _backup_loop,
)
from awlib.backup import (
    delete_backup_entry,
    get_last_backup_at,
    list_backup_history,
    prune_backups,
    run_backup_now,
)
from awlib.dates import days_since as _days_since  # noqa: F401
from awlib.dates import minutes_since as _minutes_since  # noqa: F401
from awlib.disk import disk_usage  # noqa: F401
from awlib.editors import (  # noqa: F401  (re-exported for callers)
    EDITOR_REGISTRY,
    detect_editors,
    open_file_in_editor,
)
from awlib.events import (  # noqa: F401  (re-exported for callers + tests)
    delete_agent_event,
    ended_session_ids,
    insert_agent_event,
    list_agent_events,
    mark_agent_events_read,
    pending_event_counts,
    pending_event_counts_by_kind,
)
from awlib.gitcmd import _git, _git_raw, upstream_for  # noqa: F401
from awlib.logbuf import (  # noqa: F401  (re-exported for callers)
    _LOG_RING,
    _StderrTee,
    log_event,
)
from awlib.logbuf import (
    record_request as _record_request,
)
from awlib.logbuf import (
    request_counters_snapshot as _request_counters_snapshot,
)
from awlib.notes import (  # noqa: F401  (re-exported for callers)
    NOTE_PRIORITIES,
    NOTE_STATUSES,
    delete_note,
    insert_note,
    list_notes,
    todo_counts_by_issue,
    update_note,
)
from awlib.pricing import DEFAULT_PRICING, estimate_cost, load_pricing  # noqa: F401
from awlib.user import (  # noqa: F401  (re-exported for callers)
    _user_slug,
    user_agent_tokens_json,
    user_commits_jsonl,
    user_data_dir,
    user_meta_json,
    user_notes_jsonl,
    user_preferences_json,
    user_profile,
    user_worktrees_json,
)
from awlib.weekid import iso_week_id, week_bounds  # noqa: F401

# ── Configuration ──────────────────────────────────────────────────────────
HOME = Path.home()
DEFAULT_WORKTREES = HOME / "github" / "worktrees"
DEFAULT_PORT = 8765
DEFAULT_BEHIND_LIMIT = 50
REPO_PRIORITY = ("core", "bssweb", "doc")  # legacy hint; no longer used as a filter
# Repos the dashboard always wants to see for a workspace. Anything in
# this list gets rendered even if the user hasn't materialised a
# worktree for it — as a "missing" placeholder row so they spot the
# gap at a glance. discover_repos still returns *every* repo on disk,
# so extra repos beyond this set still show up.
#
# Empty default — the effective list is computed at runtime from the
# `github-repos` preference (each "owner/repo" contributes the repo
# name), with the `expected-repos` preference as an override / fallback
# when GitHub isn't configured.
EXPECTED_REPOS: tuple[str, ...] = ()

# In-flight + recently-finished clones from POST /api/primaries/clone.
# Keyed by repo name. Each value is a dict
#   {state: 'cloning'|'done'|'failed', url, target, started_at,
#    finished_at?, error?}.
# A second click while a clone is still running returns the in-flight
# entry instead of starting a duplicate; once done / failed the entry
# lingers so /api/primaries/status can surface the result on the next
# poll (and the user-facing banner can show the error).
_PRIMARIES_CLONE_LOCK = threading.Lock()
_PRIMARIES_CLONE_STATES: dict = {}

# Pending terminal images queued by POST /api/terminal-image.
# Each entry: {"issue": str, "data": str}  (data = base64-encoded PNG).
# Drained by GET /api/terminal-image/pending.
_TERM_IMAGE_LOCK = threading.Lock()
_TERM_IMAGE_QUEUE: list[dict] = []

# Clone-URL template for primary repos. Used as a fallback when the
# repo name isn't covered by the github-repos preference. The
# `{repo}` placeholder is substituted with the repo name. Empty by
# default — the user supplies a value (e.g.
# "git@github.com:<user>/{repo}.git") via the
# 'primaries-clone-url-template' preference if they want to clone
# repos that aren't in their github-repos list.
DEFAULT_PRIMARIES_CLONE_URL_TEMPLATE = ""


def _github_repos_pref(user_slug: str) -> list[str]:
    """Read the `github-repos` preference as a list of "owner/repo"
    strings. Empty list when unset or malformed."""
    try:
        conn = db_connect()
        try:
            raw = get_preferences(conn, user_slug).get("github-repos")
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if isinstance(x, str) and "/" in x]
    if isinstance(raw, str):
        return [s.strip() for s in raw.split(",")
                if s.strip() and "/" in s]
    return []


def _git_askpass_helper() -> Path:
    """Create (idempotent) a tiny bash script that answers git's
    Username / Password prompts from $GIT_USERNAME / $GIT_PASSWORD.
    Lives under the cache dir at chmod 700 so the helper is not
    world-readable.

    Using GIT_ASKPASS keeps the token out of `.git/config` (vs.
    embedding it in the URL) and out of `ps` output (vs. passing it
    on the command line). Token is only present in the cloning
    subprocess's environment."""
    cache = HOME / ".cache" / "agent-workspace"
    cache.mkdir(parents=True, exist_ok=True)
    helper = cache / "git-askpass.sh"
    if not helper.is_file():
        helper.write_text(
            '#!/usr/bin/env bash\n'
            'case "$1" in\n'
            '  Username*) printf "%s" "$GIT_USERNAME" ;;\n'
            '  Password*) printf "%s" "$GIT_PASSWORD" ;;\n'
            'esac\n'
        )
        helper.chmod(0o700)
    return helper


def _github_owner_from_url(url: str) -> str | None:
    """Pull the <owner> out of a GitHub HTTPS clone URL. Returns None
    when it doesn't look like a GitHub HTTPS URL."""
    m = re.match(
        r"^https?://(?:[^@]+@)?github\.com/([^/]+)/[^/]+?(?:\.git)?/?$", url)
    return m.group(1) if m else None


def _git_clone_env(url: str) -> dict[str, str]:
    """Build the environment for a `git clone` subprocess. For
    https://github.com/... URLs with a token configured, wires
    GIT_ASKPASS + GIT_USERNAME (the owner) + GIT_PASSWORD (the token).
    Other URL shapes (ssh, scp-style, non-github) pass through with
    the user's normal env."""
    env = os.environ.copy()
    # Fail fast instead of hanging on an interactive credential prompt.
    env["GIT_TERMINAL_PROMPT"] = "0"
    owner = _github_owner_from_url(url)
    token = _github._resolve_token() if owner else None
    if owner and token:
        env["GIT_ASKPASS"] = str(_git_askpass_helper())
        env["GIT_USERNAME"] = owner
        env["GIT_PASSWORD"] = token
    return env


def github_clone_url_for(user_slug: str, repo_name: str) -> str | None:
    """If the user's github-repos list contains an entry whose tail
    matches `repo_name`, return the HTTPS clone URL for it. Falls back
    to None so callers can use the template instead."""
    for slug in _github_repos_pref(user_slug):
        owner, _, name = slug.partition("/")
        if name == repo_name:
            return f"https://github.com/{owner}/{name}.git"
    return None


def user_clone_url_template(conn: sqlite3.Connection, user_slug: str) -> str:
    """Return the user's preferred clone-URL template for primary
    repos. Falls back to DEFAULT_PRIMARIES_CLONE_URL_TEMPLATE."""
    try:
        raw = get_preferences(conn, user_slug).get(
            "primaries-clone-url-template")
    except Exception:  # noqa: BLE001
        raw = None
    if isinstance(raw, str) and raw.strip() and "{repo}" in raw:
        return raw.strip()
    return DEFAULT_PRIMARIES_CLONE_URL_TEMPLATE


def primary_repo_status(primaries_root: Path, expected: list[str]
                          ) -> tuple[list[str], list[str]]:
    """Return (missing, present) repo names. A repo counts as
    "present" when `<primaries_root>/<name>/.git` exists (either a
    directory for a regular checkout or a file for a submodule
    pointer)."""
    missing: list[str] = []
    present: list[str] = []
    for name in expected:
        gitmarker = primaries_root / name / ".git"
        (present if gitmarker.exists() else missing).append(name)
    return missing, present


def salvage_broken_primary_clones(primaries_root: Path,
                                    expected: list[str]) -> list[str]:
    """Remove `<primaries_root>/<name>/` for any expected primary repo
    that has a `.git` marker but isn't a valid checkout (e.g. left
    behind by a clone that was orphaned mid-receive when the parent
    server died). Returns the list of salvaged repo names.

    A "valid" clone is one where `git -C <primary> rev-parse HEAD`
    succeeds — that covers a freshly-cloned bare repo, a regular
    checkout, and an unshallowed working tree. A clone that crashed
    after writing `.git/` but before any refs / HEAD were committed
    will fail rev-parse and be cleaned up here so the dashboard's
    "Missing primary repos" banner accurately reflects retry-needed
    state on next page load.
    """
    salvaged: list[str] = []
    for name in expected:
        primary = primaries_root / name
        if not (primary / ".git").exists():
            continue
        try:
            r = subprocess.run(
                ["git", "-C", str(primary), "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            r = None
        if r is None or r.returncode != 0:
            try:
                shutil.rmtree(primary, ignore_errors=True)
            except Exception:  # noqa: BLE001
                continue
            salvaged.append(name)
    return salvaged


def user_expected_repos(conn: sqlite3.Connection, user_slug: str) -> list[str]:
    """Return the user's effective expected-repos list.

    Precedence:
      1. `expected-repos` preference (explicit CSV override).
      2. Names derived from `github-repos` preference — each
         "owner/repo" contributes its repo name.
      3. The EXPECTED_REPOS baked-in default (empty in v0.1).
    """
    try:
        raw = get_preferences(conn, user_slug).get("expected-repos")
    except Exception:  # noqa: BLE001
        raw = None
    if isinstance(raw, str) and raw.strip():
        seen: set[str] = set()
        out: list[str] = []
        for p in raw.split(","):
            name = p.strip()
            if not name or name in seen:
                continue
            seen.add(name)
            out.append(name)
        if out:
            return out
    # No explicit override — derive from github-repos.
    derived: list[str] = []
    for slug in _github_repos_pref(user_slug):
        _, _, name = slug.partition("/")
        if name and name not in derived:
            derived.append(name)
    if derived:
        return derived
    return list(EXPECTED_REPOS)


def _preauth_claude_project(cwd: Path, server_slug: str) -> None:
    """Pre-accept the workspace-trust dialog AND mark `server_slug`
    as enabled for this cwd in ~/.claude.json, so launching the
    General Agent doesn't pause on either confirmation.

    Idempotent and best-effort — a missing / unreadable config
    file silently no-ops (claude will just show the dialog as
    usual).
    """
    cfg_path = Path.home() / ".claude.json"
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8") or "{}")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return
    if not isinstance(cfg.get("projects"), dict):
        cfg["projects"] = {}
    proj = cfg["projects"].setdefault(str(cwd), {})
    changed = False
    if proj.get("hasTrustDialogAccepted") is not True:
        proj["hasTrustDialogAccepted"] = True
        changed = True
    enabled = proj.get("enabledMcpjsonServers")
    if not isinstance(enabled, list):
        enabled = []
        proj["enabledMcpjsonServers"] = enabled
    if server_slug not in enabled:
        enabled.append(server_slug)
        changed = True
    if not changed:
        return
    try:
        # Atomic-ish write: write to a sibling tmp then rename.
        tmp = cfg_path.with_suffix(cfg_path.suffix + ".tmp")
        tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        tmp.replace(cfg_path)
    except OSError:
        pass


def _write_mcp_config_for_agent(agent_id: str, port: int) -> Path:
    """Write a per-agent claude-mcp-config file and return its path.

    Each agent gets its own file because the URL bakes in the
    agent's identity (?agent=<id>) — claude has no other way to
    tell the dashboard "I'm BSS-3733" since the MCP transport
    doesn't expose env vars or headers to the server. Files live
    under <DEFAULT_CACHE>/mcp/ and are overwritten on every spawn.
    """
    out_dir = DEFAULT_CACHE / "mcp"
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", agent_id) or "anon"
    path = out_dir / f"mcp-{port}-{safe_id}.json"
    # Key under `mcpServers` is what claude prints in `/mcp` and
    # what users type to reference the server in slash-commands —
    # so the slug here is user-facing. Sourced from
    # awlib.agent_mcp so it stays in sync with the permission
    # allow-list the launcher passes via --allowedTools.
    config = {
        "mcpServers": {
            agent_mcp.SERVER_SLUG: {
                "type": "http",
                "url": (f"http://127.0.0.1:{port}/mcp"
                        f"?agent={urllib.parse.quote(agent_id)}"),
            }
        }
    }
    path.write_text(json.dumps(config, indent=2))
    return path


def _pref_truthy(raw, default: bool) -> bool:
    """Coerce a pref value (which round-trips through JSON in
    get_preferences, so may be True/False/'1'/'0'/'true'/'false'/…)
    to a boolean. Empty / unset → `default`."""
    if raw is None or raw == "":
        return default
    if isinstance(raw, bool):
        return raw
    return str(raw).lower() in ("1", "true", "yes", "on")


def _mcp_enabled_now() -> bool:
    """Honour the dashboard pref `mcp-enabled` (default ON). Read
    fresh on every check so a Profile-toggle takes effect without a
    server restart. Falls open to True if the prefs row is missing
    or the DB can't be opened."""
    try:
        conn = db_connect()
        try:
            raw = get_preferences(conn, _user_slug()).get("mcp-enabled")
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return True
    return _pref_truthy(raw, default=True)


def discover_repos(issue_dir: Path) -> list[Path]:
    """Return every subdirectory of `issue_dir` that looks like a git
    worktree (its `.git` entry exists), in plain alphabetical order. Used
    everywhere we walk `~/github/worktrees/<issue>/*` so adding e.g. a
    `claude-plugins` worktree surfaces on the dashboard automatically."""
    if not issue_dir.is_dir():
        return []
    return sorted(
        (p for p in issue_dir.iterdir()
         if p.is_dir() and (p / ".git").exists()),
        key=lambda p: p.name,
    )


def missing_repo_placeholder(issue: str, repo_name: str) -> dict:
    """Synthesise a 'this repo isn't materialised yet' row that the
    client renders distinctly. Keeps the same shape as gather_repo_status
    so existing client code doesn't crash on missing fields."""
    return {
        "issue": issue,
        "repo": repo_name,
        "missing": True,
        "ghost": False,
        "too_behind": False,
        "path": "",
        "branch": "—",
        "upstream": None,
        "remote_url": "",
        "remote_path": "",
        "upstream_configured": False,
        "ahead": 0,
        "behind": 0,
        "n_to_pull": 0,
        "n_dirty": 0,
        "n_unpushed": 0,
        "last_commit": "",
        "last_commit_when": "",
        "last_commit_author": "",
        "last_commit_age_days": -1,
        "branch_age_days": -1,
        "merge_base_sha": None,
        "merge_base_commit": None,
        "last_commits": [],
        "dirty_files": [],
        "unpushed": [],
        "coauthors": [],
        "last_claude": "—",
        "last_claude_prompt": "",
    }
STATIC_DIR = Path(__file__).parent / "static"

# Platform-aware default paths. On macOS we follow Apple's layout
# (~/Library/Caches, ~/Library/Application Support); on Windows we
# follow Microsoft's (%LOCALAPPDATA% for cache, %APPDATA% for
# roaming data); on Linux (and everything else) we honour the XDG
# Base Directory spec.
IS_DARWIN = sys.platform == "darwin"
IS_WINDOWS = sys.platform == "win32"


def _default_cache_dir() -> Path:
    if IS_DARWIN:
        return HOME / "Library" / "Caches" / "agent-workspace"
    if IS_WINDOWS:
        base = os.environ.get("LOCALAPPDATA") or str(HOME / "AppData" / "Local")
        return Path(base) / "agent-workspace"
    base = os.environ.get("XDG_CACHE_HOME") or str(HOME / ".cache")
    return Path(base) / "agent-workspace"


def _default_data_dir() -> Path:
    if IS_DARWIN:
        return (HOME / "Library" / "Application Support"
                / "agent-workspace")
    if IS_WINDOWS:
        base = os.environ.get("APPDATA") or str(HOME / "AppData" / "Roaming")
        return Path(base) / "agent-workspace"
    base = os.environ.get("XDG_DATA_HOME") or str(HOME / ".local" / "share")
    return Path(base) / "agent-workspace"


DEFAULT_CACHE = _default_cache_dir()
DB_PATH = DEFAULT_CACHE / "activity.sqlite"

# Scheduled-backup defaults. interval/retention are sane weekly
# defaults; the user can override all of these from the Backup tab in
# the profile popover.
DEFAULT_BACKUP_DIR = _default_data_dir() / "backups"
DEFAULT_BACKUP_INTERVAL_DAYS = 7
DEFAULT_BACKUP_RETENTION = 8
SCAN_THROTTLE_SECONDS = 5 * 60      # don't re-scan more often than every 5 min
TOKEN_SCAN_THROTTLE_SECONDS = 5 * 60  # rebuild agent token totals at the same cadence
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # per-file cap for /api/agent/upload

# Pricing config + cost estimator lives in awlib.pricing now (see
# imports at the top of this file). awlib.pricing's warning logger is
# wired in just after log_event is defined.

HEATMAP_DAYS = 365                  # 1-year window

# Plain-text sync mirror of the SQLite cache. By default it lives in
# the user's XDG data dir so packaged distributions (Flatpak, Snap)
# work — those sandbox the install dir read-only. The legacy in-repo
# location (REPO_DIR/data) is honoured if it already exists, so an
# existing source clone keeps syncing without surprise.
REPO_DIR = Path(__file__).parent.resolve()


def _resolve_data_dir() -> Path:
    """Pick the data dir, preferring an existing repo-local one for
    backward compatibility, otherwise $XDG_DATA_HOME/agent-workspace/data."""
    repo_local = REPO_DIR / "data"
    if (repo_local / "README.md").exists() and any(
        p.is_dir() for p in repo_local.iterdir()
    ):
        return repo_local
    xdg = Path(
        os.environ.get("XDG_DATA_HOME") or (HOME / ".local" / "share")
    ) / "agent-workspace" / "data"
    xdg.mkdir(parents=True, exist_ok=True)
    return xdg


DATA_DIR = _resolve_data_dir()
DEFAULT_SYNC_INTERVAL = 3 * 60 * 60  # 3 hours → ~8 ticks/day max when enabled
SYNC_STALE_SECONDS = 30 * 60         # banner threshold: warn if no sync in 30 min

# Updated by every auto_sync_tick() call. last_ts is None until the first run.
_SYNC_STATUS = {"last_ts": None, "last_ok": None, "last_summary": None, "enabled": False}
_SYNC_LOCK = threading.Lock()


# In-memory log ring, structured logger, stderr tee, and per-request
# counters all live in awlib.logbuf now (see imports at the top).
# Route awlib.pricing warnings through the same structured-log path.
_pricing.configure_logger(log_event)
_github.configure_logger(log_event)


def _refresh_github_config() -> None:
    """Pull the repo list out of the user's preferences and hand it
    to the github module. Called on startup + after every preferences
    POST that might touch github-repos."""
    repos: list[str] = []
    try:
        conn = db_connect()
        try:
            raw = get_preferences(conn, _user_slug()).get("github-repos")
        finally:
            conn.close()
        if isinstance(raw, list):
            repos = [str(x).strip() for x in raw if isinstance(x, str)]
        elif isinstance(raw, str):
            # CSV fallback so the preference is easy to seed from a shell.
            repos = [s.strip() for s in raw.split(",") if s.strip()]
    except Exception:  # noqa: BLE001
        pass
    _github.configure(repos)

# Server runtime start timestamp — set in main(); read by /api/stats.
_SERVER_START_TS = 0.0


def schedule_self_restart(delay_seconds: float = 0.7) -> None:
    """Re-exec the server in-place after a short delay.

    `os.execv` replaces the current process image with a fresh Python
    interpreter running the same script + argv, keeping the same PID
    and controlling terminal. Used by /api/restore/sqlite (and any
    other path that invalidates in-process state) so callers don't
    have to manually pkill + restart.

    The delay gives the HTTP response time to flush before the
    process is replaced. Best-effort: a failure is logged but does
    not raise.
    """
    def _do_restart():
        try:
            time.sleep(delay_seconds)
            log_event("info", "restart",
                      "exec'ing fresh process", argv=sys.argv)
            os.execv(sys.executable, [sys.executable, *sys.argv])
        except Exception as ex:  # noqa: BLE001
            log_event("error", "restart", "exec failed", error=str(ex))
    threading.Thread(target=_do_restart, daemon=True).start()


def health_status() -> tuple[dict, bool]:
    """Aggregate liveness blob + a single 'ok' boolean.

    'ok' is False when any obviously-broken condition is true:
      - sync is enabled but the thread isn't running
      - sync is enabled and the last tick was more than `stale_seconds`
        ago AND it had errors
      - the SQLite cache is missing or unreadable
      - >0 errors in the in-memory log ring within the last 5 minutes
    Otherwise True. The HTTP handler maps `ok` to 200 vs 503 so
    external monitors / load-balancers can react.
    """
    uptime = int(time.time() - _SERVER_START_TS) if _SERVER_START_TS else 0

    with _SYNC_LOCK:
        sync_ts = _SYNC_STATUS["last_ts"]
        sync_ok = _SYNC_STATUS["last_ok"]
        sync_enabled = _SYNC_STATUS["enabled"]
        sync_thread_running = _SYNC_STATUS.get("thread_running", False)
        sync_interval = _SYNC_STATUS.get("interval", DEFAULT_SYNC_INTERVAL)
    sync_age = int(time.time() - sync_ts) if sync_ts else None
    sync_stale = (sync_enabled and sync_ts is not None
                   and sync_age is not None
                   and sync_age > SYNC_STALE_SECONDS)

    db_block: dict = {"path": str(DB_PATH), "ok": False, "size_bytes": 0}
    counts: dict = {}
    try:
        if DB_PATH.exists():
            db_block["size_bytes"] = DB_PATH.stat().st_size
        conn = db_connect()
        try:
            counts["events_total"] = conn.execute(
                "SELECT COUNT(*) FROM agent_events").fetchone()[0]
            counts["events_unread"] = conn.execute(
                "SELECT COUNT(*) FROM agent_events "
                "WHERE read_at IS NULL").fetchone()[0]
            counts["worktrees_known"] = conn.execute(
                "SELECT COUNT(*) FROM worktrees").fetchone()[0]
            counts["commits_indexed"] = conn.execute(
                "SELECT COUNT(*) FROM commits").fetchone()[0]
            try:
                counts["notes_total"] = conn.execute(
                    "SELECT COUNT(*) FROM notes").fetchone()[0]
            except sqlite3.OperationalError:
                counts["notes_total"] = 0
        finally:
            conn.close()
        db_block["ok"] = True
    except Exception as ex:  # noqa: BLE001
        db_block["error"] = str(ex)

    log_levels = _LOG_RING.levels_summary()

    ok = True
    reasons: list[str] = []
    if sync_enabled and not sync_thread_running:
        ok = False
        reasons.append("sync enabled but thread not running")
    if sync_stale and sync_ok is False:
        ok = False
        reasons.append("last sync stale and errored")
    if not db_block["ok"]:
        ok = False
        reasons.append("db unreadable: " + db_block.get("error", "?"))

    return ({
        "ok": ok,
        "reasons": reasons,
        "uptime_seconds": uptime,
        "started_iso": (datetime.fromtimestamp(_SERVER_START_TS).strftime("%Y-%m-%d %H:%M:%S")
                        if _SERVER_START_TS else None),
        "pid": os.getpid(),
        "python_version": sys.version.split()[0],
        "sync": {
            "enabled": sync_enabled,
            "thread_running": sync_thread_running,
            "interval_seconds": sync_interval,
            "last_iso": (datetime.fromtimestamp(sync_ts).strftime("%Y-%m-%d %H:%M:%S")
                         if sync_ts else None),
            "age_seconds": sync_age,
            "stale_seconds": SYNC_STALE_SECONDS,
            "stale": sync_stale,
            "ok": sync_ok,
        },
        "db": db_block,
        "counts": counts,
        "log_levels": log_levels,
    }, ok)


def _read_dashboard_version() -> str:
    """Read the human-readable release tag from VERSION at the repo
    root. Falls back to "0.0.0" on any error so /api/stats never
    crashes on a malformed deploy."""
    try:
        return (REPO_DIR / "VERSION").read_text().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


def _dashboard_commit_sha() -> str:
    """Short SHA of the dashboard repo's HEAD, for "what version is
    actually running?" bug reports. Empty string if we can't
    resolve it (no .git, missing git binary, …)."""
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(REPO_DIR), capture_output=True,
            text=True, timeout=2.0, check=False)
        if r.returncode == 0:
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


# Resolve once at import. Both are stable for the life of the
# server process — VERSION is committed and HEAD doesn't move
# under us (a pull triggers a restart via the updater path).
DASHBOARD_VERSION = _read_dashboard_version()
DASHBOARD_COMMIT_SHA = _dashboard_commit_sha()


def server_stats() -> dict:
    uptime = int(time.time() - _SERVER_START_TS) if _SERVER_START_TS else 0
    reqs = _request_counters_snapshot()
    return {
        "pid": os.getpid(),
        "version": DASHBOARD_VERSION,
        "commit_sha": DASHBOARD_COMMIT_SHA,
        "started_at": _SERVER_START_TS,
        "started_iso": (datetime.fromtimestamp(_SERVER_START_TS).strftime("%Y-%m-%d %H:%M:%S")
                        if _SERVER_START_TS else None),
        "uptime_seconds": uptime,
        "python_version": sys.version.split()[0],
        "platform": sys.platform,
        "requests_total": reqs["total"],
        "requests_errors": reqs["errors"],
        "log_buffer_size": _LOG_RING.size(),
        "log_buffer_capacity": _LOG_RING._buf.maxlen,
        "log_levels": _LOG_RING.levels_summary(),
    }


# User identity + data-folder paths live in awlib.user now (see
# imports at the top). Wire REPO_DIR / DATA_DIR so the module uses
# this checkout's paths.
_user_mod.configure(repo_dir=REPO_DIR, data_dir=DATA_DIR)


def _initial_preferences_for_state() -> dict:
    """Best-effort fetch of the local user's prefs for inlining in the
    initial dashboard state. Errors fall back to an empty dict so a flaky
    DB never breaks the page render."""
    try:
        conn = db_connect()
        try:
            return get_preferences(conn, _user_slug())
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return {}


# Git command wrappers live in awlib.gitcmd now (see imports at the top).


def claude_project_dir(wt: Path) -> Path:
    """Path-encoded directory under ~/.claude/projects/<encoded>.

    Claude Code's encoding is more aggressive than just slash→dash:
    every character outside [A-Za-z0-9-] is replaced with `-`.
    Worktrees with underscores (e.g. ``man-remove_maven_formatter``)
    are stored as ``-...-man-remove-maven-formatter-core``."""
    encoded = re.sub(r"[^A-Za-z0-9-]", "-", str(wt))
    return HOME / ".claude" / "projects" / encoded


def latest_session_mtime(wt: Path) -> str:
    d = claude_project_dir(wt)
    if not d.is_dir():
        return "—"
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return "—"
    return datetime.fromtimestamp(files[0].stat().st_mtime).strftime("%Y-%m-%d %H:%M")


# Windows used by the Agents stat card to classify a worktree's Claude
# session as active vs. idle vs. closed. The signal is the most recent
# mtime of any *.jsonl in the worktree's claude_project_dir — Claude
# appends to that file in real time during sessions, so it stops moving
# the moment the agent dies. SessionStart/SessionEnd events are NOT
# used because a force-killed terminal can drop SessionEnd and leave a
# phantom-active session forever.
AGENT_ACTIVE_WINDOW_SEC = 5 * 60          # ≤ 5 min       → active
AGENT_IDLE_WINDOW_SEC   = 24 * 60 * 60    # ≤ 24 h        → idle
                                          # > 24 h or SessionEnd → closed


def issue_agent_state(issue_dir: Path,
                       ended_sessions: set[str] | None = None,
                       process_running: bool = False) -> str:
    """'active' | 'idle' | 'closed' for a worktree-issue dir.

    Picks the strongest state across every repo subdir under the
    issue. The signal is the most recent *.jsonl mtime in
    ~/.claude/projects/<encoded-path>/ for each repo. Files whose
    session_id (= filename stem) is present in `ended_sessions` are
    ignored — a fired SessionEnd hook trumps a recent mtime.

    `process_running` short-circuits to "active" when the JSONL would
    otherwise say "closed". This covers the early-startup window where
    Claude Code has spawned but hasn't appended any session data yet
    (first prompt not yet submitted) — without this the dashboard
    would call a running agent "closed" until the user's first input.
    """
    now = time.time()
    best_age = float("inf")
    ended = ended_sessions or set()
    try:
        children = list(issue_dir.iterdir())
    except OSError:
        return "active" if process_running else "closed"
    for repo in children:
        if not (repo / ".git").exists():
            continue
        proj = claude_project_dir(repo)
        if not proj.is_dir():
            continue
        for f in proj.glob("*.jsonl"):
            if f.stem in ended:
                continue
            try:
                age = now - f.stat().st_mtime
            except OSError:
                continue
            if age < best_age:
                best_age = age
    if best_age < AGENT_ACTIVE_WINDOW_SEC:
        return "active"
    if best_age < AGENT_IDLE_WINDOW_SEC:
        return "idle" if not process_running else "active"
    return "active" if process_running else "closed"


def latest_user_prompt(wt: Path, max_len: int = 600) -> str:
    """
    Return the last user-role text message in the most-recent Claude session
    JSONL file for this worktree. Empty string if none. Trimmed to max_len.
    """
    d = claude_project_dir(wt)
    if not d.is_dir():
        return ""
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return ""
    last = ""
    try:
        with files[0].open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = obj.get("message") or {}
                if msg.get("role") != "user":
                    continue
                # Skip tool-result messages — those are role=user but the
                # content is a tool_result block, not a real prompt.
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    last = content.strip()
                elif isinstance(content, list):
                    text_parts = []
                    has_tool_result = False
                    for item in content:
                        if not isinstance(item, dict):
                            continue
                        if item.get("type") == "tool_result":
                            has_tool_result = True
                            continue
                        if item.get("type") == "text":
                            t = item.get("text", "")
                            if t.strip():
                                text_parts.append(t.strip())
                    if not has_tool_result and text_parts:
                        last = "\n".join(text_parts)
    except OSError:
        return ""
    if len(last) > max_len:
        last = last[:max_len].rstrip() + " …"
    return last


def claude_session_summary(wt: Path) -> dict:
    """
    Walk the most-recent JSONL session file for this worktree and return a
    compact summary the dashboard can render: tool-use distribution, last
    user prompt + age, custom title, permission mode, session count, and
    first/last activity timestamps.

    Returns {} when there is no Claude history at all.
    """
    out: dict = {}
    d = claude_project_dir(wt)
    if not d.is_dir():
        return out
    files = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return out
    out["session_count"] = len(files)
    out["sessions_size_bytes"] = sum(p.stat().st_size for p in files)
    latest = files[0]

    tool_counts: dict[str, int] = {}
    user_msgs = 0
    assistant_msgs = 0
    last_user_ts: str | None = None
    first_ts: str | None = None
    last_ts: str | None = None
    custom_title: str | None = None
    agent_name: str | None = None
    permission_mode: str | None = None
    last_user_text = ""
    queued = 0

    try:
        with latest.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                ts = obj.get("timestamp")
                if ts:
                    if first_ts is None:
                        first_ts = ts
                    last_ts = ts
                if t == "custom-title":
                    custom_title = obj.get("customTitle") or custom_title
                elif t == "agent-name":
                    agent_name = obj.get("agentName") or agent_name
                elif t == "permission-mode":
                    permission_mode = obj.get("mode") or obj.get("permissionMode") or permission_mode
                elif t == "queue-operation":
                    op = obj.get("operation")
                    if op == "add":
                        queued += 1
                    elif op in ("remove", "consume"):
                        queued = max(0, queued - 1)
                msg = obj.get("message") or {}
                role = msg.get("role")
                content = msg.get("content")
                if role == "assistant":
                    assistant_msgs += 1
                    if isinstance(content, list):
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "tool_use":
                                name = c.get("name") or "?"
                                tool_counts[name] = tool_counts.get(name, 0) + 1
                elif role == "user":
                    # Only real user prompts (not tool_result echoes)
                    text = ""
                    if isinstance(content, str) and content.strip():
                        text = content.strip()
                    elif isinstance(content, list):
                        text_parts = []
                        is_tool_result = False
                        for it in content:
                            if not isinstance(it, dict):
                                continue
                            if it.get("type") == "tool_result":
                                is_tool_result = True
                            elif it.get("type") == "text":
                                tt = it.get("text", "")
                                if tt.strip():
                                    text_parts.append(tt.strip())
                        if not is_tool_result:
                            text = "\n".join(text_parts).strip()
                    if text:
                        user_msgs += 1
                        last_user_text = text
                        if ts:
                            last_user_ts = ts
    except OSError:
        return out

    out["session_id"] = latest.stem
    out["session_started"] = first_ts
    out["last_activity"] = last_ts
    out["last_activity_age_min"] = _minutes_since(last_ts)
    out["last_user_prompt"] = (last_user_text[:600].rstrip() + " …") if len(last_user_text) > 600 else last_user_text
    out["last_user_prompt_age_min"] = _minutes_since(last_user_ts)
    out["custom_title"] = custom_title
    out["agent_name"] = agent_name
    out["permission_mode"] = permission_mode
    out["queued_prompts"] = queued
    out["user_msg_count"] = user_msgs
    out["assistant_msg_count"] = assistant_msgs
    # Top tools, sorted descending by count.
    out["tool_counts"] = dict(sorted(tool_counts.items(), key=lambda kv: -kv[1]))
    out["total_tool_calls"] = sum(tool_counts.values())
    return out


# _minutes_since and _days_since live in awlib.dates now (see imports
# at the top).


# ── Activity DB (SQLite) ──────────────────────────────────────────────────
DB_SCHEMA = """
CREATE TABLE IF NOT EXISTS commits (
  sha           TEXT PRIMARY KEY,
  author_email  TEXT NOT NULL,
  date_utc      TEXT NOT NULL,   -- YYYY-MM-DD (author date)
  subject       TEXT NOT NULL,
  worktree      TEXT NOT NULL    -- where we first saw the commit
);
CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(date_utc);

-- Snapshot of every worktree we have ever seen. Updated on each /api/status.
-- Lets the dashboard surface "ghost" worktrees (rows whose path no longer
-- exists) on demand so historical context isn't lost when a worktree is
-- removed.
CREATE TABLE IF NOT EXISTS worktrees (
  issue                TEXT NOT NULL,
  repo                 TEXT NOT NULL,
  path                 TEXT NOT NULL,
  first_seen           TEXT NOT NULL,
  last_seen            TEXT NOT NULL,
  branch               TEXT,
  upstream             TEXT,
  ahead                INTEGER,
  behind               INTEGER,
  n_dirty              INTEGER,
  n_unpushed           INTEGER,
  last_commit          TEXT,
  last_commit_when     TEXT,
  last_commit_author   TEXT,
  PRIMARY KEY (issue, repo)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Per-jsonl-file token totals so the agent-token aggregation is
-- incremental: re-walk a file only when its (mtime, size) changes.
-- file_path is the absolute path to one ~/.claude/projects/.../*.jsonl.
CREATE TABLE IF NOT EXISTS agent_session_files (
  file_path     TEXT PRIMARY KEY,
  issue         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  mtime         REAL NOT NULL,
  size          INTEGER NOT NULL,
  in_tokens     INTEGER NOT NULL DEFAULT 0,
  out_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_r_tokens INTEGER NOT NULL DEFAULT 0,
  cache_w_tokens INTEGER NOT NULL DEFAULT 0,
  asst_msgs     INTEGER NOT NULL DEFAULT 0,
  model         TEXT,
  last_msg_iso  TEXT,
  walked_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_files_issue_repo ON agent_session_files(issue, repo);

-- Per-(file, date) token sums so the dashboard can render a token
-- heatmap. Stored per-file (not just per-date) so re-walking one file
-- can DELETE its rows and reinsert without disturbing the others.
CREATE TABLE IF NOT EXISTS agent_session_file_days (
  file_path     TEXT NOT NULL,
  date_utc      TEXT NOT NULL,   -- YYYY-MM-DD (assistant msg timestamp, UTC)
  in_tokens     INTEGER NOT NULL DEFAULT 0,
  out_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_r_tokens INTEGER NOT NULL DEFAULT 0,
  cache_w_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (file_path, date_utc)
);
CREATE INDEX IF NOT EXISTS idx_session_file_days_date ON agent_session_file_days(date_utc);

-- Cached week summaries. One row per ISO week (Mon–Sun). Past weeks are
-- generated once and never recomputed unless `force=1` on the API call;
-- the current week is regenerated on access if the cache is older than 1
-- hour. Content is opaque JSON — see generate_week_summary() for the shape.
CREATE TABLE IF NOT EXISTS week_summaries (
  week_id      TEXT PRIMARY KEY,    -- ISO week, 'YYYY-Www'
  generated_at INTEGER NOT NULL,    -- unix ts
  content_json TEXT NOT NULL
);

-- User-entered work logs (hours per issue per day). Either created
-- manually via /api/worklogs POST or by stopping a timer. Surfaced in
-- the week summary so the summary doubles as a worklog report.
CREATE TABLE IF NOT EXISTS work_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue       TEXT NOT NULL,
  date_local  TEXT NOT NULL,        -- YYYY-MM-DD (local)
  minutes     INTEGER NOT NULL,
  comment     TEXT,
  source      TEXT NOT NULL,        -- 'manual' | 'timer'
  created_at  INTEGER NOT NULL      -- unix ts
);
CREATE INDEX IF NOT EXISTS idx_work_logs_date ON work_logs(date_local);
CREATE INDEX IF NOT EXISTS idx_work_logs_issue ON work_logs(issue);

-- Singleton row for the running timer (id is forced to 1 so we can only
-- have one active timer at a time — work-log granularity is per-issue,
-- so concurrent timers don't make sense).
CREATE TABLE IF NOT EXISTS timer_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  issue       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,     -- unix ts
  comment     TEXT
);

-- User-deleted agent worklog rows. Agent rows are synthesized per-week
-- from JSONL active-time and don't have a persistent id, so 'delete'
-- means: remember (issue, week_id) and skip it in future renders.
CREATE TABLE IF NOT EXISTS agent_worklog_exclusions (
  issue   TEXT NOT NULL,
  week_id TEXT NOT NULL,
  PRIMARY KEY (issue, week_id)
);

-- Events posted by Claude Code hooks (Stop, Notification, UserPromptSubmit,
-- SessionStart, SessionEnd, …). Surfaced in the diagnostics console + a
-- per-issue "recent events" line. Issue is derived from the hook's cwd.
CREATE TABLE IF NOT EXISTS agent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  issue       TEXT,
  session_id  TEXT,
  message     TEXT,
  cwd         TEXT,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER                  -- NULL = pending / unread
);
CREATE INDEX IF NOT EXISTS idx_agent_events_issue ON agent_events(issue);
CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_pending
  ON agent_events(issue, read_at);

-- User preferences synced across machines via data/<user-slug>/preferences.json.
-- Keyed by (user_slug, key) so multiple users sharing the repo each have their
-- own preferences. Values are stored as JSON text — booleans, strings, lists.
CREATE TABLE IF NOT EXISTS preferences (
  user_slug   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,            -- JSON-encoded
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_slug, key)
);

-- Per-issue notes with a tri-state status. Synced via
-- data/<user-slug>/notes.jsonl so a note travels with the rest of
-- the user's dashboard state. user_slug is recorded so we can keep
-- everyone's notes side-by-side without merge conflicts.
--
-- tags / due_at / priority / assignee / sort_order are P4 extensions
-- (historical: schema-evolution notes lived outside the repo). Old DBs
-- get these columns via the ALTER TABLE migration in db_connect.
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slug   TEXT NOT NULL,
  issue       TEXT NOT NULL,
  content     TEXT NOT NULL,
  status      TEXT NOT NULL,            -- 'todo' | 'done' | 'not_done'
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  due_at      INTEGER,                     -- unix seconds, nullable
  priority    TEXT NOT NULL DEFAULT 'normal',  -- 'low' | 'normal' | 'high'
  assignee    TEXT,                        -- free-form, nullable
  sort_order  REAL                         -- manual-sort key, nullable
);
CREATE INDEX IF NOT EXISTS idx_notes_issue ON notes(issue);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes(user_slug);
CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);

-- Scheduled-backup audit log. One row per backup attempt (including
-- failures), so the dashboard can show the user when their last backup
-- ran, where it landed, and whether anything went wrong.
CREATE TABLE IF NOT EXISTS backup_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at       INTEGER NOT NULL,         -- unix seconds
  path             TEXT NOT NULL,            -- backup dir (timestamped)
  ok               INTEGER NOT NULL DEFAULT 1,
  error            TEXT,                     -- non-null only when ok=0
  db_size_bytes    INTEGER NOT NULL DEFAULT 0,
  bundle_count     INTEGER NOT NULL DEFAULT 0,
  total_size_bytes INTEGER NOT NULL DEFAULT 0,
  details          TEXT                      -- JSON: per-worktree status
);
CREATE INDEX IF NOT EXISTS idx_backup_history_created
  ON backup_history(created_at DESC);
"""


def _migrate_notes_columns(conn: sqlite3.Connection) -> None:
    """Add P4 columns to an existing notes table. Idempotent; safe to
    call on every connect (only the PRAGMA + the missing ALTERs run)."""
    have = {row[1] for row in conn.execute(
        "PRAGMA table_info(notes)").fetchall()}
    if "tags" not in have:
        conn.execute(
            "ALTER TABLE notes ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
    if "due_at" not in have:
        conn.execute("ALTER TABLE notes ADD COLUMN due_at INTEGER")
    if "priority" not in have:
        conn.execute(
            "ALTER TABLE notes ADD COLUMN priority TEXT NOT NULL "
            "DEFAULT 'normal'")
    if "assignee" not in have:
        conn.execute("ALTER TABLE notes ADD COLUMN assignee TEXT")
    if "sort_order" not in have:
        conn.execute("ALTER TABLE notes ADD COLUMN sort_order REAL")
    conn.commit()


def db_connect() -> sqlite3.Connection:
    DEFAULT_CACHE.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(DB_SCHEMA)
    _migrate_notes_columns(conn)
    # Idempotent — agent_mcp owns its own table so the schema stays
    # in the module that uses it. Cheap (CREATE IF NOT EXISTS).
    agent_mcp.init_db(conn)
    return conn


def db_get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def db_set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


# ── Preferences (synced via data/<user-slug>/preferences.json) ───────────
def get_preferences(conn: sqlite3.Connection, user_slug: str) -> dict:
    """Return the prefs dict for one user. Values are JSON-decoded."""
    rows = conn.execute(
        "SELECT key, value FROM preferences WHERE user_slug = ?",
        (user_slug,),
    ).fetchall()
    out: dict = {}
    for k, v in rows:
        try:
            out[k] = json.loads(v)
        except json.JSONDecodeError:
            out[k] = v        # fall back to raw text rather than dropping
    return out


def set_preferences(conn: sqlite3.Connection, user_slug: str,
                     updates: dict) -> None:
    """Upsert each key/value in updates. A value of `None` deletes the key
    (so the client can ask the server to forget a pref it no longer wants)."""
    now = int(time.time())
    for k, v in updates.items():
        if v is None:
            conn.execute(
                "DELETE FROM preferences WHERE user_slug = ? AND key = ?",
                (user_slug, k))
            continue
        conn.execute(
            "INSERT INTO preferences(user_slug, key, value, updated_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(user_slug, key) DO UPDATE SET "
            "value = excluded.value, updated_at = excluded.updated_at",
            (user_slug, k, json.dumps(v, ensure_ascii=False), now),
        )


# Notes CRUD lives in awlib.notes now (see imports at the top).


# ── Backup settings (read from preferences with sensible fallbacks) ─────
def get_backup_settings(conn: sqlite3.Connection, user_slug: str) -> dict:
    """Return the effective backup settings: the user's saved preferences
    merged over the module-level defaults. Always returns valid types
    (booleans coerced, paths stringified, ints clamped to >= 1)."""
    prefs = get_preferences(conn, user_slug)
    enabled = prefs.get("backup_enabled")
    if enabled is None:
        enabled = True
    try:
        interval = int(prefs.get("backup_interval_days")
                       or DEFAULT_BACKUP_INTERVAL_DAYS)
    except (TypeError, ValueError):
        interval = DEFAULT_BACKUP_INTERVAL_DAYS
    try:
        retention = int(prefs.get("backup_retention")
                        or DEFAULT_BACKUP_RETENTION)
    except (TypeError, ValueError):
        retention = DEFAULT_BACKUP_RETENTION
    return {
        "enabled": bool(enabled),
        "interval_days": max(1, interval),
        "dir": str(prefs.get("backup_dir") or DEFAULT_BACKUP_DIR),
        "retention": max(1, retention),
    }


def set_backup_settings(conn: sqlite3.Connection, user_slug: str,
                          updates: dict) -> None:
    """Persist the validated subset of `updates` to the preferences table.
    Unknown keys are ignored — only the four documented settings are
    written."""
    allowed = {"backup_enabled", "backup_interval_days",
               "backup_dir", "backup_retention"}
    clean: dict = {}
    for k, v in updates.items():
        if k not in allowed:
            continue
        if k == "backup_enabled":
            clean[k] = bool(v)
        elif k in ("backup_interval_days", "backup_retention"):
            try:
                clean[k] = max(1, int(v))
            except (TypeError, ValueError):
                continue
        elif k == "backup_dir":
            s = (v or "").strip()
            clean[k] = s or None  # None deletes -> reverts to default
    set_preferences(conn, user_slug, clean)
    conn.commit()


def my_email(worktrees_root: Path) -> str | None:
    """Look up `git config user.email` in any available worktree."""
    for issue_dir in worktrees_root.iterdir():
        if not issue_dir.is_dir():
            continue
        for wt in discover_repos(issue_dir):
            email = _git(wt, "config", "user.email")
            if email:
                return email
    return None


def scan_commits(worktrees_root: Path, conn: sqlite3.Connection) -> dict:
    """
    Throttled scan: walk every worktree under worktrees_root, ingest commits
    authored by the local user.email since the last seen date. Returns a
    small status dict for logging.
    """
    last_scan = db_get_meta(conn, "last_scan_at")
    now = datetime.now()
    if last_scan:
        try:
            last_dt = datetime.fromisoformat(last_scan)
            if (now - last_dt).total_seconds() < SCAN_THROTTLE_SECONDS:
                return {"skipped": True, "last_scan": last_scan}
        except ValueError:
            pass

    # Lower bound: don't fetch anything older than HEATMAP_DAYS+30 (small
    # buffer for backfill). INSERT OR IGNORE handles dedupe.
    since = (now - timedelta(days=HEATMAP_DAYS + 30)).strftime("%Y-%m-%d")

    inserted = 0
    emails_seen: set[str] = set()       # author addresses we actually ingested
    localparts_seen: set[str] = set()   # local-parts of all configured user.email
    for issue_dir in sorted(p for p in worktrees_root.iterdir() if p.is_dir()):
        for wt in discover_repos(issue_dir):
            # Use the per-worktree user.email's *local part* so commits
            # authored under any email of the form <you>@<anything> count
            # — important if you've changed git user.email at some point
            # (e.g. company rename) and want both addresses in the heatmap.
            cfg_email = _git(wt, "config", "user.email")
            if not cfg_email or "@" not in cfg_email:
                continue
            localpart = cfg_email.split("@", 1)[0].lower()
            localparts_seen.add(localpart)
            # Walk commits reachable from HEAD that are NOT also reachable
            # from a "main" / released ref — origin/master and any release
            # branches matching v<digits>.<digits>... (local or remote).
            # Excluding these stops the heatmap from being flooded with
            # the entire authored history that happens to live on master:
            # those are released, not work-in-progress. Branch-only work
            # in unmerged worktrees still counts. INSERT OR IGNORE dedupes
            # commits seen via multiple worktrees.
            upstream = upstream_for(wt)
            release_refs = []
            for ref_glob in ("refs/heads/v[0-9]*",
                             "refs/remotes/origin/v[0-9]*"):
                refs_out = _git(wt, "for-each-ref",
                                "--format=%(refname)", ref_glob)
                for line in refs_out.splitlines():
                    line = line.strip()
                    if line:
                        release_refs.append(line)
            log_argv = ["log", f"--author={localpart}", f"--since={since}",
                        "--no-merges", "HEAD"]
            if upstream and _git(wt, "rev-parse", "--verify", upstream):
                log_argv += ["--not", upstream]
            for ref in release_refs:
                log_argv += ["--not", ref]
            log_argv += ["--format=%H%x09%ae%x09%ad%x09%s", "--date=short"]
            log = _git(wt, *log_argv)
            for line in log.splitlines():
                parts = line.split("\t", 3)
                if len(parts) != 4:
                    continue
                sha, ae, date_utc, subject = parts
                # Verify the author email's local part actually matches —
                # accept any @domain so old + new addresses both count.
                ae_local = ae.split("@", 1)[0].lower() if "@" in ae else ae.lower()
                if ae_local != localpart:
                    continue
                emails_seen.add(ae.lower())
                cur = conn.execute(
                    "INSERT OR IGNORE INTO commits(sha, author_email, date_utc, subject, worktree) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (sha, ae, date_utc, subject, str(wt)),
                )
                inserted += cur.rowcount

    db_set_meta(conn, "last_scan_at", now.isoformat())
    if emails_seen:
        db_set_meta(conn, "last_scan_email", ", ".join(sorted(emails_seen)))
    conn.commit()
    return {"skipped": False, "inserted": inserted, "emails": sorted(emails_seen)}


def _walk_jsonl_tokens(path: Path) -> dict:
    """Walk one .jsonl session file, summing usage tokens overall AND per
    UTC day (for the heatmap). Returns:
       {in, out, cache_r, cache_w, asst_msgs, model, last_msg_iso, by_day}
       where by_day maps "YYYY-MM-DD" -> {in,out,cache_r,cache_w}.
       Best-effort: malformed lines skipped, OS errors return zero counts."""
    totals = {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0,
              "asst_msgs": 0, "model": None, "last_msg_iso": None,
              "by_day": {}}
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = obj.get("timestamp")
                if ts:
                    totals["last_msg_iso"] = ts
                m = obj.get("message")
                if not isinstance(m, dict):
                    continue
                if m.get("model"):
                    totals["model"] = m["model"]
                u = m.get("usage")
                if not isinstance(u, dict):
                    continue
                totals["asst_msgs"] += 1
                ti = u.get("input_tokens") or 0
                to = u.get("output_tokens") or 0
                tcr = u.get("cache_read_input_tokens") or 0
                tcw = u.get("cache_creation_input_tokens") or 0
                totals["in"]      += ti
                totals["out"]     += to
                totals["cache_r"] += tcr
                totals["cache_w"] += tcw
                # Bucket by UTC date from the entry's timestamp. The jsonl
                # format uses ISO-8601 UTC like "2026-05-07T18:30:00Z".
                if ts and len(ts) >= 10:
                    day = ts[:10]
                    bucket = totals["by_day"].setdefault(day, {"in":0,"out":0,"cache_r":0,"cache_w":0})
                    bucket["in"]      += ti
                    bucket["out"]     += to
                    bucket["cache_r"] += tcr
                    bucket["cache_w"] += tcw
    except OSError:
        pass
    return totals


def _claude_project_to_issue_repo(name: str, worktrees_root: Path) -> tuple[str, str] | None:
    """Map a ~/.claude/projects/<encoded> dirname back to (issue, repo).
       Encoded form is the worktree path with '/' → '-'. Both the issue and
       repo names can contain dashes (e.g. 'man-remove_maven_formatter' /
       'claude-plugins'), so we try every split point and return the first
       one for which `worktrees_root/<issue>/<repo>` actually exists on
       disk. Tried longest-issue first to stay deterministic when several
       splits would match.

       Special cases also handled:
       - General Agent (cwd = worktrees_root itself) → ('__agent__', '')
       - Issue-level agent (cwd = worktrees_root/<issue>) → (issue, '')
    """
    # Claude Code encodes the absolute worktree path by replacing the
    # platform path separator (and the alternate one, when set) with
    # '-'. Forward slash on POSIX, backslash on Windows.
    root_encoded = re.sub(r"[/\\]", "-", str(worktrees_root)).rstrip("-")
    # General Agent: runs from worktrees_root itself.
    if name == root_encoded:
        return ("__agent__", "")
    prefix = root_encoded + "-"
    if not name.startswith(prefix):
        return None
    rest = name[len(prefix):]   # e.g. "BSS-10029-core" or "BSS-10173-claude-plugins"
    parts = rest.split("-")
    for split in range(len(parts) - 1, 0, -1):
        issue = "-".join(parts[:split])
        repo = "-".join(parts[split:])
        if (worktrees_root / issue / repo).is_dir():
            return issue, repo
    # Issue-level session: agent opened at worktrees_root/<issue> with no
    # repo subdir (e.g. the user ran claude from the issue dir directly).
    if (worktrees_root / rest).is_dir():
        return (rest, "")
    return None


def scan_agent_tokens(worktrees_root: Path, conn: sqlite3.Connection) -> dict:
    """Throttled walk of every ~/.claude/projects/<encoded>/*.jsonl file.
       Updates the agent_session_files cache incrementally — files whose
       (mtime, size) hasn't changed since the last walk are skipped."""
    last_scan = db_get_meta(conn, "last_token_scan_at")
    now = datetime.now()
    if last_scan:
        try:
            last_dt = datetime.fromisoformat(last_scan)
            if (now - last_dt).total_seconds() < TOKEN_SCAN_THROTTLE_SECONDS:
                return {"skipped": True}
        except ValueError:
            pass

    projects_dir = HOME / ".claude" / "projects"
    walked = 0
    refreshed = 0
    if projects_dir.is_dir():
        for proj in projects_dir.iterdir():
            if not proj.is_dir():
                continue
            mapping = _claude_project_to_issue_repo(proj.name, worktrees_root)
            if mapping is None:
                continue
            issue, repo = mapping
            for f in proj.glob("*.jsonl"):
                walked += 1
                try:
                    st = f.stat()
                except OSError:
                    continue
                row = conn.execute(
                    "SELECT mtime, size FROM agent_session_files WHERE file_path=?",
                    (str(f),),
                ).fetchone()
                # Skip only if file is unchanged AND we have its per-day
                # rows (for the token heatmap). The latter check covers
                # the schema-upgrade case where agent_session_file_days
                # was added after agent_session_files was already populated.
                has_days = conn.execute(
                    "SELECT 1 FROM agent_session_file_days WHERE file_path=? LIMIT 1",
                    (str(f),),
                ).fetchone() if row else None
                if row and row[0] == st.st_mtime and row[1] == st.st_size and has_days:
                    continue   # file unchanged since last walk and per-day rows present
                t = _walk_jsonl_tokens(f)
                conn.execute(
                    "INSERT OR REPLACE INTO agent_session_files("
                    "file_path, issue, repo, mtime, size, in_tokens, out_tokens, "
                    "cache_r_tokens, cache_w_tokens, asst_msgs, model, last_msg_iso, walked_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (str(f), issue, repo, st.st_mtime, st.st_size,
                     t["in"], t["out"], t["cache_r"], t["cache_w"],
                     t["asst_msgs"], t["model"], t["last_msg_iso"],
                     now.isoformat(timespec="seconds")),
                )
                # Replace this file's per-day rows so re-walking is idempotent.
                conn.execute("DELETE FROM agent_session_file_days WHERE file_path=?", (str(f),))
                for day, b in t["by_day"].items():
                    conn.execute(
                        "INSERT INTO agent_session_file_days("
                        "file_path, date_utc, in_tokens, out_tokens, "
                        "cache_r_tokens, cache_w_tokens) VALUES (?, ?, ?, ?, ?, ?)",
                        (str(f), day, b["in"], b["out"], b["cache_r"], b["cache_w"]),
                    )
                refreshed += 1
    db_set_meta(conn, "last_token_scan_at", now.isoformat())
    conn.commit()
    return {"walked": walked, "refreshed": refreshed}


def agent_tokens_for(conn: sqlite3.Connection, issue: str, repo: str) -> dict:
    """Aggregate per-(issue, repo) totals from the per-file cache."""
    row = conn.execute(
        "SELECT COUNT(*), SUM(in_tokens), SUM(out_tokens), SUM(cache_r_tokens), "
        "SUM(cache_w_tokens), SUM(asst_msgs), MAX(last_msg_iso) "
        "FROM agent_session_files WHERE issue=? AND repo=?",
        (issue, repo),
    ).fetchone()
    if not row or not row[0]:
        return {}
    n_files, t_in, t_out, t_cr, t_cw, t_msg, last_iso = row
    # Pick the most-recently-used model for this issue/repo for cost estimation.
    model_row = conn.execute(
        "SELECT model FROM agent_session_files WHERE issue=? AND repo=? "
        "AND model IS NOT NULL ORDER BY last_msg_iso DESC LIMIT 1",
        (issue, repo),
    ).fetchone()
    model = model_row[0] if model_row else None
    tokens = {"in": t_in or 0, "out": t_out or 0,
              "cache_r": t_cr or 0, "cache_w": t_cw or 0}
    return {
        "files": n_files,
        "tokens": tokens,
        "asst_msgs": t_msg or 0,
        "last_msg_iso": last_iso,
        "model": model,
        "cost_usd": round(estimate_cost(model, tokens), 4),
    }


# ── Worktree persistence (for "ghost" worktrees) ─────────────────────────
def upsert_worktree(conn: sqlite3.Connection, repo_data: dict) -> None:
    """Snapshot the current state of one repo checkout into the DB."""
    now = datetime.now().isoformat(timespec="seconds")
    conn.execute(
        """
        INSERT INTO worktrees(
          issue, repo, path, first_seen, last_seen,
          branch, upstream, ahead, behind, n_dirty, n_unpushed,
          last_commit, last_commit_when, last_commit_author
        ) VALUES (
          :issue, :repo, :path, :now, :now,
          :branch, :upstream, :ahead, :behind, :n_dirty, :n_unpushed,
          :last_commit, :last_commit_when, :last_commit_author
        )
        ON CONFLICT(issue, repo) DO UPDATE SET
          last_seen          = :now,
          path               = :path,
          branch             = :branch,
          upstream           = :upstream,
          ahead              = :ahead,
          behind             = :behind,
          n_dirty            = :n_dirty,
          n_unpushed         = :n_unpushed,
          last_commit        = :last_commit,
          last_commit_when   = :last_commit_when,
          last_commit_author = :last_commit_author
        """,
        {
            "now": now,
            "issue": repo_data["issue"],
            "repo": repo_data["repo"],
            "path": repo_data["path"],
            "branch": repo_data["branch"],
            "upstream": repo_data["upstream"],
            "ahead": repo_data["ahead"],
            "behind": repo_data["behind"],
            "n_dirty": repo_data["n_dirty"],
            "n_unpushed": repo_data["n_unpushed"],
            "last_commit": repo_data["last_commit"],
            "last_commit_when": repo_data["last_commit_when"],
            "last_commit_author": repo_data["last_commit_author"],
        },
    )


def load_ghost_worktrees(conn: sqlite3.Connection, current_paths: set[str]) -> list[dict]:
    """
    Return snapshot dicts for every stored worktree whose `path` is no longer
    on disk. Each dict mirrors gather_repo_status' shape so the dashboard can
    render it the same way, with `ghost: True` and `removed_at` set so the UI
    can mark them.
    """
    rows = conn.execute(
        "SELECT issue, repo, path, first_seen, last_seen, branch, upstream, "
        "ahead, behind, n_dirty, n_unpushed, last_commit, last_commit_when, "
        "last_commit_author FROM worktrees"
    ).fetchall()
    ghosts = []
    for r in rows:
        path = r[2]
        if path in current_paths or Path(path).exists():
            continue
        (issue, repo, _path, first_seen, last_seen, branch, upstream,
         ahead, behind, n_dirty, n_unpushed,
         last_commit, last_when, last_author) = r
        ghosts.append({
            "issue": issue, "repo": repo, "path": path,
            "branch": branch or "?",
            "upstream": upstream or "",
            "ahead": ahead if ahead is not None else -1,
            "behind": behind if behind is not None else -1,
            "n_dirty": n_dirty or 0,
            "dirty_files": [],
            "n_unpushed": n_unpushed or 0,
            "unpushed": [],
            "upstream_configured": bool(upstream),
            "last_commit": last_commit or "",
            "last_commit_when": last_when or "",
            "last_commit_author": last_author or "",
            "last_commits": [],
            "last_claude": "—",
            "last_build": "—",
            "ghost": True,
            "first_seen": first_seen,
            "removed_at": last_seen,
            "too_behind": False,   # don't bias warning counts toward removed work
        })
    return ghosts


def heatmap_data(conn: sqlite3.Connection, days: int = HEATMAP_DAYS) -> dict:
    """Return zero-filled [{date, count}] for the last `days` days plus today."""
    end = datetime.now().date()
    start = end - timedelta(days=days - 1)
    rows = conn.execute(
        "SELECT date_utc, COUNT(*) FROM commits "
        "WHERE date_utc BETWEEN ? AND ? GROUP BY date_utc",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    counts = {date: c for date, c in rows}
    series = []
    cursor = start
    while cursor <= end:
        d = cursor.isoformat()
        series.append({"date": d, "count": counts.get(d, 0)})
        cursor += timedelta(days=1)
    total = sum(it["count"] for it in series)
    longest_day = max(series, key=lambda x: x["count"], default={"date": None, "count": 0})
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "days": days,
        "total": total,
        "max_per_day": longest_day["count"],
        "series": series,
        "email": db_get_meta(conn, "last_scan_email"),
        "last_scan_at": db_get_meta(conn, "last_scan_at"),
        "kind": "commits",
        "unit": "commit",
    }


def token_heatmap_data(conn: sqlite3.Connection, days: int = HEATMAP_DAYS) -> dict:
    """Per-day total tokens across every observed Claude session, plus
    estimated cost. The same window/zero-fill shape as heatmap_data so the
    client can render both with the same SVG builder."""
    end = datetime.now().date()
    start = end - timedelta(days=days - 1)
    rows = conn.execute(
        "SELECT date_utc, "
        "SUM(in_tokens), SUM(out_tokens), SUM(cache_r_tokens), SUM(cache_w_tokens) "
        "FROM agent_session_file_days "
        "WHERE date_utc BETWEEN ? AND ? GROUP BY date_utc",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    by_day = {r[0]: {"in": r[1] or 0, "out": r[2] or 0,
                     "cache_r": r[3] or 0, "cache_w": r[4] or 0} for r in rows}

    # Pick the most recent recorded model as the representative one for
    # cost estimation; mixing models per-day would inflate complexity.
    model_row = conn.execute(
        "SELECT model FROM agent_session_files "
        "WHERE model IS NOT NULL ORDER BY last_msg_iso DESC LIMIT 1"
    ).fetchone()
    model = model_row[0] if model_row else None

    series = []
    cursor = start
    total = 0
    total_cost = 0.0
    while cursor <= end:
        d = cursor.isoformat()
        b = by_day.get(d)
        if b:
            tot = b["in"] + b["out"] + b["cache_r"] + b["cache_w"]
            cost = estimate_cost(model, b)
        else:
            tot = 0
            cost = 0.0
        series.append({"date": d, "count": tot, "cost_usd": round(cost, 4)})
        total += tot
        total_cost += cost
        cursor += timedelta(days=1)
    longest_day = max(series, key=lambda x: x["count"], default={"date": None, "count": 0})
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "days": days,
        "total": total,
        "total_cost_usd": round(total_cost, 4),
        "max_per_day": longest_day["count"],
        "series": series,
        "model": model,
        "kind": "tokens",
        "unit": "token",
    }


# ── Week summaries ───────────────────────────────────────────────────────
WEEK_CURRENT_TTL = 60 * 60        # regenerate current-week cache after 1h
ISSUE_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")


def _issue_from_worktree(path: str) -> str:
    """Extract the issue id from a worktree path '.../worktrees/<issue>/<repo>'."""
    if not path:
        return ""
    parts = Path(path).parts
    return parts[-2] if len(parts) >= 2 else ""


def generate_week_summary(conn: sqlite3.Connection, week_id: str) -> dict:
    """Build a summary blob for one ISO week from existing tables.

    Pulls commits + agent token data; nothing here calls Claude or git.
    Returns the JSON-serialisable shape consumed by the dashboard modal.
    """
    start, end = week_bounds(week_id)

    # Commits in week, grouped by day + by issue.
    rows = conn.execute(
        "SELECT date_utc, subject, worktree FROM commits "
        "WHERE date_utc BETWEEN ? AND ? ORDER BY date_utc",
        (start, end),
    ).fetchall()
    commits_by_day: dict[str, int] = {}
    commits_by_issue: dict[str, dict] = {}
    repos_seen: set[str] = set()
    for date_utc, subject, worktree in rows:
        commits_by_day[date_utc] = commits_by_day.get(date_utc, 0) + 1
        issue = _issue_from_worktree(worktree) or "(other)"
        rec = commits_by_issue.setdefault(issue, {
            "issue": issue, "commits": 0, "subjects": [], "repos": set(),
        })
        rec["commits"] += 1
        if len(rec["subjects"]) < 5:
            rec["subjects"].append(subject)
        # Last segment of worktree path is the repo dir name.
        repo = Path(worktree).name if worktree else ""
        if repo:
            rec["repos"].add(repo)
            repos_seen.add(repo)

    # Tokens in week — join file_days against files for issue/model attribution.
    tok_rows = conn.execute("""
        SELECT
          f.issue, f.repo, f.model,
          d.date_utc,
          d.in_tokens, d.out_tokens, d.cache_r_tokens, d.cache_w_tokens
        FROM agent_session_file_days d
        JOIN agent_session_files f ON f.file_path = d.file_path
        WHERE d.date_utc BETWEEN ? AND ?
    """, (start, end)).fetchall()
    tokens_total = {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0}
    cost_total = 0.0
    tokens_by_day: dict[str, int] = {}
    tokens_by_issue: dict[str, dict] = {}
    models_seen: dict[str, int] = {}
    for issue, _repo, model, date_utc, t_in, t_out, t_cr, t_cw in tok_rows:
        rec = {"in": t_in or 0, "out": t_out or 0,
               "cache_r": t_cr or 0, "cache_w": t_cw or 0}
        for k, v in rec.items():
            tokens_total[k] += v
        day_total = sum(rec.values())
        tokens_by_day[date_utc] = tokens_by_day.get(date_utc, 0) + day_total
        cost = estimate_cost(model, rec)
        cost_total += cost
        ikey = issue or "(other)"
        ix = tokens_by_issue.setdefault(ikey, {
            "issue": ikey, "tokens": 0, "cost_usd": 0.0,
        })
        ix["tokens"] += day_total
        ix["cost_usd"] += cost
        if model:
            models_seen[model] = models_seen.get(model, 0) + day_total

    # Merge commit + token rollups per issue, then flatten. Worklog
    # minutes are folded in further down so the issue list also reflects
    # time spent.
    issues_merged: dict[str, dict] = {}
    for issue, c in commits_by_issue.items():
        issues_merged[issue] = {
            "issue": issue,
            "commits": c["commits"],
            "subjects": c["subjects"],
            "repos": sorted(c["repos"]),
            "tokens": 0,
            "cost_usd": 0.0,
        }
    for issue, t in tokens_by_issue.items():
        m = issues_merged.setdefault(issue, {
            "issue": issue, "commits": 0, "subjects": [], "repos": [],
            "tokens": 0, "cost_usd": 0.0,
        })
        m["tokens"] = t["tokens"]
        m["cost_usd"] = round(t["cost_usd"], 2)

    # Work logs in week — manual + timer entries from the work_logs table,
    # plus a synthetic per-issue "agent" entry built from active agent time
    # in the JSONL session files. Each issue gets at most one agent entry
    # per week (matching the user-stated requirement: one worklog per issue).
    worklogs = list_worklogs_in_range(conn, start, end)
    agent_mins = agent_active_minutes_in_range(conn, start, end)
    excluded = list_excluded_agent_for_week(conn, week_id)
    if agent_mins:
        agent_ts = int(time.time())
        for issue_id, mins in sorted(agent_mins.items(),
                                      key=lambda kv: -kv[1]):
            if issue_id in excluded:
                continue
            worklogs.append({
                "id": None,
                "issue": issue_id,
                "date_local": end,           # bucket on the week-end date
                "minutes": mins,
                "comment": "Agent activity (auto-tracked)",
                "source": "agent",
                "created_at": agent_ts,
            })
    minutes_by_day: dict[str, int] = {}
    minutes_by_issue: dict[str, int] = {}
    for w in worklogs:
        minutes_by_day[w["date_local"]] = minutes_by_day.get(w["date_local"], 0) + w["minutes"]
        minutes_by_issue[w["issue"]] = minutes_by_issue.get(w["issue"], 0) + w["minutes"]
    total_minutes = sum(minutes_by_day.values())
    for issue, mins in minutes_by_issue.items():
        m = issues_merged.setdefault(issue, {
            "issue": issue, "commits": 0, "subjects": [], "repos": [],
            "tokens": 0, "cost_usd": 0.0,
        })
        m["minutes"] = mins
    # Make sure every issue in the merged set has a `minutes` field even if 0.
    for it in issues_merged.values():
        it.setdefault("minutes", 0)
    issues_list = sorted(issues_merged.values(),
                         key=lambda x: (-x["commits"], -x["minutes"], -x["tokens"]))

    # Per-day series (zero-filled across the 7-day window).
    by_day = []
    cursor = datetime.fromisoformat(start).date()
    end_d = datetime.fromisoformat(end).date()
    most_active = {"date": None, "commits": 0}
    while cursor <= end_d:
        d = cursor.isoformat()
        c = commits_by_day.get(d, 0)
        by_day.append({
            "date": d, "commits": c,
            "tokens": tokens_by_day.get(d, 0),
            "minutes": minutes_by_day.get(d, 0),
        })
        if c > most_active["commits"]:
            most_active = {"date": d, "commits": c}
        cursor += timedelta(days=1)

    return {
        "week_id": week_id,
        "start": start,
        "end": end,
        "is_current": week_id == iso_week_id(),
        "totals": {
            "commits": sum(commits_by_day.values()),
            "active_days": sum(1 for v in commits_by_day.values() if v > 0),
            "issues": sum(1 for it in issues_list if it["commits"] > 0 or it["minutes"] > 0),
            "repos": sorted(repos_seen),
            "tokens": tokens_total,
            "tokens_total": sum(tokens_total.values()),
            "cost_usd": round(cost_total, 2),
            "minutes": total_minutes,
        },
        "by_day": by_day,
        "by_issue": issues_list[:20],
        "worklogs": worklogs,
        "models": sorted(
            ({"model": m, "tokens": t} for m, t in models_seen.items()),
            key=lambda x: -x["tokens"]),
        "most_active_day": most_active,
    }


def get_week_summary(conn: sqlite3.Connection, week_id: str,
                     force: bool = False) -> dict:
    """Return the cached summary, regenerating + persisting on miss / stale.

    Past weeks: cache forever (regenerate only when force=True).
    Current week: regenerate when older than WEEK_CURRENT_TTL.
    """
    row = conn.execute(
        "SELECT generated_at, content_json FROM week_summaries WHERE week_id = ?",
        (week_id,),
    ).fetchone()
    is_current = (week_id == iso_week_id())
    fresh_enough = False
    if row and not force:
        if not is_current:
            fresh_enough = True
        elif (time.time() - row[0]) < WEEK_CURRENT_TTL:
            fresh_enough = True
    if fresh_enough:
        try:
            blob = json.loads(row[1])
            # The cached blob's is_current was stamped at generation
            # time. Re-derive it against today's ISO week so a week
            # that has rolled over loses the (current) label.
            blob["is_current"] = is_current
            return blob
        except (ValueError, TypeError):
            pass  # corrupt blob — regenerate
    summary = generate_week_summary(conn, week_id)
    summary["generated_at"] = int(time.time())
    summary["generated_iso"] = datetime.fromtimestamp(summary["generated_at"]).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO week_summaries(week_id, generated_at, content_json) VALUES (?,?,?) "
        "ON CONFLICT(week_id) DO UPDATE SET generated_at=excluded.generated_at, "
        "content_json=excluded.content_json",
        (week_id, summary["generated_at"], json.dumps(summary)),
    )
    conn.commit()
    return summary


def autofill_week_summaries(conn: sqlite3.Connection, weeks_back: int = 4) -> list[str]:
    """Generate any *past* week summaries from the last `weeks_back` weeks
    that aren't already cached. Skips the current week (covered on access).
    Returns the list of week_ids that were generated."""
    today = datetime.now()
    generated = []
    for n in range(1, weeks_back + 1):
        d = today - timedelta(weeks=n)
        wid = iso_week_id(d)
        row = conn.execute(
            "SELECT 1 FROM week_summaries WHERE week_id = ?", (wid,)
        ).fetchone()
        if row:
            continue
        # Only generate if there's actually data in the week — empty weeks
        # would produce a zero-everywhere summary that's just noise.
        start, end = week_bounds(wid)
        has_commits = conn.execute(
            "SELECT 1 FROM commits WHERE date_utc BETWEEN ? AND ? LIMIT 1",
            (start, end),
        ).fetchone()
        has_tokens = conn.execute(
            "SELECT 1 FROM agent_session_file_days WHERE date_utc BETWEEN ? AND ? LIMIT 1",
            (start, end),
        ).fetchone()
        if not (has_commits or has_tokens):
            continue
        get_week_summary(conn, wid)
        generated.append(wid)
    return generated


# Maximum gap between consecutive session messages that still counts as
# "active" agent time. Larger gaps are treated as idle (e.g. you stepped
# away while a session was open). 5 min ≈ comfortable thinking time.
ACTIVE_GAP_THRESHOLD_S = 300


def _walk_jsonl_active_seconds(path: Path, start: str, end: str) -> float:
    """Sum message-to-message gaps (capped at ACTIVE_GAP_THRESHOLD_S) inside
    [start, end] for one JSONL session file. Estimate of "active agent
    time" — gaps above the cap are treated as idle and ignored."""
    total = 0.0
    prev_dt: datetime | None = None
    try:
        with path.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = obj.get("timestamp")
                if not ts or len(ts) < 10:
                    continue
                day = ts[:10]
                # Reset prev_dt whenever we cross out of the range so a
                # huge cross-week gap doesn't roll into the next session.
                if day < start or day > end:
                    prev_dt = None
                    continue
                try:
                    cur = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if prev_dt is not None:
                    delta = (cur - prev_dt).total_seconds()
                    if 0 < delta <= ACTIVE_GAP_THRESHOLD_S:
                        total += delta
                prev_dt = cur
    except OSError:
        return 0.0
    return total


def agent_active_minutes_in_range(
    conn: sqlite3.Connection, start: str, end: str,
) -> dict[str, int]:
    """Per-issue active agent minutes during [start, end] inclusive,
    computed by walking the JSONL session files whose `last_msg_iso` is on
    or after `start`. Returns {issue: minutes}."""
    rows = conn.execute(
        "SELECT file_path, issue FROM agent_session_files "
        "WHERE last_msg_iso IS NOT NULL AND substr(last_msg_iso, 1, 10) >= ?",
        (start,),
    ).fetchall()
    per_issue: dict[str, float] = {}
    for file_path, issue in rows:
        secs = _walk_jsonl_active_seconds(Path(file_path), start, end)
        if secs > 0:
            per_issue[issue] = per_issue.get(issue, 0.0) + secs
    return {iss: int(round(s / 60)) for iss, s in per_issue.items() if s >= 30}


def list_week_summaries(conn: sqlite3.Connection) -> list[dict]:
    """Index of cached summaries with compact per-week stats — drives the
    list view in the week-summary modal. Newest first; weeks beyond the
    current ISO week are filtered out (no value in showing the future)."""
    cutoff = iso_week_id()  # current week, e.g. '2026-W19'
    rows = conn.execute(
        "SELECT week_id, generated_at, content_json FROM week_summaries "
        "WHERE week_id <= ? ORDER BY week_id DESC",
        (cutoff,),
    ).fetchall()
    # Compute is_current against today's ISO week, not the cached
    # blob's is_current flag — that flag was stamped at generation
    # time and goes stale the moment the week rolls over.
    today_week = iso_week_id()
    out = []
    for week_id, generated_at, content in rows:
        try:
            blob = json.loads(content) if content else {}
        except (ValueError, TypeError):
            blob = {}
        t = blob.get("totals") or {}
        out.append({
            "week_id": week_id,
            "generated_at": generated_at,
            "start": blob.get("start"),
            "end": blob.get("end"),
            "is_current": week_id == today_week,
            "commits": t.get("commits", 0),
            "minutes": t.get("minutes", 0),
            "tokens_total": t.get("tokens_total", 0),
            "cost_usd": t.get("cost_usd", 0.0),
            "issues": t.get("issues", 0),
        })
    return out


# ── Work logs + timer ────────────────────────────────────────────────────
def list_worklogs_in_range(
    conn: sqlite3.Connection, start: str, end: str,
) -> list[dict]:
    """Return work logs whose `date_local` falls within [start, end] inclusive,
    ordered newest first."""
    rows = conn.execute(
        "SELECT id, issue, date_local, minutes, comment, source, created_at "
        "FROM work_logs WHERE date_local BETWEEN ? AND ? "
        "ORDER BY date_local DESC, id DESC",
        (start, end),
    ).fetchall()
    return [{
        "id": r[0], "issue": r[1], "date_local": r[2], "minutes": r[3],
        "comment": r[4] or "", "source": r[5], "created_at": r[6],
    } for r in rows]


def add_worklog(conn: sqlite3.Connection, issue: str, minutes: int,
                date_local: str | None = None, comment: str = "",
                source: str = "manual") -> dict:
    issue = (issue or "").strip()
    if not issue:
        raise ValueError("issue is required")
    if minutes <= 0:
        raise ValueError("minutes must be > 0")
    date_local = date_local or datetime.now().strftime("%Y-%m-%d")
    now = int(time.time())
    cur = conn.execute(
        "INSERT INTO work_logs(issue, date_local, minutes, comment, source, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (issue, date_local, int(minutes), comment or None, source, now),
    )
    conn.commit()
    return {
        "id": cur.lastrowid, "issue": issue, "date_local": date_local,
        "minutes": int(minutes), "comment": comment or "",
        "source": source, "created_at": now,
    }


def delete_worklog(conn: sqlite3.Connection, log_id: int) -> bool:
    cur = conn.execute("DELETE FROM work_logs WHERE id = ?", (log_id,))
    conn.commit()
    return cur.rowcount > 0


def get_timer(conn: sqlite3.Connection) -> dict | None:
    row = conn.execute(
        "SELECT issue, started_at, comment FROM timer_state WHERE id = 1"
    ).fetchone()
    if not row:
        return None
    return {"issue": row[0], "started_at": row[1], "comment": row[2] or "",
            "elapsed_seconds": int(time.time() - row[1])}


def start_timer(conn: sqlite3.Connection, issue: str,
                comment: str = "") -> dict:
    issue = (issue or "").strip()
    if not issue:
        raise ValueError("issue is required")
    # If a timer is already running, replace it (don't silently lose it —
    # auto-stop the previous one first by writing a worklog).
    prev = get_timer(conn)
    if prev:
        finalize_timer(conn, comment=prev["comment"])
    now = int(time.time())
    conn.execute(
        "INSERT INTO timer_state(id, issue, started_at, comment) VALUES (1,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET issue=excluded.issue, "
        "started_at=excluded.started_at, comment=excluded.comment",
        (issue, now, comment or None),
    )
    conn.commit()
    return get_timer(conn)


def update_timer_comment(conn: sqlite3.Connection, comment: str) -> dict | None:
    """Live-edit the comment without restarting the timer."""
    cur = conn.execute(
        "UPDATE timer_state SET comment = ? WHERE id = 1",
        (comment or None,),
    )
    conn.commit()
    if cur.rowcount == 0:
        return None
    return get_timer(conn)


def finalize_timer(
    conn: sqlite3.Connection, comment: str = "", min_minutes: int = 1,
) -> dict | None:
    """Stop the running timer and write a worklog for the elapsed time
    (rounded to nearest minute, never less than `min_minutes`). Returns the
    created worklog, or None if no timer was running."""
    row = conn.execute(
        "SELECT issue, started_at, comment FROM timer_state WHERE id = 1"
    ).fetchone()
    if not row:
        return None
    issue, started_at, prev_comment = row
    elapsed = max(min_minutes, round((time.time() - started_at) / 60))
    final_comment = (comment or prev_comment or "").strip()
    log = add_worklog(
        conn, issue=issue, minutes=elapsed,
        date_local=datetime.fromtimestamp(started_at).strftime("%Y-%m-%d"),
        comment=final_comment, source="timer",
    )
    conn.execute("DELETE FROM timer_state WHERE id = 1")
    conn.commit()
    return log


def exclude_agent_worklog(
    conn: sqlite3.Connection, issue: str, week_id: str,
) -> bool:
    """User-delete an agent worklog row by remembering (issue, week_id) so
    generate_week_summary skips it next time. Returns True if a new row was
    inserted (idempotent — duplicates ignored)."""
    issue = (issue or "").strip()
    if not issue or not re.match(r"^\d{4}-W\d{2}$", week_id or ""):
        raise ValueError("issue and ISO week_id are required")
    cur = conn.execute(
        "INSERT OR IGNORE INTO agent_worklog_exclusions(issue, week_id) "
        "VALUES (?, ?)", (issue, week_id),
    )
    conn.commit()
    return cur.rowcount > 0


def list_excluded_agent_for_week(
    conn: sqlite3.Connection, week_id: str,
) -> set[str]:
    rows = conn.execute(
        "SELECT issue FROM agent_worklog_exclusions WHERE week_id = ?",
        (week_id,),
    ).fetchall()
    return {r[0] for r in rows}


def invalidate_week_summary_for_date(
    conn: sqlite3.Connection, date_local: str,
) -> None:
    """Drop the cached summary for the ISO week containing `date_local`,
    so the next /api/week-summary call regenerates with fresh data."""
    try:
        d = datetime.fromisoformat(date_local)
    except ValueError:
        return
    wid = iso_week_id(d)
    conn.execute("DELETE FROM week_summaries WHERE week_id = ?", (wid,))
    conn.commit()


def known_issues(conn: sqlite3.Connection, limit: int = 50) -> list[str]:
    """Distinct issue keys we've seen on disk (live or ghost worktrees) +
    any issue with a recent worklog. Drives the timer/worklog issue picker."""
    rows = conn.execute(
        "SELECT DISTINCT issue FROM ("
        "  SELECT issue, last_seen AS ord FROM worktrees "
        "  UNION ALL "
        "  SELECT issue, date_local AS ord FROM work_logs "
        ") ORDER BY ord DESC LIMIT ?",
        (limit,),
    ).fetchall()
    seen: set[str] = set()
    out: list[str] = []
    for (issue,) in rows:
        if issue and issue not in seen:
            out.append(issue)
            seen.add(issue)
    return out


# Disk-usage helper lives in awlib.disk now (see imports at the top).


# ── Plain-text sync (data/) ──────────────────────────────────────────────
def export_data(conn: sqlite3.Connection) -> None:
    """
    Mirror the SQLite cache to data/<user>/commits.jsonl + worktrees.json so
    the state is portable in git. Path-independent: stores only (issue, repo)
    keys. Each user writes only their own subfolder, so multi-user setups
    can coexist on master without merge conflicts.
    """
    out_dir = user_data_dir()
    out_dir.mkdir(parents=True, exist_ok=True)

    # Commits — alphabetical by sha so the file is deterministic and git's
    # union-merge driver can resolve concurrent inserts.
    rows = conn.execute(
        "SELECT sha, author_email, date_utc, subject, worktree FROM commits ORDER BY sha"
    ).fetchall()
    with user_commits_jsonl().open("w") as f:
        for sha, ae, date_utc, subject, worktree in rows:
            f.write(json.dumps({
                "sha": sha, "author_email": ae,
                "date_utc": date_utc, "subject": subject,
                "worktree_tail": _tail_of(worktree),
            }, ensure_ascii=False) + "\n")

    # Worktrees — single JSON object keyed by "issue/repo", deterministic.
    # IMPORTANT: every field here ends up in git commits. Timestamps that
    # advance every tick (last_seen, last_commit_when, exported_at) would
    # cause a commit on every sync and explode the repo with no-op churn.
    # So we exclude all moving timestamps and only persist stable facts —
    # the file changes only when something substantive about the worktree
    # changes (new commit, dirty/unpushed/ahead/behind shift).
    cols = ("issue", "repo", "first_seen", "branch", "upstream",
            "ahead", "behind", "n_dirty", "n_unpushed",
            "last_commit", "last_commit_author")
    rows = conn.execute(
        f"SELECT {', '.join(cols)} FROM worktrees ORDER BY issue, repo"
    ).fetchall()
    snap: dict[str, dict] = {}
    for row in rows:
        d = dict(zip(cols, row, strict=False))
        snap[f"{d['issue']}/{d['repo']}"] = d
    user_worktrees_json().write_text(
        json.dumps(snap, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    )

    # meta.json was previously written here with exported_at — but a
    # timestamp that changes every 5 min causes a no-op commit every
    # sync. If the meta.json file already exists from older versions,
    # delete it once so it doesn't keep dirtying the working tree.
    stale_meta = user_meta_json()
    if stale_meta.exists():
        stale_meta.unlink()

    # Agent token totals — one entry per (issue, repo), bucketed per
    # machine so a user with multiple machines doesn't have laptop and
    # desktop overwriting each other. When totals are unchanged the file
    # bytes are identical and the no-op commit guard skips the commit.
    hostname = socket.gethostname()
    rows = conn.execute(
        "SELECT issue, repo, COUNT(*) AS files, SUM(in_tokens), SUM(out_tokens), "
        "SUM(cache_r_tokens), SUM(cache_w_tokens), SUM(asst_msgs), "
        "(SELECT model FROM agent_session_files asf2 "
        " WHERE asf2.issue=asf.issue AND asf2.repo=asf.repo AND model IS NOT NULL "
        " ORDER BY last_msg_iso DESC LIMIT 1) AS model "
        "FROM agent_session_files asf "
        "GROUP BY issue, repo ORDER BY issue, repo"
    ).fetchall()
    # Read existing snapshot (other machines' buckets) so we preserve them.
    existing: dict[str, dict] = {}
    if user_agent_tokens_json().exists():
        try:
            existing = json.loads(user_agent_tokens_json().read_text())
            if not isinstance(existing, dict):
                existing = {}
        except (json.JSONDecodeError, OSError):
            existing = {}

    snap: dict[str, dict] = {}
    for issue, repo, files, t_in, t_out, t_cr, t_cw, t_msg, model in rows:
        key = f"{issue}/{repo}"
        my_bucket = {
            "files":     files,
            "asst_msgs": t_msg or 0,
            "in":        t_in or 0,
            "out":       t_out or 0,
            "cache_r":   t_cr or 0,
            "cache_w":   t_cw or 0,
        }
        prev = existing.get(key, {})
        prev_machines = prev.get("by_machine", {}) if isinstance(prev, dict) else {}
        merged_machines = dict(prev_machines)
        merged_machines[hostname] = my_bucket
        snap[key] = {
            "model":      model or prev.get("model"),
            "by_machine": dict(sorted(merged_machines.items())),
        }
    # Carry over keys we no longer have locally (other machines' worktrees).
    for key, val in existing.items():
        if key not in snap and isinstance(val, dict):
            snap[key] = val

    if snap:
        user_agent_tokens_json().write_text(
            json.dumps(snap, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        )
    elif user_agent_tokens_json().exists():
        # No tokens observed yet — leave any imported snapshot alone, but
        # if we'd previously written an empty file, clear it.
        user_agent_tokens_json().unlink()

    # Preferences — small dict of synced user prefs. Sorted keys for
    # deterministic output so we don't churn on every sync.
    prefs = get_preferences(conn, _user_slug())
    if prefs:
        user_preferences_json().write_text(
            json.dumps(prefs, indent=2, sort_keys=True, ensure_ascii=False)
            + "\n"
        )
    elif user_preferences_json().exists():
        user_preferences_json().unlink()

    # Notes — JSON Lines so the file is append-friendly. Sorted by id
    # to keep the output deterministic and avoid no-op churn.
    notes = list_notes(conn, _user_slug())
    if notes:
        with user_notes_jsonl().open("w") as f:
            for n in sorted(notes, key=lambda x: x["id"]):
                f.write(json.dumps(n, ensure_ascii=False) + "\n")
    elif user_notes_jsonl().exists():
        user_notes_jsonl().unlink()


def _tail_of(path: str) -> str:
    """Return the trailing /<issue>/<repo> portion of a worktree path."""
    if not path:
        return ""
    parts = Path(path).parts
    # Take the last two components if available.
    return "/".join(parts[-2:]) if len(parts) >= 2 else path


def import_data(conn: sqlite3.Connection) -> dict:
    """
    Replay every data/<user>/* file into SQLite. Returns a summary.
    Multi-user safe: imports from all per-user subfolders, so the local
    dashboard shows everyone's data once you've pulled the repo.
    """
    n_commits = 0
    n_worktrees = 0
    n_prefs = 0
    if not DATA_DIR.is_dir():
        return {"commits_imported": 0, "worktrees_imported": 0,
                "preferences_imported": 0}
    my_slug = _user_slug()

    for user_dir in sorted(p for p in DATA_DIR.iterdir() if p.is_dir()):
        commits_file = user_dir / "commits.jsonl"
        if commits_file.exists():
            with commits_file.open() as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    cur = conn.execute(
                        "INSERT OR IGNORE INTO commits(sha, author_email, date_utc, "
                        "subject, worktree) VALUES (?, ?, ?, ?, ?)",
                        (d["sha"], d.get("author_email", ""), d["date_utc"],
                         d.get("subject", ""), d.get("worktree_tail", "")),
                    )
                    n_commits += cur.rowcount

        worktrees_file = user_dir / "worktrees.json"
        if worktrees_file.exists():
            try:
                snap = json.loads(worktrees_file.read_text())
            except json.JSONDecodeError:
                snap = {}
            now_iso = datetime.now().isoformat(timespec="seconds")
            for _key, d in snap.items():
                # Imported snapshots no longer carry last_seen / last_commit_when
                # (those churned every tick). Preserve any local values for
                # those columns so we don't blow them away.
                existing = conn.execute(
                    "SELECT last_seen, last_commit_when, path FROM worktrees "
                    "WHERE issue=? AND repo=?",
                    (d["issue"], d["repo"]),
                ).fetchone()
                local_last_seen, local_last_when, local_path = (
                    existing if existing else (None, None, ""))
                conn.execute(
                    "INSERT OR REPLACE INTO worktrees(issue, repo, path, first_seen, "
                    "last_seen, branch, upstream, ahead, behind, n_dirty, n_unpushed, "
                    "last_commit, last_commit_when, last_commit_author) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (d["issue"], d["repo"], d.get("path", local_path or ""),
                     d.get("first_seen", local_last_seen or now_iso),
                     local_last_seen or now_iso,
                     d.get("branch"), d.get("upstream"),
                     d.get("ahead"), d.get("behind"),
                     d.get("n_dirty"), d.get("n_unpushed"),
                     d.get("last_commit"), local_last_when or "",
                     d.get("last_commit_author")),
                )
                n_worktrees += 1

        # Preferences — only import the local user's own slug. Other
        # users' prefs travel with their slug; we don't merge across users.
        if user_dir.name == my_slug:
            prefs_file = user_dir / "preferences.json"
            if prefs_file.exists():
                try:
                    pref_snap = json.loads(prefs_file.read_text())
                except json.JSONDecodeError:
                    pref_snap = None
                if isinstance(pref_snap, dict):
                    set_preferences(conn, my_slug, pref_snap)
                    n_prefs += len(pref_snap)

        # Notes — every user's notes live under their own slug, so
        # everyone can see everyone's notes after a pull. Old jsonl
        # rows (pre-P4) lack tags / due_at / priority / assignee /
        # sort_order — the .get() defaults below preserve the column
        # defaults from DB_SCHEMA.
        notes_file = user_dir / "notes.jsonl"
        if notes_file.exists():
            for line in notes_file.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                tags_val = d.get("tags")
                if not isinstance(tags_val, list):
                    tags_val = []
                # INSERT OR REPLACE on id keeps the same row through
                # edits; missing-on-disk rows on this machine get created.
                conn.execute(
                    "INSERT OR REPLACE INTO notes(id, user_slug, issue, "
                    "content, status, created_at, updated_at, "
                    "tags, due_at, priority, assignee, sort_order) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (d.get("id"), user_dir.name, d.get("issue", ""),
                     d.get("content", ""), d.get("status", "todo"),
                     d.get("created_at") or int(time.time()),
                     d.get("updated_at") or int(time.time()),
                     json.dumps(tags_val),
                     d.get("due_at"),
                     d.get("priority") or "normal",
                     d.get("assignee"),
                     d.get("sort_order")))

    conn.commit()
    return {"commits_imported": n_commits, "worktrees_imported": n_worktrees,
            "preferences_imported": n_prefs}


def _git_repo(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    """Run a git command in the agent-workspace repo itself."""
    return subprocess.run(
        ["git", "-C", str(REPO_DIR), *args],
        capture_output=True, text=True, check=check,
    )


def materialize_missing_worktrees(worktrees_root: Path, primaries_root: Path | None = None) -> list[dict]:
    """
    Walk MY data/<user>/worktrees.json (your own snapshot only — never
    teammates'). For each entry whose <worktrees_root>/<issue>/<repo> dir
    is missing, create it via `git worktree add`, fetching the branch
    from origin first if needed. Existing worktrees are never touched.

    `primaries_root` defaults to `worktrees_root.parent` — e.g. with
    `--worktrees ~/github/worktrees` the primary checkouts are expected at
    `~/github/<repo>`.

    Returns a list of {issue, repo, action, ok, message} dicts.
    """
    if primaries_root is None:
        primaries_root = worktrees_root.parent

    snap_file = user_worktrees_json()
    if not snap_file.exists():
        return []
    try:
        snap = json.loads(snap_file.read_text())
    except json.JSONDecodeError:
        return []

    results: list[dict] = []
    for _key, d in snap.items():
        issue = d.get("issue")
        repo = d.get("repo")
        branch = d.get("branch")
        if not (issue and repo and branch):
            continue
        wt = worktrees_root / issue / repo
        if wt.exists():
            continue   # never touch existing worktrees

        primary = primaries_root / repo
        if not (primary / ".git").exists():
            results.append({"issue": issue, "repo": repo, "ok": False,
                            "action": "skip", "message": f"no primary at {primary}"})
            continue

        # Fetch the branch from origin so we know the ref exists locally.
        fetch = subprocess.run(
            ["git", "-C", str(primary), "fetch", "origin", branch],
            capture_output=True, text=True,
        )
        if fetch.returncode != 0:
            results.append({"issue": issue, "repo": repo, "ok": False,
                            "action": "skip", "message": f"fetch {branch}: {fetch.stderr.strip()}"})
            continue

        wt.parent.mkdir(parents=True, exist_ok=True)
        # First try the simple form (branch already known locally).
        r = subprocess.run(
            ["git", "-C", str(primary), "worktree", "add", str(wt), branch],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            # Branch not yet locally known — create a tracking branch from origin.
            r = subprocess.run(
                ["git", "-C", str(primary), "worktree", "add",
                 "-b", branch, str(wt), f"origin/{branch}"],
                capture_output=True, text=True,
            )
        if r.returncode == 0:
            results.append({"issue": issue, "repo": repo, "ok": True,
                            "action": "created", "message": f"on {branch}"})
        else:
            results.append({"issue": issue, "repo": repo, "ok": False,
                            "action": "failed", "message": r.stderr.strip()})
    return results


def create_issue_worktrees(worktrees_root: Path,
                            primaries_root: Path | None,
                            issue: str,
                            base_branch: str | None,
                            repos: list[str]) -> list[dict]:
    """Create per-repo worktrees for `issue` under
    worktrees_root/<issue>/<repo>.

    For each repo:
      - `git fetch origin <issue>` — best-effort, errors ignored.
      - If origin/<issue> exists: track that branch.
      - Otherwise: create branch <issue> from `base_branch`
        (resolved as a local ref first, then origin/<base>).
      - Skip if the worktree dir already exists or the primary
        repo isn't checked out at primaries_root/<repo>.

    Returns a list of {repo, ok, action, message} dicts.
    """
    if primaries_root is None:
        primaries_root = worktrees_root.parent
    results: list[dict] = []
    for repo in repos:
        primary = primaries_root / repo
        wt = worktrees_root / issue / repo
        if wt.exists():
            results.append({"repo": repo, "ok": False,
                            "action": "skip",
                            "message": f"worktree already exists at {wt}"})
            continue
        if not (primary / ".git").exists():
            results.append({"repo": repo, "ok": False,
                            "action": "skip",
                            "message": f"no primary repo at {primary}"})
            continue

        # Heal single-branch refspec from old `git clone --depth N`
        # invocations (which implicitly add --single-branch, pinning
        # remote.origin.fetch to a single branch). Without this, the
        # fetch below resolves to FETCH_HEAD only and never creates
        # refs/remotes/origin/<issue>, so this function would fall
        # through to "create from local master" and miss the issue's
        # real commits. Idempotent and cheap.
        subprocess.run(
            ["git", "-C", str(primary), "config", "remote.origin.fetch",
             "+refs/heads/*:refs/remotes/origin/*"],
            capture_output=True, text=True, timeout=10,
        )
        # Best-effort fetch of the issue branch (ignored if missing on remote).
        subprocess.run(
            ["git", "-C", str(primary), "fetch", "origin", issue],
            capture_output=True, text=True, timeout=30,
        )
        # Does origin/<issue> exist now?
        check_remote = subprocess.run(
            ["git", "-C", str(primary), "rev-parse", "--verify",
             f"refs/remotes/origin/{issue}"],
            capture_output=True, text=True, timeout=10,
        )
        has_remote = check_remote.returncode == 0

        wt.parent.mkdir(parents=True, exist_ok=True)
        if has_remote:
            # Track the existing remote branch.
            r = subprocess.run(
                ["git", "-C", str(primary), "worktree", "add",
                 str(wt), issue],
                capture_output=True, text=True, timeout=60,
            )
            if r.returncode != 0:
                # Branch isn't local yet — create a local tracking branch.
                r = subprocess.run(
                    ["git", "-C", str(primary), "worktree", "add",
                     "-b", issue, str(wt), f"origin/{issue}"],
                    capture_output=True, text=True, timeout=60,
                )
            action_msg = f"tracked existing origin/{issue}"
        else:
            # Resolve the base branch.
            #   - If the caller explicitly chose a branch (base_branch
            #     truthy), try EXACTLY that one — local first, then
            #     origin/<base>. Fail loudly when missing; do NOT
            #     silently fall back to another branch.
            #   - If they didn't, auto-detect from
            #     refs/remotes/origin/HEAD (set by `git clone` to the
            #     remote's actual default), then fall back to main /
            #     master in that order.
            if base_branch:
                candidates = [base_branch]
                allow_fallback = False
            else:
                candidates = []
                head_ref = subprocess.run(
                    ["git", "-C", str(primary), "symbolic-ref", "--short",
                     "refs/remotes/origin/HEAD"],
                    capture_output=True, text=True, timeout=5,
                )
                if head_ref.returncode == 0:
                    default = head_ref.stdout.strip()
                    if default.startswith("origin/"):
                        default = default[len("origin/"):]
                    if default:
                        candidates.append(default)
                for fallback in ("main", "master"):
                    if fallback not in candidates:
                        candidates.append(fallback)
                allow_fallback = True
            base_ref = None
            tried: list[str] = []
            for cand in candidates:
                tried.append(cand)
                ok_local = subprocess.run(
                    ["git", "-C", str(primary), "rev-parse", "--verify", cand],
                    capture_output=True, text=True, timeout=10,
                ).returncode == 0
                if ok_local:
                    base_ref = cand
                    break
                ok_origin = subprocess.run(
                    ["git", "-C", str(primary), "rev-parse", "--verify",
                     f"refs/remotes/origin/{cand}"],
                    capture_output=True, text=True, timeout=10,
                ).returncode == 0
                if ok_origin:
                    base_ref = f"origin/{cand}"
                    break
                if not allow_fallback:
                    break
            if base_ref is None:
                # Clean up the issue parent dir we just mkdir'd so a
                # failed Add doesn't leave a stray empty folder behind.
                try:
                    if wt.parent.exists() and not any(wt.parent.iterdir()):
                        wt.parent.rmdir()
                except OSError:
                    pass
                msg = (f"base branch {base_branch!r} not found"
                       if not allow_fallback
                       else f"no base branch found — tried {', '.join(tried)}")
                results.append({"repo": repo, "ok": False,
                                "action": "failed",
                                "message": msg})
                continue
            r = subprocess.run(
                ["git", "-C", str(primary), "worktree", "add",
                 "-b", issue, str(wt), base_ref],
                capture_output=True, text=True, timeout=60,
            )
            action_msg = f"new branch from {base_ref}"

        if r.returncode == 0:
            results.append({"repo": repo, "ok": True, "action": "created",
                            "message": action_msg})
        else:
            results.append({"repo": repo, "ok": False, "action": "failed",
                            "message": (r.stderr or r.stdout or "").strip()})
    return results


def remove_issue_worktrees(worktrees_root: Path,
                            primaries_root: Path | None,
                            issue: str,
                            force: bool = False,
                            delete_branch: bool = False) -> list[dict]:
    """Remove every per-repo worktree under worktrees_root/<issue>/.

    For each live repo dir:
      - Read its current branch (so we can optionally delete it).
      - Run `git worktree remove [--force] <path>` against the primary
        repo (worktrees are tracked on the primary side).
      - If `delete_branch`: try `git branch -d <branch>`; with `force`
        fall back to `-D` if the safe form refuses.
    After all repos, `rmdir` the (now-empty) issue dir if possible and
    `git worktree prune` every primary so dangling refs are cleared.
    Returns one result entry per repo + a final 'cleanup' entry.
    """
    if primaries_root is None:
        primaries_root = worktrees_root.parent
    results: list[dict] = []
    issue_dir = worktrees_root / issue
    if not issue_dir.exists():
        return [{"repo": "", "ok": False, "action": "skip",
                 "message": f"no issue dir at {issue_dir}"}]

    primaries_touched: set[Path] = set()
    for repo_dir in sorted(p for p in issue_dir.iterdir() if p.is_dir()):
        repo = repo_dir.name
        # Dotfile dirs (e.g. .claude session storage, .aider history)
        # are never proper worktrees — clean them up silently so the
        # final rmdir on issue_dir can succeed.
        if repo.startswith("."):
            try:
                shutil.rmtree(repo_dir)
            except OSError:
                pass
            continue
        primary = primaries_root / repo
        if not (primary / ".git").exists():
            # No primary to consult, but the dir is still on disk and
            # the user explicitly asked to remove the workspace. If
            # the dir is either NOT a git repo at all or IS a standalone
            # (non-worktree) repo, fall back to a plain rm -rf so the
            # button works for hand-created folders. Refuse only when
            # we'd lose unique work — currently we accept the deletion
            # at face value; users can rescue from filesystem trash if
            # needed. (Force-flag adds an extra confirmation layer.)
            try:
                shutil.rmtree(repo_dir)
                results.append({"repo": repo, "ok": True, "action": "removed",
                                "message": "removed (no primary; rm -rf fallback)"})
            except OSError as ex:
                results.append({"repo": repo, "ok": False, "action": "failed",
                                "message": f"rm -rf failed: {ex}"})
            continue
        branch = ""
        if (repo_dir / ".git").exists():
            r = subprocess.run(
                ["git", "-C", str(repo_dir), "branch", "--show-current"],
                capture_output=True, text=True, timeout=5,
            )
            branch = (r.stdout or "").strip()

        argv = ["worktree", "remove"]
        if force:
            argv.append("--force")
        argv.append(str(repo_dir))
        rm = subprocess.run(
            ["git", "-C", str(primary), *argv],
            capture_output=True, text=True, timeout=30,
        )
        primaries_touched.add(primary)
        if rm.returncode != 0:
            results.append({"repo": repo, "ok": False, "action": "failed",
                            "branch": branch,
                            "message": (rm.stderr or rm.stdout or "").strip()})
            continue

        action = "removed"
        message = "worktree removed"
        if delete_branch and branch:
            br = subprocess.run(
                ["git", "-C", str(primary), "branch", "-d", branch],
                capture_output=True, text=True, timeout=10,
            )
            if br.returncode == 0:
                message += f"; branch '{branch}' deleted"
            elif force:
                br = subprocess.run(
                    ["git", "-C", str(primary), "branch", "-D", branch],
                    capture_output=True, text=True, timeout=10,
                )
                if br.returncode == 0:
                    message += f"; branch '{branch}' force-deleted"
                else:
                    message += (
                        f"; branch '{branch}' delete failed: "
                        + (br.stderr or br.stdout or "").strip())
            else:
                message += (
                    f"; branch '{branch}' kept "
                    + "(unmerged — pass force=true to delete)")
        results.append({"repo": repo, "ok": True, "action": action,
                        "branch": branch, "message": message})

    # Try to remove the now-empty issue dir. Best-effort.
    try:
        if issue_dir.exists() and not any(issue_dir.iterdir()):
            issue_dir.rmdir()
    except OSError:
        pass

    # Prune dangling worktree refs in every primary we touched. Also
    # prune every primary if the issue dir is gone now (covers ghost-
    # only issues where we never matched a repo dir above).
    if not issue_dir.exists():
        if primaries_root.is_dir():
            for p in primaries_root.iterdir():
                if (p / ".git").exists():
                    primaries_touched.add(p)
    for primary in sorted(primaries_touched):
        subprocess.run(
            ["git", "-C", str(primary), "worktree", "prune"],
            capture_output=True, text=True, timeout=10,
        )
    results.append({"repo": "", "ok": True, "action": "cleanup",
                    "message": f"pruned {len(primaries_touched)} primary repos"})
    return results


def _data_dir_is_in_git_repo() -> bool:
    """True iff DATA_DIR is inside a git working tree the dashboard can
    commit to (legacy REPO_DIR/data layout). When DATA_DIR is the
    standalone XDG location, the git commit/push/pull steps are skipped
    — the export still runs so a server restart can re-hydrate from disk."""
    try:
        return DATA_DIR.resolve().is_relative_to(REPO_DIR.resolve()) and \
               (REPO_DIR / ".git").exists()
    except (AttributeError, OSError):
        return False


def auto_sync_tick() -> dict:
    """
    One pass of the auto-sync loop:
      1. Export DB → DATA_DIR.
      2. If DATA_DIR is inside REPO_DIR's git tree, commit + push + pull.
         Otherwise stop after the export.
    Returns a small summary; never raises. Updates _SYNC_STATUS on every
    call so the dashboard can show "last synced X min ago".
    """
    summary = {"exported": False, "committed": False, "pushed": False,
               "pulled": False, "imported": None, "errors": []}
    try:
        conn = db_connect()
        try:
            export_data(conn)
        finally:
            conn.close()
        summary["exported"] = True
    except Exception as ex:  # noqa: BLE001
        summary["errors"].append(f"export: {ex}")
        return summary

    if not _data_dir_is_in_git_repo():
        # No sync repo wired up — export-only mode. The dashboard
        # still hydrates from DATA_DIR on next start. Users opt into
        # full git-sync by running `./setup.sh --sync-repo <url>`
        # (which writes the destination URL the runtime will later
        # honor) or by placing the install in a git checkout whose
        # data/ folder is committed.
        now_ts = time.time()
        with _SYNC_LOCK:
            _SYNC_STATUS["last_ts"] = now_ts
            _SYNC_STATUS["last_ok"] = True
            _SYNC_STATUS["last_summary"] = summary
        return summary

    # --- local commit + push (only this user's data subfolder) ---
    user_path = f"data/{_user_slug()}/"
    diff = _git_repo("diff", "--quiet", "--", user_path)
    untracked = _git_repo("ls-files", "--others", "--exclude-standard", user_path).stdout.strip()
    if diff.returncode != 0 or untracked:
        try:
            _git_repo("add", user_path, check=True)
            # Belt-and-suspenders: after staging, if there's still nothing
            # to commit (e.g. only deleted files that were never tracked,
            # or no real diff), skip the commit. Prevents no-op commits
            # from piling up — the repo would otherwise grow ~12/hour.
            staged = _git_repo("diff", "--cached", "--quiet")
            if staged.returncode == 0:
                summary["committed"] = False
            else:
                msg = f"sync: {socket.gethostname()} {datetime.now().isoformat(timespec='seconds')}"
                _git_repo("commit", "-m", msg, check=True)
                summary["committed"] = True
        except subprocess.CalledProcessError as ex:
            summary["errors"].append(f"commit: {ex.stderr.strip() or ex}")

        # Push only if we actually committed something.
        if summary["committed"]:
            push = _git_repo("push")
            if push.returncode == 0:
                summary["pushed"] = True
            else:
                summary["errors"].append(f"push: {push.stderr.strip()}")

    # --- pull others' changes + re-import ---
    fetch = _git_repo("fetch", "origin")
    if fetch.returncode != 0:
        summary["errors"].append(f"fetch: {fetch.stderr.strip()}")
        return summary

    head = _git_repo("rev-parse", "HEAD").stdout.strip()
    upstream = _git_repo("rev-parse", "@{u}")
    if upstream.returncode != 0:
        return summary  # no upstream configured
    if head and head != upstream.stdout.strip():
        pull = _git_repo("pull", "--ff-only")
        if pull.returncode != 0:
            summary["errors"].append(f"pull: {pull.stderr.strip()}")
            return summary
        summary["pulled"] = True
        try:
            conn = db_connect()
            try:
                summary["imported"] = import_data(conn)
            finally:
                conn.close()
        except Exception as ex:  # noqa: BLE001
            summary["errors"].append(f"import: {ex}")

    now_ts = time.time()
    with _SYNC_LOCK:
        _SYNC_STATUS["last_ts"] = now_ts
        _SYNC_STATUS["last_ok"] = not summary["errors"]
        _SYNC_STATUS["last_summary"] = summary
    # Persist so the dashboard banner doesn't lie after a server restart.
    try:
        conn = db_connect()
        try:
            db_set_meta(conn, "last_sync_at_ts", str(now_ts))
            db_set_meta(conn, "last_sync_ok", "1" if not summary["errors"] else "0")
            conn.commit()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        pass
    return summary


def auto_sync_loop(interval: int, worktrees_root: Path, primaries_root: Path | None,
                   materialize: bool) -> None:
    """Background thread entry: every `interval` seconds, run a sync IF the
    runtime toggle is ON. The toggle defaults to off so a fresh server is
    quiet — the user opts in via the dashboard button (or --auto-sync).
    The thread always runs so the toggle can flip without restart."""
    # Sleep in 30s slices so the toggle can switch off mid-wait.
    slice_s = 30
    while True:
        slept = 0
        while slept < interval:
            time.sleep(min(slice_s, interval - slept))
            slept += slice_s
        with _SYNC_LOCK:
            enabled = _SYNC_STATUS.get("enabled", False)
        if not enabled:
            continue
        result = auto_sync_tick()
        if result.get("pulled") and materialize:
            try:
                created = materialize_missing_worktrees(worktrees_root, primaries_root)
                if created:
                    result["materialized"] = created
            except Exception as ex:  # noqa: BLE001
                result["errors"].append(f"materialize: {ex}")
        if any(result[k] for k in ("committed", "pushed", "pulled")) or result.get("materialized"):
            log_event("info", "sync", "tick complete",
                      committed=result.get("committed"),
                      pushed=result.get("pushed"),
                      pulled=result.get("pulled"),
                      materialized=result.get("materialized"))
        elif result["errors"]:
            log_event("error", "sync", "tick errored",
                      errors=result["errors"])


# ── Mailbox auto-poll loop ────────────────────────────────────────────────
# Wakes idle agents when they have unread mail. Claude is request/response
# only — it can't run a background poller of its own — so the dashboard
# nudges the pty with a synthetic prompt and lets claude treat that as a
# fresh turn, call read_messages, and reply via send_message.
#
# Safeguards:
#   - Only fires for agents that have a live pty session in agentterm.
#   - Only fires when the user hasn't typed into the pty in
#     MAILBOX_IDLE_SECONDS — never interrupt active typing.
#   - Throttled per-session by last_nudge_ts so a slow-to-read agent
#     doesn't get re-poked every cycle.
#   - Gated by the `mailbox-auto-poll` user preference (default OFF
#     until the user explicitly opts in).

MAILBOX_POLL_INTERVAL = 20   # cap between scans; the wake Event
                              # (below) shortens this in practice
MAILBOX_IDLE_SECONDS  = 15   # how long the user must have been idle
MAILBOX_NUDGE_COOLDOWN = 60  # min seconds between nudges per agent

# Set by `mailbox_wake_now()` whenever an MCP send_message lands so
# the poll loop runs its next tick immediately instead of waiting
# the full MAILBOX_POLL_INTERVAL. Cheap; coalesced.
_MAILBOX_WAKE = threading.Event()


def mailbox_wake_now() -> None:
    _MAILBOX_WAKE.set()

# Body of the synthetic nudge — wrapped in bracketed-paste markers
# (\e[200~ … \e[201~) so claude's TUI treats the text as one pasted
# block instead of multi-line keystrokes. The Enter is sent
# separately (see _NUDGE_SUBMIT_DELAY below) so claude has time to
# finalise the paste before the submit key arrives — otherwise
# the \r occasionally lands inside the paste buffer as a literal
# newline and the prompt sits unsubmitted until the user hits
# Enter manually.
_MAILBOX_NUDGE_PASTE = (
    "\x1b[200~"        # start bracketed paste
    "[agent-workspace] 📬 {n} unread — call read_messages, "
    "then send_message(in_reply_to=<id>)."
    "\x1b[201~"        # end bracketed paste
)
# The "don't ask the human to confirm" + "agent-to-agent channel
# is autonomous" wording is already in Agent 007's system prompt
# AND in the shared ~/github/worktrees/AGENTS.md, so we omit them
# here and keep the nudge to a single short line. The three
# tokens read_messages / send_message / in_reply_to are enough
# to point claude at the right tools.
# Wall-clock gap between the paste write and the Enter write.
# 80 ms is long enough for any reasonable claude TUI to leave its
# paste-handling state, short enough that the user perceives the
# whole nudge as one action.
_NUDGE_SUBMIT_DELAY = 0.08


def _mailbox_auto_poll_enabled() -> bool:
    """User-pref gate: defaults to OFF. Re-read every cycle so the
    toggle in Profile takes effect without restart."""
    try:
        conn = db_connect()
        try:
            raw = get_preferences(conn, _user_slug()).get("mailbox-auto-poll")
        finally:
            conn.close()
    except Exception:
        return False
    return _pref_truthy(raw, default=False)


def mailbox_auto_poll_loop() -> None:
    """Background thread entry — runs a scan every
    MAILBOX_POLL_INTERVAL seconds, but ALSO whenever the
    `_MAILBOX_WAKE` Event is set (an MCP send_message lands).
    Cheap (one COUNT query + a few attribute reads); no DB
    write unless there's mail to deliver."""
    while True:
        # Event.wait blocks for up to MAILBOX_POLL_INTERVAL OR until
        # mailbox_wake_now() flips the flag, whichever comes first.
        # Either way we clear + tick afterwards.
        _MAILBOX_WAKE.wait(timeout=MAILBOX_POLL_INTERVAL)
        _MAILBOX_WAKE.clear()
        try:
            if not _mcp_enabled_now() or not _mailbox_auto_poll_enabled():
                continue
            _mailbox_poll_tick()
        except Exception as ex:  # noqa: BLE001
            # Never let a poller error crash the thread.
            log_event("error", "mailbox-poll",
                      "tick failed", error=str(ex))


def _mailbox_poll_tick() -> None:
    sessions = agentterm.iter_sessions()
    if not sessions:
        return
    try:
        conn = db_connect()
        try:
            counts = agent_mcp.unread_counts(conn)
        finally:
            conn.close()
    except Exception:
        return
    if not counts:
        return
    now = time.time()
    for s in sessions:
        n = counts.get(s.issue, 0)
        if n <= 0:
            continue
        if (now - s.last_user_input_ts) < MAILBOX_IDLE_SECONDS:
            continue  # user is engaged — stay out of the way
        # Cooldown silences DUPLICATE nudges for the same batch
        # of mail. If the unread count has GROWN since the last
        # nudge, new messages have arrived and the agent might
        # already have moved on from the previous read — fire
        # again so the new mail isn't stranded for up to a minute.
        in_cooldown = (now - s.last_nudge_ts) < MAILBOX_NUDGE_COOLDOWN
        if in_cooldown and n <= s.last_nudge_unread:
            continue
        body = _MAILBOX_NUDGE_PASTE.format(n=n).encode("utf-8")
        s.inject(body)
        # Brief breathing room so claude finalises the bracketed
        # paste before the Enter key lands — without this gap the
        # \r occasionally gets absorbed into the paste buffer and
        # the prompt sits unsubmitted.
        time.sleep(_NUDGE_SUBMIT_DELAY)
        s.inject(b"\r")
        s.last_nudge_ts = now
        s.last_nudge_unread = n
        log_event("info", "mailbox-poll",
                  "nudged agent for unread mail",
                  issue=s.issue, unread=n, in_cooldown=in_cooldown)


# ── Auto-update loop ──────────────────────────────────────────────────────
# Polls the dashboard's own git repo for new commits on `origin/<branch>`
# every UPDATE_CHECK_INTERVAL seconds. Caches the result in
# awlib.updater._STATUS; the frontend banner reads it via
# /api/update/status. The apply route lives next to the other POST
# handlers — it does the graceful agent stop + pull + spawn the
# agent-worktrees-restart helper.

UPDATE_CHECK_INTERVAL = 600   # 10 min
# REPO_DIR is the dashboard repo root; defined once at module top
# (~line 451) and re-used by both the auto-update path and the
# /api/stats version helpers.


def _auto_update_enabled() -> bool:
    """Honour the dashboard pref `auto-update-check` (default ON).
    Read fresh on every tick so the toggle takes effect without a
    server restart. Falls open to True on any DB error."""
    try:
        conn = db_connect()
        try:
            raw = (get_preferences(conn, _user_slug())
                   .get("auto-update-check"))
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return True
    return _pref_truthy(raw, default=True)


def updater_loop() -> None:
    """Background thread entry — one pass every UPDATE_CHECK_INTERVAL
    seconds. Cheap when local: a single `git fetch` against the
    upstream, bounded by updater._git timeouts."""
    # Do a first tick immediately so the banner can show within
    # seconds of server start instead of waiting the full interval.
    first = True
    while True:
        if not first:
            time.sleep(UPDATE_CHECK_INTERVAL)
        first = False
        try:
            if not _auto_update_enabled():
                continue
            prev = _updater.get_status()
            cur = _updater.check_remote(REPO_DIR)
            _updater.set_status(cur)
            # Log the transition from "clean" to "behind" so the
            # diagnostics console surfaces a fresh update.
            if (cur.get("ok") and cur.get("behind", 0) > 0
                    and prev.get("behind", 0) == 0):
                log_event("info", "updater",
                          "update available",
                          behind=cur["behind"],
                          remote_sha=cur["remote_sha"],
                          remote_subject=cur["remote_subject"][:80])
        except Exception as ex:  # noqa: BLE001
            log_event("error", "updater", "tick failed", error=str(ex))


# ── Old-data cleanup ─────────────────────────────────────────────────────
# Periodically prune time-series rows that have aged out of any view the
# dashboard renders. Config lives in `meta` (machine-local — every machine
# has its own SQLite cache, so cleanup is a local concern, not synced).
#
# Tables we prune: commits, agent_events, agent_session_file_days, and
# ghost worktrees whose on-disk path is gone. Tables we deliberately
# keep untouched: work_logs, week_summaries, notes, preferences, and
# timer_state — they're user-visible historical records.

CLEANUP_DEFAULT_ENABLED = True
CLEANUP_DEFAULT_RETAIN_MONTHS = 12
CLEANUP_DEFAULT_INTERVAL_DAYS = 7   # weekly
CLEANUP_LOOP_CHECK_SECONDS = 3600   # wake hourly to re-evaluate

_CLEANUP_STATUS: dict = {"last_ts": None, "last_ok": None,
                         "last_summary": None, "running": False}
_CLEANUP_LOCK = threading.Lock()


def _cleanup_config(conn: sqlite3.Connection) -> dict:
    """Return the effective cleanup config from `meta`, falling back to
    the defaults. retain_months is clamped to [1, 120] so a typo can't
    delete everything or push the cutoff into the future."""
    enabled_raw = db_get_meta(conn, "cleanup_enabled")
    months_raw = db_get_meta(conn, "cleanup_retain_months")
    enabled = (CLEANUP_DEFAULT_ENABLED if enabled_raw is None
               else enabled_raw == "1")
    try:
        months = int(months_raw) if months_raw is not None else CLEANUP_DEFAULT_RETAIN_MONTHS
    except ValueError:
        months = CLEANUP_DEFAULT_RETAIN_MONTHS
    months = max(1, min(120, months))
    last_ts_raw = db_get_meta(conn, "last_cleanup_at_ts")
    try:
        last_ts = float(last_ts_raw) if last_ts_raw else None
    except ValueError:
        last_ts = None
    return {"enabled": enabled, "retain_months": months,
            "last_cleanup_at_ts": last_ts}


def cleanup_tick(conn: sqlite3.Connection, retain_months: int) -> dict:
    """Delete rows older than `retain_months` from the prunable tables.
    Returns a dict of {table_name: rows_deleted}. Caller commits."""
    days = int(round(retain_months * 30.44))
    cutoff_date = (datetime.utcnow() - timedelta(days=days)).date().isoformat()
    cutoff_ts = int((datetime.utcnow() - timedelta(days=days)).timestamp())
    summary: dict = {"cutoff_date": cutoff_date, "cutoff_ts": cutoff_ts,
                     "retain_months": retain_months, "deleted": {}}

    # commits: heatmap window is 365 days, so anything beyond cutoff is
    # invisible noise.
    cur = conn.execute(
        "DELETE FROM commits WHERE date_utc < ?", (cutoff_date,))
    summary["deleted"]["commits"] = cur.rowcount

    # agent_events: pending events for an old issue are not actionable
    # anymore; the dashboard groups events by read state, not by age.
    cur = conn.execute(
        "DELETE FROM agent_events WHERE created_at < ?", (cutoff_ts,))
    summary["deleted"]["agent_events"] = cur.rowcount

    # agent_session_file_days: token heatmap matches the commit heatmap
    # window, so per-day rows beyond cutoff are noise. The parent row
    # in agent_session_files keeps its totals.
    cur = conn.execute(
        "DELETE FROM agent_session_file_days WHERE date_utc < ?",
        (cutoff_date,))
    summary["deleted"]["agent_session_file_days"] = cur.rowcount

    # Ghost worktrees: rows whose path no longer exists on disk AND
    # whose last_seen is older than cutoff. We keep ghosts younger than
    # cutoff so the "Show removed worktrees" toggle still reveals
    # recently-removed entries.
    ghost_rows = conn.execute(
        "SELECT issue, repo, path FROM worktrees WHERE last_seen < ?",
        (cutoff_date,)).fetchall()
    removed = 0
    for issue, repo, path in ghost_rows:
        if path and Path(path).exists():
            continue
        conn.execute("DELETE FROM worktrees WHERE issue=? AND repo=?",
                      (issue, repo))
        removed += 1
    summary["deleted"]["worktrees_ghost"] = removed

    # Orphan agent_session_files: jsonl files that no longer exist on
    # disk. Their per-day rows are gone above; remove the parent so the
    # token total stops including data we can't re-verify.
    parent_rows = conn.execute(
        "SELECT file_path FROM agent_session_files").fetchall()
    orphaned = 0
    for (fp,) in parent_rows:
        if fp and not Path(fp).exists():
            conn.execute("DELETE FROM agent_session_files WHERE file_path=?", (fp,))
            orphaned += 1
    summary["deleted"]["agent_session_files_orphan"] = orphaned

    return summary


def run_cleanup_now() -> dict:
    """Run one cleanup tick. Persists last_cleanup_at_ts/_summary in meta
    so the dashboard can render "last cleanup X days ago". Never raises;
    error string lands in summary['error']."""
    with _CLEANUP_LOCK:
        if _CLEANUP_STATUS["running"]:
            return {"error": "cleanup already running"}
        _CLEANUP_STATUS["running"] = True
    try:
        conn = db_connect()
        try:
            cfg = _cleanup_config(conn)
            summary = cleanup_tick(conn, cfg["retain_months"])
            now_ts = time.time()
            db_set_meta(conn, "last_cleanup_at_ts", str(now_ts))
            db_set_meta(conn, "last_cleanup_summary", json.dumps(summary))
            conn.commit()
        finally:
            conn.close()
        with _CLEANUP_LOCK:
            _CLEANUP_STATUS["last_ts"] = now_ts
            _CLEANUP_STATUS["last_ok"] = True
            _CLEANUP_STATUS["last_summary"] = summary
        total = sum(summary["deleted"].values())
        log_event("info", "cleanup", "tick complete",
                   deleted_total=total, **summary["deleted"])
        return summary
    except Exception as ex:  # noqa: BLE001
        with _CLEANUP_LOCK:
            _CLEANUP_STATUS["last_ok"] = False
        log_event("error", "cleanup", "tick failed", error=str(ex))
        return {"error": str(ex)}
    finally:
        with _CLEANUP_LOCK:
            _CLEANUP_STATUS["running"] = False


def cleanup_loop() -> None:
    """Background thread: wake hourly, run cleanup if enabled and the
    last successful tick is older than CLEANUP_DEFAULT_INTERVAL_DAYS."""
    interval_secs = CLEANUP_DEFAULT_INTERVAL_DAYS * 86400
    while True:
        time.sleep(CLEANUP_LOOP_CHECK_SECONDS)
        try:
            conn = db_connect()
            try:
                cfg = _cleanup_config(conn)
            finally:
                conn.close()
        except Exception as ex:  # noqa: BLE001
            log_event("warn", "cleanup", "config read failed", error=str(ex))
            continue
        if not cfg["enabled"]:
            continue
        last_ts = cfg["last_cleanup_at_ts"]
        if last_ts and (time.time() - last_ts) < interval_secs:
            continue
        run_cleanup_now()


# ── Existing helpers ─────────────────────────────────────────────────────
def last_build(wt: Path) -> tuple[str, int]:
    """Return (timestamp_str, age_minutes) for the worktree's most recent
    Maven `target/` mtime. age_minutes is -1 when no build artifact exists."""
    for cand in ("target", "build", "dist"):
        p = wt / cand
        if p.is_dir():
            mtime = p.stat().st_mtime
            ts = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
            age_min = max(0, int((datetime.now().timestamp() - mtime) / 60))
            return ts, age_min
    return "—", -1


# ── Status collection ─────────────────────────────────────────────────────
def _gitweb_path_from_remote(remote_url: str) -> str | None:
    """Turn a `remote.origin.url` value into the gitweb `p=` path.

    Handles the three shapes git uses:
      - ssh://[user@]host[:port]/<path>.git
      - https://host/<path>.git
      - [user@]host:<path>.git              (scp-style)

    Some hosts root checkouts at /home/git/ — strip that prefix as well
    as a leading `~git/` (some servers expose the same tree via that
    alias) so gitweb gets the right project slug.

    Returns the path without the trailing `.git`, or None if the input
    doesn't look like a remote URL at all.
    """
    if not remote_url:
        return None
    s = remote_url.strip()
    if s.endswith(".git"):
        s = s[:-4]
    m = re.match(r"^(?:ssh|https?)://(?:[^@/]+@)?[^/]+(?::\d+)?(.*)", s)
    if m:
        s = m.group(1)
    else:
        m = re.match(r"^[^@/]+@[^:]+:(.+)$", s)
        if m:
            s = m.group(1)
    s = s.lstrip("/")
    s = re.sub(r"^home/git/", "", s)
    s = re.sub(r"^~git/", "", s)
    return s or None


def gather_repo_status(wt: Path) -> dict:
    """Collect everything we want to show for one repo checkout."""
    branch = _git(wt, "branch", "--show-current") or "?"
    upstream = upstream_for(wt)
    # Capture the remote URL so the dashboard can build correct gitweb
    # links — the local worktree dir name often diverges from the
    # remote path (e.g. ~/github/worktrees/<workspace>/<repo> vs.
    # p=<org>/<repo>.git on gitweb).
    remote_url = _git(wt, "config", "--get", "remote.origin.url")
    remote_path = _gitweb_path_from_remote(remote_url)
    last_commit = _git(wt, "log", "-1", "--format=%h %s")
    last_when = _git(wt, "log", "-1", "--format=%cr")
    last_author = _git(wt, "log", "-1", "--format=%an")
    # Author date (%aI) survives rebases, so "X days ago" reflects when the
    # work was actually done, not when it was last committer-rewritten.
    last_commit_iso = _git(wt, "log", "-1", "--format=%aI")
    last_commit_age_days = _days_since(last_commit_iso)
    # Compute the merge-base early — both for the branch-only last_commits
    # scope below and for the branch-age / coauthor blocks further down.
    base = _git(wt, "merge-base", upstream, "HEAD") or ""
    # Show every commit on this branch (base..HEAD) — the dashboard appends
    # the merge-base row as a fork-point marker, so master history isn't
    # needed here. Cap at 200 to avoid pulling huge histories. Fall back to
    # the last 50 from HEAD when there's no base yet (detached / orphan).
    # %H so the dashboard can build full gitweb commit URLs; date format
    # includes time-of-day so commits within a day land in order.
    if base:
        last_commits_raw = _git(wt, "log", "-200",
                                "--format=%H%x09%ad%x09%an%x09%s",
                                "--date=format-local:%Y-%m-%d %H:%M",
                                f"{base}..HEAD")
    else:
        last_commits_raw = _git(wt, "log", "-50",
                                "--format=%H%x09%ad%x09%an%x09%s",
                                "--date=format-local:%Y-%m-%d %H:%M")
    last_commits = []
    for line in last_commits_raw.splitlines():
        parts = line.split("\t", 3)
        if len(parts) == 4:
            last_commits.append({"sha": parts[0], "date": parts[1], "author": parts[2], "subject": parts[3]})

    # --untracked-files=all expands new directories into their individual
    # entries. Without it, a brand-new directory with multiple new files
    # shows up as a single "??" line for the directory, hiding the files
    # inside from the working-tree list.
    porcelain = _git_raw(wt, "status", "--porcelain", "--untracked-files=all")
    dirty_files = []
    for line in porcelain.splitlines():
        if not line:
            continue
        # Format is "XY <path>" where XY is two status chars and char 2 is
        # a space separator. Rename lines are "R  old -> new" — keep them
        # whole in the path column. Use _git_raw because the first column
        # is often a space (' M' = unstaged modified) and .strip() would
        # eat it, shifting the parser by one character.
        code = line[:2]
        path = line[3:] if len(line) > 3 else ""
        dirty_files.append({"code": code, "path": path})
    n_dirty = len(dirty_files)

    if _git(wt, "rev-parse", "--verify", upstream):
        counts = _git(wt, "rev-list", "--left-right", "--count", f"{upstream}...HEAD")
        if counts:
            behind, ahead = (int(x) for x in counts.split("\t" if "\t" in counts else None))
        else:
            behind, ahead = -1, -1
    else:
        behind, ahead = -1, -1

    # Branch age: when did this branch fork from upstream? Use the date of
    # the oldest commit on HEAD that is NOT in upstream — that's the first
    # commit on this branch. `base` was already computed above for the
    # last_commits sizing.
    branch_age_days = -1
    merge_base_commit = None
    if base:
        # Use author date so a recent rebase doesn't claim the branch is
        # brand new. Take the OLDEST author date among branch-only commits
        # (--reverse + take first line).
        first_commit_iso = _git(
            wt, "log", "--reverse", "--format=%aI", f"{base}..HEAD"
        ).split("\n", 1)[0].strip()
        if first_commit_iso:
            branch_age_days = _days_since(first_commit_iso)
        # The fork-point commit itself, so the dashboard can mark "this is
        # where the branch came from" — useful when the last 10 commits are
        # all branch-only and the fork point is older.
        mb_line = _git(
            wt, "log", "-1", "--format=%H%x09%ad%x09%an%x09%s",
            "--date=format-local:%Y-%m-%d %H:%M", base,
        )
        mb_parts = mb_line.split("\t", 3)
        if len(mb_parts) == 4:
            merge_base_commit = {
                "sha": mb_parts[0], "date": mb_parts[1],
                "author": mb_parts[2], "subject": mb_parts[3],
            }

    # Co-authors on this branch — `git shortlog -sn upstream..HEAD` lists
    # everyone who has commits on the branch since divergence, sorted by
    # commit count. Cheap; runs in <50ms per repo.
    coauthors: list[dict] = []
    if base:
        sl = _git(wt, "shortlog", "-sn", "--no-merges", f"{base}..HEAD")
        for line in sl.splitlines():
            line = line.strip()
            if not line:
                continue
            # Format is "    N\tName" (tab) or "    N Name" (space).
            count_str, _sep, author = line.partition("\t")
            if not author:
                count_str, _sep, author = line.partition(" ")
            try:
                coauthors.append({"count": int(count_str.strip()), "author": author.strip()})
            except ValueError:
                continue

    # Prefer origin/<branch-name> over @{u}: when feature branches are
    # pushed to origin/<workspace-key> but @{u} is left pointing at
    # origin/master so the "behind master" count works, counting against
    # @{u} would flag every commit on the branch as unpushed even after
    # a successful push to its own remote ref.
    same_name_remote = (
        f"refs/remotes/origin/{branch}"
        if branch and branch != "?"
           and _git(wt, "rev-parse", "--verify", f"refs/remotes/origin/{branch}")
        else None
    )
    if same_name_remote:
        unpushed_range = f"origin/{branch}..HEAD"
        upstream_configured = True
    elif _git(wt, "rev-parse", "--verify", "@{u}"):
        unpushed_range = "@{u}..HEAD"
        upstream_configured = True
    elif base:
        # Branch never pushed (no @{u}) — every commit since the fork from
        # the base branch (origin/master) is genuinely unpushed.
        unpushed_range = f"{base}..HEAD"
        upstream_configured = False
    else:
        unpushed_range = None
        upstream_configured = False
    if unpushed_range:
        unpushed_log = _git(wt, "log", "--format=%H%x09%ad%x09%an%x09%s",
                            "--date=format-local:%Y-%m-%d %H:%M", unpushed_range)
        unpushed = [
            {"sha": p[0], "date": p[1], "author": p[2], "subject": p[3]}
            for line in unpushed_log.splitlines()
            if (p := line.split("\t", 3)) and len(p) == 4
        ]
    else:
        unpushed = []

    # VS Code-style "to pull" — commits in the remote sibling branch
    # (origin/<branch>) that aren't in HEAD. Falls back to @{u} when
    # there's no same-name remote, then 0 when there's no upstream at
    # all. Distinct from `behind` (which is always against origin/master
    # for the master-divergence pill) so both can be displayed.
    n_to_pull = 0
    if same_name_remote:
        cnt = _git(wt, "rev-list", "--count", f"HEAD..origin/{branch}")
        if cnt.isdigit():
            n_to_pull = int(cnt)
    elif _git(wt, "rev-parse", "--verify", "@{u}"):
        cnt = _git(wt, "rev-list", "--count", "HEAD..@{u}")
        if cnt.isdigit():
            n_to_pull = int(cnt)

    return {
        "path": str(wt),
        "branch": branch,
        "upstream": upstream,
        "remote_url": remote_url or "",
        "remote_path": remote_path or "",
        "ahead": ahead,
        "behind": behind,
        "n_to_pull": n_to_pull,
        "last_commit": last_commit,
        "last_commit_when": last_when,
        "last_commit_author": last_author,
        "last_commit_age_days": last_commit_age_days,
        "branch_age_days": branch_age_days,
        "merge_base_sha": base or None,
        "merge_base_commit": merge_base_commit,
        "last_commits": last_commits,
        "dirty_files": dirty_files,
        "n_dirty": n_dirty,
        "unpushed": unpushed,
        "n_unpushed": len(unpushed),
        "upstream_configured": upstream_configured,
        "last_claude": latest_session_mtime(wt),
        "last_claude_prompt": latest_user_prompt(wt),
        "claude_session": claude_session_summary(wt),
        **(lambda lb: {"last_build": lb[0], "last_build_age_min": lb[1]})(last_build(wt)),
        "coauthors": coauthors,
    }


def running_agent_issues() -> set[str]:
    """Return the set of issue keys that have at least one running
    Claude agent process.

    Matching strategy: enumerate the system's process list and look
    for `--name <tab-title>` in each process's command line — the
    tab title is what bin/agent-worktrees passes through, and the
    issue key is always the first whitespace-separated token after
    --name.

    Best-effort: any failure (no pgrep / no PowerShell, timeout,
    parse error) returns an empty set so callers fall back to
    "no agent running" rather than blocking removal.
    """
    cmdlines: list[str] = []
    if IS_WINDOWS:
        # PowerShell + CIM is the cleanest cross-version way to read
        # full command lines on Windows without pulling in psutil.
        # `tasklist /v` truncates after ~30 chars which loses --name.
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-CimInstance Win32_Process -Filter "
                 "\"Name='claude.exe' OR Name='node.exe'\" "
                 "| Select-Object -ExpandProperty CommandLine"],
                capture_output=True, text=True, check=False, timeout=4,
            )
        except (OSError, subprocess.SubprocessError):
            return set()
        cmdlines = (r.stdout or "").splitlines()
    else:
        try:
            r = subprocess.run(
                ["pgrep", "-fa", "claude"],
                capture_output=True, text=True, check=False, timeout=2,
            )
        except (OSError, subprocess.SubprocessError):
            return set()
        cmdlines = (r.stdout or "").splitlines()
    out: set[str] = set()
    for line in cmdlines:
        m = re.search(r"--name\s+(\S+)", line)
        if m:
            out.add(m.group(1))
    return out


def gather_all(worktrees_root: Path, behind_limit: int, show_ghosts: bool = False) -> dict:
    """
    Iterate worktrees_root/* and return one dict with full data + summary.

    Side effect: persists a snapshot of every currently-existing worktree to
    SQLite, so future calls can surface "ghost" worktrees (snapshots whose
    paths have since disappeared) when `show_ghosts` is True.
    """
    issues: list[dict] = []
    n_dirty_total = 0
    n_unpushed_total = 0
    n_behind_bad = 0
    behind_bad_list: list[dict] = []
    current_paths: set[str] = set()
    # Agent (Claude session) liveness — counted once per live issue.
    # Pre-fetch every session_id with a SessionEnd event so issue_agent_state
    # can ignore those without re-opening the DB per issue.
    n_agents_active = 0
    n_agents_idle = 0
    agents_missing_issues: list[str] = []
    try:
        conn = db_connect()
        try:
            ended_sessions = ended_session_ids(conn)
            expected_repos = user_expected_repos(conn, _user_slug())
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        ended_sessions = set()
        expected_repos = list(EXPECTED_REPOS)

    # Process-list snapshot used both by the per-issue agent_state
    # upgrade (handles the early-startup window before Claude Code
    # has appended any JSONL) and the agent_running flag downstream.
    try:
        live_agents = running_agent_issues()
    except Exception:  # noqa: BLE001
        live_agents = set()

    for issue_dir in sorted(p for p in worktrees_root.iterdir() if p.is_dir()):
        issue = issue_dir.name
        repos = []
        issue_has_dirty = False
        present = set()
        for wt in discover_repos(issue_dir):
            data = gather_repo_status(wt)
            data["issue"] = issue
            data["repo"] = wt.name
            data["too_behind"] = data["behind"] > behind_limit
            data["ghost"] = False
            data["missing"] = False
            present.add(wt.name)
            current_paths.add(data["path"])
            if data["n_dirty"]:
                issue_has_dirty = True
            n_unpushed_total += data["n_unpushed"]
            if data["too_behind"]:
                n_behind_bad += 1
                # Structured so the frontend can key per-row dismissals
                # by (issue, repo) and re-show the banner when behind
                # grows past the dismissed value.
                behind_bad_list.append({
                    "issue": issue,
                    "repo": wt.name,
                    "behind": data["behind"],
                    "upstream": data["upstream"],
                })
            repos.append(data)
        # Synthesise placeholders for expected repos that aren't on disk
        # so the user sees a clear gap rather than just missing rows.
        # `expected_repos` is the user's per-machine preference (or
        # the EXPECTED_REPOS default), read once at the top of the
        # gather pass.
        if repos:
            for expected in expected_repos:
                if expected not in present:
                    repos.append(missing_repo_placeholder(issue, expected))
            # Keep the per-issue ordering stable + alphabetical so
            # missing rows land in their natural position next to
            # their real siblings.
            repos.sort(key=lambda r: r["repo"])
        if repos:
            agent_state = issue_agent_state(
                issue_dir, ended_sessions,
                process_running=(issue in live_agents))
            issue_obj = {"issue": issue, "repos": repos,
                         "agent_state": agent_state}
            issues.append(issue_obj)
            if issue_has_dirty:
                n_dirty_total += 1
            if agent_state == "active":
                n_agents_active += 1
            elif agent_state == "idle":
                n_agents_idle += 1
            else:
                agents_missing_issues.append(issue)

    # Tag each issue with whether at least one agent process is currently
    # running for this workspace. The remove-workspace dialog uses this
    # to block the Remove button until the user exits the agent so we
    # don't yank the worktree out from under a live session. live_agents
    # was already populated up top so issue_agent_state could consult it.
    for issue_obj in issues:
        issue_obj["agent_running"] = issue_obj["issue"] in live_agents

    # Attach GitHub issue / PR data when the integration is configured.
    # Best-effort — a network blip just leaves the fields as None.
    if _github.is_configured():
        for issue_obj in issues:
            try:
                gh_issue = _github.issue_for_workspace(issue_obj["issue"])
                gh_pr = _github.pr_for_workspace(issue_obj["issue"])
            except Exception:  # noqa: BLE001
                gh_issue = gh_pr = None
            if gh_issue or gh_pr:
                issue_obj["github"] = {"issue": gh_issue, "pr": gh_pr}

    # Attach token totals from the cached SQLite walk. agent_tokens is
    # additive — it merges this machine's locally-observed totals with any
    # totals imported from other machines (via data/<other-user>/agent_tokens.json).
    general_unread_messages = 0
    try:
        conn = db_connect()
        try:
            # Per-issue pending-event counts power the tab badge.
            event_counts = pending_event_counts(conn)
            event_counts_by_kind = pending_event_counts_by_kind(conn)
            todo_counts = todo_counts_by_issue(conn, _user_slug())
            mcp_counts = agent_mcp.unread_counts(conn)
            general_unread_messages = mcp_counts.get("__agent__", 0)
            for issue_obj in issues:
                issue_obj["pending_events"] = event_counts.get(
                    issue_obj["issue"], 0)
                # Per-kind breakdown lets the dashboard apply the user's
                # "notify me about" filter client-side without re-fetching.
                issue_obj["pending_events_by_kind"] = (
                    event_counts_by_kind.get(issue_obj["issue"], {}))
                # Open-note count drives the second badge on each tab.
                issue_obj["pending_todos"] = todo_counts.get(
                    issue_obj["issue"], 0)
                # Unread MCP mailbox count → 📬 tab badge.
                issue_obj["unread_messages"] = mcp_counts.get(
                    issue_obj["issue"], 0)
            for issue_obj in issues:
                issue_total = {"in": 0, "out": 0, "cache_r": 0, "cache_w": 0}
                issue_cost = 0.0
                issue_msgs = 0
                for r in issue_obj["repos"]:
                    at = agent_tokens_for(conn, r["issue"], r["repo"])
                    r["agent_tokens"] = at
                    if at:
                        for k in issue_total:
                            issue_total[k] += at["tokens"][k]
                        issue_cost += at["cost_usd"] or 0
                        issue_msgs += at["asst_msgs"] or 0
                issue_obj["agent_tokens_total"] = {
                    "tokens": issue_total,
                    "asst_msgs": issue_msgs,
                    "cost_usd": round(issue_cost, 4),
                    "total_tokens": sum(issue_total.values()),
                }
        finally:
            conn.close()
    except Exception as ex:  # noqa: BLE001
        log_event("error", "agent-tokens",
                  "failed to attach token totals", error=str(ex))

    # Persist + optionally surface ghosts.
    n_ghosts = 0
    try:
        conn = db_connect()
        try:
            for issue_obj in issues:
                for repo_data in issue_obj["repos"]:
                    upsert_worktree(conn, repo_data)
            if show_ghosts:
                ghosts = load_ghost_worktrees(conn, current_paths)
                n_ghosts = len(ghosts)
                # Group ghosts under their issue (creating the issue entry if
                # the entire issue dir has been removed).
                by_issue: dict[str, dict] = {i["issue"]: i for i in issues}
                for g in ghosts:
                    obj = by_issue.get(g["issue"])
                    if obj is None:
                        obj = {"issue": g["issue"], "repos": []}
                        by_issue[g["issue"]] = obj
                        issues.append(obj)
                    obj["repos"].append(g)
                issues.sort(key=lambda x: x["issue"])
            conn.commit()
        finally:
            conn.close()
    except Exception as ex:  # noqa: BLE001
        log_event("error", "worktree-store",
                  "snapshot persist failed", error=str(ex))

    with _SYNC_LOCK:
        sync_ts = _SYNC_STATUS["last_ts"]
        sync_ok = _SYNC_STATUS["last_ok"]
        sync_enabled = _SYNC_STATUS["enabled"]
        sync_thread_running = _SYNC_STATUS.get("thread_running", False)
        sync_interval = _SYNC_STATUS.get("interval", DEFAULT_SYNC_INTERVAL)
    sync_age = int(time.time() - sync_ts) if sync_ts else None
    return {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "worktrees_root": str(worktrees_root),
        "behind_limit": behind_limit,
        "show_ghosts": show_ghosts,
        "issues": issues,
        "summary": {
            "n_issues": len(issues),
            "n_repos": sum(len(i["repos"]) for i in issues),
            "n_dirty": n_dirty_total,
            "n_unpushed": n_unpushed_total,
            "n_behind_bad": n_behind_bad,
            "n_ghosts": n_ghosts,
            "behind_bad_list": behind_bad_list,
            # Agent (Claude session) liveness — counted across live
            # (non-ghost) issues only. n_agents_expected is the
            # denominator the dashboard compares n_agents_total against
            # so toggling "show ghosts" can't make the card go red.
            "n_agents_active":  n_agents_active,
            "n_agents_idle":    n_agents_idle,
            "n_agents_total":   n_agents_active + n_agents_idle,
            "n_agents_missing": len(agents_missing_issues),
            "n_agents_expected": (n_agents_active + n_agents_idle
                                   + len(agents_missing_issues)),
            "agents_missing_issues": agents_missing_issues,
        },
        "sync": {
            "enabled": sync_enabled,
            "thread_running": sync_thread_running,
            "interval_seconds": sync_interval,
            "last_ts": sync_ts,
            "last_iso": (datetime.fromtimestamp(sync_ts).strftime("%Y-%m-%d %H:%M:%S")
                         if sync_ts else None),
            "age_seconds": sync_age,
            "ok": sync_ok,
            "stale_seconds": SYNC_STALE_SECONDS,
        },
        "editors": detect_editors(),
        "user": user_profile(),
        "general_unread_messages": general_unread_messages,
        # Claude-session summary for the General Agent. Same shape
        # repo_data["claude_session"] gets per worktree; we just
        # point at <worktrees_root> itself so the encoded project
        # dir (e.g. -home-matand-git-worktrees) is the one we
        # read. {} when there's no claude history at the General
        # Agent's cwd yet.
        "general_agent_session": claude_session_summary(worktrees_root),
        # Synced user preferences. Inlined in /api/status so the client
        # has them on first paint without a separate roundtrip.
        "preferences": _initial_preferences_for_state(),
    }


# Editor integration lives in awlib.editors now (see imports at the top).


# ── HTML rendering ────────────────────────────────────────────────────────
def _static_mtime(name: str) -> int:
    """Mtime of a file under static/ as a cache-buster. 0 if missing."""
    try:
        return int((STATIC_DIR / name).stat().st_mtime)
    except OSError:
        return 0


# Files the service worker precaches for tier-1 PWA shell offline.
# Order doesn't matter; the SW reads its own copy from `PRECACHE`.
_SW_PRECACHE_FILES = (
    "dashboard.css",
    "dashboard.js",
    "favicon.svg",
    "manifest.json",
    "xterm/xterm.css",
    "xterm/xterm.js",
    "xterm/xterm-addon-fit.js",
    "xterm/xterm-addon-web-links.js",
    "xterm/xterm-addon-search.js",
    "xterm/xterm-addon-unicode11.js",
    "xterm/xterm-addon-image.js",
)


def _sw_cache_version() -> str:
    """Short hash of every precached asset's mtime so any static change
    changes the served sw.js bytes — that's what triggers Chromium to
    install a fresh SW and drop the old cache."""
    parts = [str(_static_mtime(n)) for n in _SW_PRECACHE_FILES]
    parts.append(str(_static_mtime("sw.js")))
    return hashlib.sha1("|".join(parts).encode("ascii")).hexdigest()[:12]


def render_html(state: dict) -> str:
    """Render the dashboard. Status data is inlined as JSON for the JS to consume."""
    initial = json.dumps(state)
    css_v  = _static_mtime("dashboard.css")
    js_v   = _static_mtime("dashboard.js")
    mani_v = _static_mtime("manifest.json")
    sw_v   = _static_mtime("sw.js")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Engineering Workspace - Status Board</title>
<link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
<link rel="manifest" href="/static/manifest.json?v={mani_v}">
<meta name="theme-color" content="#0d1117">
<link rel="apple-touch-icon" href="/static/favicon.svg">
<link rel="stylesheet" href="/static/dashboard.css?v={css_v}">
<link rel="stylesheet" href="/static/xterm/xterm.css">
</head>
<body>
<div id="splash-screen" aria-hidden="true">
  <canvas id="splash-canvas"></canvas>
  <div class="splash-card">
    <div class="splash-title"><span class="splash-diamond">◈</span>AGENTIC ENGINEERING<span class="splash-diamond">◈</span></div>
    <div class="splash-subtitle">W O R K S P A C E</div>
    <div class="splash-dots">
      <div class="splash-dot"></div>
      <div class="splash-dot"></div>
      <div class="splash-dot"></div>
    </div>
  </div>
</div>
<script>
window.__splashStart = performance.now();
(function() {{
  var canvas = document.getElementById('splash-canvas');
  var ctx = canvas.getContext('2d');
  var FONT = 13;
  var CHARS = '01ABCDEFabcdef0123456789◈⊗⟳>_{{}}[]|:./\\\\';
  var drops = [];
  function resize() {{
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    var cols = Math.floor(canvas.width / FONT);
    drops = [];
    for (var i = 0; i < cols; i++) {{
      drops.push({{
        y: Math.random() * -(canvas.height / FONT),
        speed: 0.25 + Math.random() * 0.55,
        bright: 0.2 + Math.random() * 0.8
      }});
    }}
  }}
  resize();
  window.addEventListener('resize', resize);
  var frame = 0;
  function tick() {{
    frame++;
    ctx.fillStyle = 'rgba(13,17,23,0.18)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = FONT + 'px monospace';
    ctx.textAlign = 'left';
    var cx = canvas.width  / 2;
    var cy = canvas.height / 2;
    var guardL = cx - 340, guardR = cx + 340;
    var guardT = cy - 95,  guardB = cy + 95;
    for (var i = 0; i < drops.length; i++) {{
      var d = drops[i];
      var x = i * FONT;
      var y = d.y * FONT;
      if (x > guardL && x < guardR && y > guardT && y < guardB) {{
        d.y += d.speed; continue;
      }}
      var g = Math.floor(140 + d.bright * 115);
      ctx.fillStyle = 'rgba(0,' + g + ',' + Math.floor(d.bright * 80) + ',' + d.bright + ')';
      ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], x, y);
      d.y += d.speed;
      if (y > canvas.height) {{
        d.y = Math.random() * -20;
        d.bright = 0.2 + Math.random() * 0.8;
        d.speed  = 0.25 + Math.random() * 0.55;
      }}
    }}
    window.__splashRaf = requestAnimationFrame(tick);
  }}
  tick();
}})();
</script>
<a href="#app" class="skip-to-content">Skip to content</a>
<div id="server-status-banner" role="status" aria-live="polite" hidden>
  <span class="ssb-icon" aria-hidden="true">⚠</span>
  <span class="ssb-text">Server unreachable</span>
  <span class="ssb-detail muted"></span>
  <button type="button" class="ssb-retry" title="Retry now">↻ Retry</button>
</div>
<div id="app" role="main" tabindex="-1"></div>
<script id="initial-state" type="application/json">{initial}</script>
<script>
  // Register the PWA service worker so Chromium's "install" prompt
  // fires AND the static shell is cached for offline launches.
  // On update: when the new SW claims the page (clients.claim in
  // activate), the page is still running the previous version's
  // JS in memory — so auto-reload to pick up the new bytes. Only
  // fires when there was a previous controller, i.e. an UPDATE,
  // not the first install.
  if ('serviceWorker' in navigator) {{
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {{
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    }});
    window.addEventListener('load', () => {{
      navigator.serviceWorker.register('/sw.js?v={sw_v}', {{ scope: '/' }})
        .catch(() => {{ /* fail silently — installability is optional */ }});
    }});
  }}
</script>
<script>
(function() {{
  // Inject heavy bundles AFTER the splash has had at least one paint
  // frame so the matrix animation actually runs visibly before the
  // main thread freezes on parsing dashboard.js and renderApp().
  // Dynamically-inserted scripts default to async=true; setting
  // async=false preserves execution order so dashboard.js still runs
  // after xterm has registered its globals.
  var SRCS = [
    '/static/xterm/xterm.js',
    '/static/xterm/xterm-addon-fit.js',
    '/static/xterm/xterm-addon-web-links.js',
    '/static/xterm/xterm-addon-search.js',
    '/static/xterm/xterm-addon-unicode11.js',
    '/static/xterm/xterm-addon-image.js',
    '/static/dashboard.js?v={js_v}'
  ];
  function inject() {{
    SRCS.forEach(function(src) {{
      var s = document.createElement('script');
      s.src = src;
      s.async = false;
      document.body.appendChild(s);
    }});
  }}
  requestAnimationFrame(function() {{
    requestAnimationFrame(function() {{
      setTimeout(inject, 250);
    }});
  }});
}})();
</script>
</body>
</html>"""


# ── HTTP server ───────────────────────────────────────────────────────────
def make_handler(worktrees_root: Path, behind_limit: int,
                  primaries_root: Path | None = None):
    """Closure-style handler factory so config is captured per-server."""
    if primaries_root is None:
        primaries_root = worktrees_root.parent

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # Endpoints whose purpose is to be polled by the dashboard. We skip
        # request-logging them — otherwise auto-refresh of the logs modal
        # spams its own buffer with "GET /api/logs" lines.
        _SILENT_PATHS = ("/api/logs", "/api/stats")

        def log_message(self, fmt, *args):
            # Drop polled diagnostics endpoints entirely — auto-refresh on
            # the logs modal would otherwise spam its own buffer.
            try:
                req = self.requestline  # e.g. 'GET /api/logs?since=1 HTTP/1.1'
                method, path, *_ = req.split(" ", 2)
                bare_path = path.split("?", 1)[0]
                if bare_path in self._SILENT_PATHS:
                    return
            except Exception:  # noqa: BLE001 — fall through and log
                pass
            line = f"[{self.log_date_time_string()}] {fmt % args}"
            # Pick a level from the HTTP status code when present (request
            # log fmt is `'"%s" %s %s'` → args = (requestline, code, size)).
            level: str | None = None
            if len(args) >= 2:
                try:
                    code = int(args[1])
                    if code >= 500:
                        level = "error"
                    elif code >= 400:
                        level = "warn"
                    else:
                        level = "info"
                except (ValueError, TypeError):
                    pass
            # Bypass the tee so we don't get a duplicate ring entry from
            # the heuristic path, then push with the exact level.
            stream = sys.stderr.original if isinstance(sys.stderr, _StderrTee) else sys.stderr
            stream.write(line + "\n")
            try:
                stream.flush()
            except Exception:  # noqa: BLE001
                pass
            _LOG_RING.append(line, level=level)

        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path

            qs = urllib.parse.parse_qs(parsed.query)
            show_ghosts = qs.get("show_ghosts", ["0"])[0] in ("1", "true", "yes")

            if path == "/" or path == "":
                # Don't block the initial HTML on gather_all() — it can
                # take 1-2s scanning every worktree, and that delay shows
                # up as a blank page in the browser. Serve the shell
                # immediately with a sentinel state; dashboard.js fetches
                # /api/status to fill it in, so the splash stays visible
                # while the scan runs.
                body = render_html({"_pending": True}).encode()
                self._send(200, "text/html; charset=utf-8", body)

            elif path == "/api/terminal-image/pending":
                with _TERM_IMAGE_LOCK:
                    items = list(_TERM_IMAGE_QUEUE)
                    _TERM_IMAGE_QUEUE.clear()
                self._send_json(200, items)

            elif path == "/api/status":
                self._scan_throttled()
                state = gather_all(worktrees_root, behind_limit, show_ghosts=show_ghosts)
                self._send_json(200, state)

            elif path.startswith("/api/disk/"):
                rest = path[len("/api/disk/"):]
                parts = rest.split("/", 1)
                if len(parts) != 2:
                    self._send(400, "text/plain", b"Bad disk path")
                    return
                issue, repo = (urllib.parse.unquote(p) for p in parts)
                wt = worktrees_root / issue / repo
                self._send_json(200, disk_usage(wt))

            elif path == "/api/heatmap":
                days = int(qs.get("days", [str(HEATMAP_DAYS)])[0])
                conn = db_connect()
                try:
                    self._send_json(200, heatmap_data(conn, days=days))
                finally:
                    conn.close()

            elif path == "/api/heatmap/tokens":
                days = int(qs.get("days", [str(HEATMAP_DAYS)])[0])
                conn = db_connect()
                try:
                    self._send_json(200, token_heatmap_data(conn, days=days))
                finally:
                    conn.close()

            elif path == "/api/sync-now":
                # Manual sync triggered from the dashboard. POST is the
                # right verb but we accept GET too for easy cURL testing.
                self._do_sync_now()
                return

            elif path == "/api/sync-toggle":
                # Flip auto-sync ON/OFF. enabled=1/0/true/false in query.
                want = qs.get("enabled", ["toggle"])[0].lower()
                self._do_sync_toggle(want)
                return

            elif path == "/api/cleanup-config":
                # GET → current cleanup settings + last-run state.
                conn = db_connect()
                try:
                    cfg = _cleanup_config(conn)
                    last_summary_raw = db_get_meta(conn, "last_cleanup_summary")
                finally:
                    conn.close()
                try:
                    last_summary = json.loads(last_summary_raw) if last_summary_raw else None
                except (TypeError, json.JSONDecodeError):
                    last_summary = None
                self._send_json(200, {**cfg, "last_summary": last_summary})

            elif path == "/api/editors":
                self._send_json(200, {"editors": detect_editors()})

            elif path == "/api/logs":
                try:
                    since = int(qs.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                try:
                    limit = max(1, min(1000, int(qs.get("limit", ["200"])[0])))
                except ValueError:
                    limit = 200
                levels = [lv for lv in qs.get("level", []) if lv in ("info","warn","error")]
                q = (qs.get("q", [""])[0] or "").strip()
                entries = _LOG_RING.query(
                    since_id=since,
                    levels=levels or None,
                    q=q or None,
                    limit=limit,
                )
                self._send_json(200, {
                    "entries": entries,
                    "latest_id": _LOG_RING.latest_id(),
                    "size": _LOG_RING.size(),
                    "capacity": _LOG_RING._buf.maxlen,
                    "levels": _LOG_RING.levels_summary(),
                })

            elif path == "/api/stats":
                self._send_json(200, server_stats())

            elif path == "/healthz":
                blob, ok = health_status()
                self._send_json(200 if ok else 503, blob)

            elif path == "/api/backup/settings":
                conn = db_connect()
                try:
                    settings = get_backup_settings(conn, _user_slug())
                    last_at = get_last_backup_at(conn)
                finally:
                    conn.close()
                next_at = None
                if last_at is not None:
                    next_at = last_at + settings["interval_days"] * 86400
                self._send_json(200, {
                    "settings": settings,
                    "last_backup_at": last_at,
                    "next_backup_at": next_at,
                    "default_dir": str(DEFAULT_BACKUP_DIR),
                })

            elif path == "/api/backup/history":
                qs = urllib.parse.parse_qs(parsed.query)
                try:
                    limit = int(qs.get("limit", ["50"])[0])
                except (TypeError, ValueError):
                    limit = 50
                with_details = qs.get("with_details", ["0"])[0] in (
                    "1", "true", "yes")
                conn = db_connect()
                try:
                    rows = list_backup_history(
                        conn, limit=limit, with_details=with_details)
                finally:
                    conn.close()
                self._send_json(200, {"entries": rows})

            elif path == "/api/backup/sqlite":
                # Stream the SQLite cache as a downloadable backup.
                # Uses the SQLite Online Backup API so the file is
                # consistent even if a writer is mid-transaction —
                # plain copy on a live DB is unsafe.
                if not DB_PATH.exists():
                    self._send_json(404, {"error": "no DB to back up"})
                    return
                try:
                    src = sqlite3.connect(str(DB_PATH))
                    try:
                        # Round-trip through a tempfile because sqlite3
                        # backup() needs a Connection target. Use a
                        # named temporary inside DEFAULT_CACHE so it
                        # lives on the same filesystem.
                        DEFAULT_CACHE.mkdir(parents=True, exist_ok=True)
                        with tempfile.NamedTemporaryFile(
                                dir=str(DEFAULT_CACHE),
                                prefix="backup-", suffix=".sqlite",
                                delete=False) as tf:
                            tmp_path = Path(tf.name)
                        try:
                            dst = sqlite3.connect(str(tmp_path))
                            try:
                                src.backup(dst)
                            finally:
                                dst.close()
                            body = tmp_path.read_bytes()
                        finally:
                            try:
                                tmp_path.unlink()
                            except OSError:
                                pass
                    finally:
                        src.close()
                except Exception as ex:  # noqa: BLE001
                    log_event("error", "backup",
                              "sqlite backup failed", error=str(ex))
                    self._send_json(500,
                                    {"error": f"backup failed: {ex}"})
                    return
                stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                fname = f"agent-workspace-{stamp}.sqlite"
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{fname}"')
                self.end_headers()
                self.wfile.write(body)

            elif path == "/api/week-summary":
                week = (qs.get("week", [""])[0] or "").strip() or iso_week_id()
                force = qs.get("force", ["0"])[0] in ("1", "true", "yes")
                if not re.match(r"^\d{4}-W\d{2}$", week):
                    self._send_json(400, {"error": "week must be 'YYYY-Www'"})
                    return
                # Refresh JSONL token + commit caches on demand so the
                # summary reflects the latest agent activity.
                self._scan_throttled()
                conn = db_connect()
                try:
                    summary = get_week_summary(conn, week, force=force)
                    self._send_json(200, summary)
                finally:
                    conn.close()

            elif path == "/api/week-summary/list":
                conn = db_connect()
                try:
                    self._send_json(200, {"weeks": list_week_summaries(conn)})
                finally:
                    conn.close()

            elif path == "/api/timer":
                conn = db_connect()
                try:
                    self._send_json(200, {"timer": get_timer(conn)})
                finally:
                    conn.close()

            elif path == "/api/worklogs":
                week = (qs.get("week", [""])[0] or "").strip() or iso_week_id()
                if not re.match(r"^\d{4}-W\d{2}$", week):
                    self._send_json(400, {"error": "week must be 'YYYY-Www'"})
                    return
                start, end = week_bounds(week)
                conn = db_connect()
                try:
                    self._send_json(200, {
                        "week_id": week,
                        "start": start, "end": end,
                        "entries": list_worklogs_in_range(conn, start, end),
                    })
                finally:
                    conn.close()

            elif path == "/api/known-issues":
                conn = db_connect()
                try:
                    self._send_json(200, {"issues": known_issues(conn)})
                finally:
                    conn.close()

            elif path == "/api/events":
                issue = (qs.get("issue", [""])[0] or "").strip() or None
                try:
                    limit = max(1, min(500, int(qs.get("limit", ["100"])[0])))
                except ValueError:
                    limit = 100
                conn = db_connect()
                try:
                    if issue:
                        rows = conn.execute(
                            "SELECT id, kind, issue, session_id, message, cwd, "
                            "created_at, read_at FROM agent_events "
                            "WHERE issue = ? "
                            "ORDER BY created_at DESC LIMIT ?",
                            (issue, limit)).fetchall()
                    else:
                        rows = conn.execute(
                            "SELECT id, kind, issue, session_id, message, cwd, "
                            "created_at, read_at FROM agent_events "
                            "ORDER BY created_at DESC LIMIT ?",
                            (limit,)).fetchall()
                    # Surface read_at so the dashboard can style read vs.
                    # unread rows and the "mark this row read" button can
                    # decide whether to show.
                    out = [
                        {"id": r[0], "kind": r[1], "issue": r[2],
                         "session_id": r[3], "message": r[4] or "",
                         "cwd": r[5] or "", "created_at": r[6],
                         "read_at": r[7]}
                        for r in rows
                    ]
                    self._send_json(200, {"events": out})
                finally:
                    conn.close()

            elif path == "/api/primaries/status":
                # Which of the user's expected repos already live under
                # the primaries root, and which are missing. The
                # dashboard renders a banner from this when anything's
                # missing, with one-click clone actions per repo. Also
                # surfaces in-flight + recently-failed clones from the
                # background thread launched by POST /api/primaries/clone.
                conn = db_connect()
                try:
                    expected = user_expected_repos(conn, _user_slug())
                    tmpl = user_clone_url_template(conn, _user_slug())
                finally:
                    conn.close()
                missing, present = primary_repo_status(primaries_root, expected)
                with _PRIMARIES_CLONE_LOCK:
                    in_flight = {k: dict(v) for k, v in _PRIMARIES_CLONE_STATES.items()
                                  if v.get("state") == "cloning"}
                    failed = {k: dict(v) for k, v in _PRIMARIES_CLONE_STATES.items()
                              if v.get("state") == "failed"}
                # `git clone` creates <target>/.git before it starts
                # receiving objects, so primary_repo_status() reports an
                # in-flight clone as "present" the moment the directory
                # appears. Move any in-flight repo back to "missing" so
                # the dashboard's banner keeps rendering the live
                # progress button until the clone actually finishes.
                if in_flight:
                    cloning = set(in_flight)
                    present = [r for r in present if r not in cloning]
                    for r in cloning:
                        if r in expected and r not in missing:
                            missing.append(r)
                # Per-repo clone URLs: prefer the github-repos entry
                # (so "Clone foo" uses https://github.com/owner/foo.git
                # automatically) and fall back to the legacy
                # {repo}-template if the user has one configured.
                slug = _user_slug()
                clone_urls: dict[str, str] = {}
                for r in expected:
                    gh_url = github_clone_url_for(slug, r)
                    if gh_url:
                        clone_urls[r] = gh_url
                    elif tmpl:
                        clone_urls[r] = tmpl.replace("{repo}", r)
                self._send_json(200, {
                    "primaries_root": str(primaries_root),
                    "missing": missing,
                    "present": present,
                    "clone_url_template": tmpl,
                    "clone_urls": clone_urls,
                    "in_flight": in_flight,
                    "recent_failures": failed,
                })

            elif path == "/api/agent/term/sessions":
                # Snapshot of live inline pty agents so the dashboard's
                # Agent sub-tab can render "running · pid 12345 · 3m"
                # or "not running" and decide whether the ▶ Start / ⏹
                # Stop button is the right one to show.
                self._send_json(200, {
                    "sessions": agentterm.list_sessions(),
                })

            elif path == "/api/agent/term/ws":
                self._do_agent_term_ws(qs)

            elif path == "/api/mcp/unread-counts":
                # Cheap polling endpoint for the dashboard's tab
                # badges. Avoids /api/status which is heavy and
                # only refreshes every 5 min. Returns {counts:
                # {agent_id: N, …}} — just the unread tally.
                conn = db_connect()
                try:
                    counts = agent_mcp.unread_counts(conn)
                finally:
                    conn.close()
                self._send_json(200, {"counts": counts})

            elif path == "/api/update/status":
                # Auto-update banner reads from this every refresh.
                # Cheap — returns the cached _STATUS dict.
                self._send_json(200, _updater.get_status())

            elif path == "/api/stashes":
                # General Agent's Stashes sub-tab. Walks every
                # primary under --primaries and returns its
                # `git stash list`. Cheap; no caching.
                items = _stashes.list_stashes(primaries_root)
                self._send_json(200, {"stashes": items})

            elif path == "/api/stashes/show":
                repo = (qs.get("repo", [""])[0] or "").strip()
                ref = (qs.get("ref", [""])[0] or "").strip()
                if not repo or not ref:
                    self._send_json(400,
                        {"error": "repo and ref are required"})
                else:
                    self._send_json(200,
                        _stashes.show_stash(primaries_root, repo, ref))

            elif path == "/api/mcp/messages":
                # Dashboard's Messages sub-tab inbox/outbox view.
                # Query string: ?agent=<id>&direction=inbox|outbox
                # &unread_only=0|1. Never marks messages read —
                # this is a passive view; reading-with-mark happens
                # through the MCP tool only.
                agent = (qs.get("agent", [""])[0] or "").strip()
                direction = (qs.get("direction", ["inbox"])[0]
                              or "inbox").lower()
                unread_only = qs.get("unread_only", ["0"])[0] in ("1", "true", "yes")
                conn = db_connect()
                try:
                    if direction == "outbox":
                        items = agent_mcp.list_outbox(conn, agent)
                    elif direction in ("thread", "all"):
                        items = agent_mcp.list_thread(conn, agent)
                    else:
                        items = agent_mcp.read_messages(
                            conn, agent,
                            unread_only=unread_only,
                            mark_read=False)
                finally:
                    conn.close()
                self._send_json(200, {
                    "agent": agent,
                    "direction": direction,
                    "messages": items,
                })

            elif path == "/api/preferences":
                conn = db_connect()
                try:
                    self._send_json(200, {
                        "user_slug": _user_slug(),
                        "preferences": get_preferences(conn, _user_slug()),
                    })
                finally:
                    conn.close()

            elif path == "/api/github/config":
                self._send_json(200, {
                    "configured": _github.is_configured(),
                    "has_token": _github.has_token(),
                    "repos": _github.configured_repos(),
                })

            elif path == "/api/providers":
                from awlib import providers as _providers
                self._send_json(200, {
                    "providers": [
                        {"id": p.id, "display_name": p.display_name,
                          "binary": p.binary,
                          "installed": p.is_installed(),
                          "supports_mcp": p.supports_mcp(),
                          "auto_registers_mcp": p.auto_registers_mcp(),
                          "supports_hooks": p.supports_hooks()}
                        for p in _providers.all_providers()
                    ],
                })

            elif path == "/api/github/issues":
                force = qs.get("force", ["0"])[0] in ("1", "true", "yes")
                items, err = _github.fetch_my_issues(force=force)
                self._send_json(200, {"issues": items, "error": err,
                                       "repos": _github.configured_repos()})

            elif path == "/api/github/prs":
                force = qs.get("force", ["0"])[0] in ("1", "true", "yes")
                items, err = _github.fetch_my_prs(force=force)
                self._send_json(200, {"prs": items, "error": err,
                                       "repos": _github.configured_repos()})

            elif path == "/api/notes":
                issue = (qs.get("issue", [""])[0] or "").strip() or None
                conn = db_connect()
                try:
                    self._send_json(200, {
                        "user_slug": _user_slug(),
                        "notes": list_notes(conn, _user_slug(), issue),
                    })
                finally:
                    conn.close()

            elif path == "/api/docs":
                # In-app docs viewer: returns the raw markdown of one
                # of the project doc files. Allowlisted to prevent the
                # endpoint becoming a generic file reader.
                allowed = {"README.md", "AGENTS.md"}
                qs = urllib.parse.parse_qs(parsed.query)
                name = (qs.get("file", ["README.md"])[0] or "").strip()
                if name not in allowed:
                    self._send_json(400, {"error": "unknown doc file"})
                    return
                doc_path = REPO_DIR / name
                try:
                    body = doc_path.read_text(encoding="utf-8")
                except OSError as ex:
                    self._send_json(404, {"error": f"{name}: {ex}"})
                    return
                self._send_json(200, {"file": name, "content": body})

            elif path == "/favicon.ico":
                # Some clients ask for /favicon.ico despite the <link> tag.
                # Redirect to the SVG version.
                self.send_response(302)
                self.send_header("Location", "/static/favicon.svg")
                self.send_header("Content-Length", "0")
                self.end_headers()

            elif path == "/sw.js":
                # Serve the service worker at the site root so its
                # default scope is `/`, controlling the whole
                # dashboard. Substitute __SW_VERSION__ with a hash of
                # every precached asset's mtime so any static-file
                # change re-installs the SW and refreshes its cache.
                sw_path = STATIC_DIR / "sw.js"
                try:
                    body = sw_path.read_bytes()
                except OSError:
                    self._send(404, "text/plain", b"sw.js missing")
                    return
                body = body.replace(b"__SW_VERSION__",
                                    _sw_cache_version().encode("ascii"))
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Service-Worker-Allowed", "/")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            elif path.startswith("/static/"):
                self._serve_static(path[len("/static/"):])

            else:
                self._send(404, "text/plain", b"Not found")

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/sync-now":
                self._do_sync_now()
            elif parsed.path == "/api/sync-toggle":
                want = qs.get("enabled", ["toggle"])[0].lower()
                self._do_sync_toggle(want)
            elif parsed.path == "/api/open-file":
                self._do_open_file()
            elif parsed.path == "/api/week-summary":
                week = (qs.get("week", [""])[0] or "").strip() or iso_week_id()
                if not re.match(r"^\d{4}-W\d{2}$", week):
                    self._send_json(400, {"error": "week must be 'YYYY-Www'"})
                    return
                conn = db_connect()
                try:
                    summary = get_week_summary(conn, week, force=True)
                    self._send_json(200, summary)
                finally:
                    conn.close()
            elif parsed.path == "/api/worklogs":
                self._do_add_worklog()
            elif parsed.path == "/api/timer/start":
                self._do_timer_start()
            elif parsed.path == "/api/timer/stop":
                self._do_timer_stop()
            elif parsed.path == "/api/timer/comment":
                self._do_timer_comment()
            elif parsed.path == "/api/events":
                self._do_post_event()
            elif parsed.path == "/api/events/mark-read":
                self._do_mark_events_read(qs)
            elif parsed.path == "/api/preferences":
                self._do_set_preferences()
            elif parsed.path == "/api/notes":
                self._do_post_note()
            elif parsed.path.startswith("/api/git/"):
                op = parsed.path[len("/api/git/"):].strip("/")
                self._do_git_op(op, qs)
            elif parsed.path == "/api/issue/create":
                self._do_create_issue()
            elif parsed.path == "/api/open-agent-tab":
                self._do_open_claude_tab()
            elif parsed.path.startswith("/api/issue/git-op/"):
                op = parsed.path[len("/api/issue/git-op/"):].strip("/")
                self._do_issue_git_op(op, qs)
            elif parsed.path == "/api/issue/remove":
                self._do_remove_issue()
            elif parsed.path == "/api/primaries/clone":
                self._do_primaries_clone()
            elif parsed.path == "/api/admin/reset-workspace":
                self._do_reset_workspace()
            elif parsed.path == "/api/agent/term/stop":
                self._do_agent_term_stop()
            elif parsed.path == "/api/agent/term/resize":
                self._do_agent_term_resize()
            elif parsed.path == "/api/agent/upload":
                self._do_agent_upload(qs)
            elif parsed.path == "/mcp":
                self._do_mcp(qs)

            elif parsed.path == "/api/terminal-image":
                self._do_terminal_image()

            elif parsed.path == "/api/mcp/delete":
                # Per-message ✕ button on the dashboard's Messages
                # pane. Body: {"id": <int>}. Hard delete — no undo.
                body = self._read_json_body() or {}
                mid = body.get("id")
                if not isinstance(mid, int):
                    self._send_json(400,
                        {"error": "id (int) required"})
                else:
                    conn = db_connect()
                    try:
                        ok = agent_mcp.delete_message(conn, mid)
                    finally:
                        conn.close()
                    self._send_json(200, {"ok": ok, "id": mid})

            elif parsed.path == "/api/mcp/delete-all":
                # "Delete all" button on the Messages pane. Removes
                # every message sent to or from the given agent.
                # Body: {"agent": "<key>"}
                body = self._read_json_body() or {}
                agent_key = body.get("agent", "")
                if not agent_key:
                    self._send_json(400, {"error": "agent required"})
                else:
                    conn = db_connect()
                    try:
                        n = agent_mcp.delete_all_messages(conn, agent_key)
                    finally:
                        conn.close()
                    self._send_json(200, {"ok": True, "deleted": n})

            elif parsed.path == "/api/mcp/delete-thread":
                # ✕ button on a threaded row → user confirmed they
                # want the entire conversation gone. Walks the
                # in_reply_to chain to its root, then BFS down, then
                # one DELETE statement for the lot.
                body = self._read_json_body() or {}
                mid = body.get("id")
                if not isinstance(mid, int):
                    self._send_json(400,
                        {"error": "id (int) required"})
                else:
                    conn = db_connect()
                    try:
                        n = agent_mcp.delete_thread(conn, mid)
                    finally:
                        conn.close()
                    self._send_json(200, {"ok": n > 0, "deleted": n})
            elif parsed.path == "/api/update/check":
                # Manual "check now" — bypass the 10-min poll. Used
                # by the banner's ↻ link. Returns the fresh status.
                cur = _updater.check_remote(REPO_DIR)
                _updater.set_status(cur)
                self._send_json(200, cur)

            elif parsed.path == "/api/update/apply":
                self._do_update_apply()

            elif parsed.path == "/api/server/restart":
                self._do_server_restart()

            elif parsed.path == "/api/stashes/drop":
                # Per-row ✕ button on the General Agent's Stashes
                # sub-tab. Body: {"repo": "core", "ref": "stash@{N}"}.
                # Hard delete — no undo. Both args validated inside
                # awlib.stashes.drop_stash before any git runs.
                body = self._read_json_body() or {}
                repo = (body.get("repo") or "").strip()
                ref = (body.get("ref") or "").strip()
                if not repo or not ref:
                    self._send_json(400,
                        {"error": "repo and ref are required"})
                else:
                    result = _stashes.drop_stash(
                        primaries_root, repo, ref)
                    code = 200 if result.get("ok") else 400
                    self._send_json(code, result)
            elif parsed.path == "/api/restore/sqlite":
                self._do_restore_sqlite()
            elif parsed.path == "/api/backup/settings":
                self._do_set_backup_settings()
            elif parsed.path == "/api/backup/run-now":
                self._do_backup_run_now()
            elif parsed.path == "/api/cleanup-config":
                self._do_set_cleanup_config()
            elif parsed.path == "/api/cleanup-now":
                self._do_cleanup_now()
            else:
                self._send(404, "text/plain", b"Not found")

        def _do_git_op(self, op: str, qs):
            """Run a whitelisted git operation in a worktree.

            Only operations that can't leave the working tree in a
            half-merged / conflicted state are accepted: fetch (read
            only), pull --ff-only (aborts on divergence), push (no
            --force, rejected on divergence).
            """
            issue = (qs.get("issue", [""])[0] or "").strip()
            repo = (qs.get("repo", [""])[0] or "").strip()
            if not issue or not repo:
                self._send_json(400, {"error": "issue and repo are required"})
                return
            wt = (worktrees_root / issue / repo)
            try:
                wt_resolved = wt.resolve()
                wt_resolved.relative_to(worktrees_root.resolve())
            except (OSError, ValueError):
                self._send_json(400, {"error": "path escapes worktrees_root"})
                return
            if not (wt_resolved / ".git").exists():
                self._send_json(404, {"error": f"no worktree at {wt}"})
                return

            argv: list[str]
            if op == "fetch":
                argv = ["fetch", "--prune", "origin"]
            elif op == "pull-ff":
                argv = ["pull", "--ff-only"]
            elif op == "push":
                # Push the current branch by name to origin. No --force.
                branch = _git(wt_resolved, "branch", "--show-current")
                if not branch:
                    self._send_json(400, {
                        "error": "detached HEAD — refusing to push"})
                    return
                argv = ["push", "origin", branch]
            else:
                self._send_json(404, {
                    "error": f"unknown git op: {op}",
                    "supported": ["fetch", "pull-ff", "push"]})
                return

            t0 = time.time()
            res = subprocess.run(
                ["git", "-C", str(wt_resolved), *argv],
                capture_output=True, text=True, check=False,
                timeout=60,
            )
            duration_ms = int((time.time() - t0) * 1000)
            # Strip the OpenSSH "post-quantum key exchange" warning
            # block. Every line in that block is prefixed with "**", so
            # we drop those (plus blank-on-blank churn afterwards). It's
            # noise — git itself never emits "**".
            def _denoise(text: str) -> str:
                lines = [ln for ln in (text or "").splitlines()
                         if not ln.lstrip().startswith("**")]
                while lines and not lines[0].strip():
                    lines.pop(0)
                while lines and not lines[-1].strip():
                    lines.pop()
                return "\n".join(lines)
            self._send_json(200, {
                "ok": res.returncode == 0,
                "op": op,
                "argv": argv,
                "stdout": _denoise(res.stdout),
                "stderr": _denoise(res.stderr),
                "returncode": res.returncode,
                "duration_ms": duration_ms,
            })

        def _do_issue_git_op(self, op: str, qs):
            """Run a whitelisted git operation across every repo of an issue.

            Same safety profile as `_do_git_op` — only fetch / pull-ff /
            push are accepted. Returns one result entry per repo so the
            caller can render a per-repo summary.
            """
            issue = (qs.get("issue", [""])[0] or "").strip()
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            if op not in ("fetch", "pull-ff", "push"):
                self._send_json(404, {
                    "error": f"unknown git op: {op}",
                    "supported": ["fetch", "pull-ff", "push"]})
                return
            issue_dir = worktrees_root / issue
            try:
                issue_resolved = issue_dir.resolve()
                issue_resolved.relative_to(worktrees_root.resolve())
            except (OSError, ValueError):
                self._send_json(400, {"error": "path escapes worktrees_root"})
                return
            if not issue_resolved.is_dir():
                self._send_json(404, {
                    "error": f"no issue dir at {issue_dir}"})
                return

            def _denoise(text: str) -> str:
                lines = [ln for ln in (text or "").splitlines()
                         if not ln.lstrip().startswith("**")]
                while lines and not lines[0].strip():
                    lines.pop(0)
                while lines and not lines[-1].strip():
                    lines.pop()
                return "\n".join(lines)

            results: list[dict] = []
            for repo_dir in sorted(p for p in issue_resolved.iterdir()
                                   if p.is_dir() and (p / ".git").exists()):
                repo_name = repo_dir.name
                if op == "fetch":
                    argv = ["fetch", "--prune", "origin"]
                elif op == "pull-ff":
                    argv = ["pull", "--ff-only"]
                else:  # push
                    branch = _git(repo_dir, "branch", "--show-current")
                    if not branch:
                        results.append({
                            "repo": repo_name, "ok": False,
                            "skipped": "detached HEAD",
                            "stdout": "", "stderr": "",
                            "returncode": -1, "duration_ms": 0,
                        })
                        continue
                    argv = ["push", "origin", branch]

                t0 = time.time()
                try:
                    res = subprocess.run(
                        ["git", "-C", str(repo_dir), *argv],
                        capture_output=True, text=True, check=False,
                        timeout=60,
                    )
                    results.append({
                        "repo": repo_name,
                        "ok": res.returncode == 0,
                        "argv": argv,
                        "stdout": _denoise(res.stdout),
                        "stderr": _denoise(res.stderr),
                        "returncode": res.returncode,
                        "duration_ms": int((time.time() - t0) * 1000),
                    })
                except subprocess.TimeoutExpired:
                    results.append({
                        "repo": repo_name, "ok": False,
                        "stdout": "", "stderr": "timeout after 60s",
                        "returncode": -1,
                        "duration_ms": int((time.time() - t0) * 1000),
                    })

            self._send_json(200, {
                "issue": issue, "op": op,
                "results": results,
                "n_total": len(results),
                "n_ok": sum(1 for r in results if r.get("ok")),
            })

        def _do_post_event(self):
            body = self._read_json_body() or {}
            kind = (body.get("kind") or "").strip()
            if not kind:
                self._send_json(400, {"error": "kind is required"})
                return
            conn = db_connect()
            try:
                event_id = insert_agent_event(
                    conn,
                    kind=kind,
                    issue=(body.get("issue") or "").strip(),
                    session_id=(body.get("session_id") or "").strip(),
                    message=(body.get("message") or "").strip(),
                    cwd=(body.get("cwd") or "").strip(),
                )
                self._send_json(200, {"id": event_id})
            finally:
                conn.close()

        def _do_mark_events_read(self, qs):
            issue = (qs.get("issue", [""])[0] or "").strip() or None
            event_id_raw = (qs.get("id", [""])[0] or "").strip()
            event_id: int | None = None
            if event_id_raw:
                try:
                    event_id = int(event_id_raw)
                except ValueError:
                    self._send_json(400, {"error": "id must be an integer"})
                    return
            conn = db_connect()
            try:
                n = mark_agent_events_read(conn, issue=issue, event_id=event_id)
                self._send_json(200, {"marked_read": n})
            finally:
                conn.close()

        def _do_set_preferences(self):
            """Body shape: {"preferences": {<key>: <json-value>, ...}}.
            A value of `null` deletes that key. Returns the merged set."""
            body = self._read_json_body() or {}
            updates = body.get("preferences")
            if not isinstance(updates, dict):
                self._send_json(400, {
                    "error": "expected JSON body {\"preferences\": {...}}"})
                return
            conn = db_connect()
            try:
                set_preferences(conn, _user_slug(), updates)
                conn.commit()
                self._send_json(200, {
                    "user_slug": _user_slug(),
                    "preferences": get_preferences(conn, _user_slug()),
                })
            finally:
                conn.close()
            if "github-repos" in updates:
                _refresh_github_config()

        def _do_set_backup_settings(self):
            """Body shape: {"settings": {enabled?, interval_days?, dir?, retention?}}.
            Unknown keys ignored. Returns the merged effective settings."""
            body = self._read_json_body() or {}
            updates = body.get("settings")
            if not isinstance(updates, dict):
                self._send_json(400, {
                    "error": "expected JSON body {\"settings\": {...}}"})
                return
            conn = db_connect()
            try:
                # Translate the public field names into preferences keys.
                pref_updates = {
                    f"backup_{k}": v for k, v in updates.items()
                    if k in ("enabled", "interval_days", "dir", "retention")
                }
                set_backup_settings(conn, _user_slug(), pref_updates)
                settings = get_backup_settings(conn, _user_slug())
                last_at = get_last_backup_at(conn)
                self._send_json(200, {
                    "settings": settings,
                    "last_backup_at": last_at,
                    "default_dir": str(DEFAULT_BACKUP_DIR),
                })
            finally:
                conn.close()

        def _do_backup_run_now(self):
            """Run a backup synchronously and return the result. Used by
            the "Run backup now" button — the scheduled loop calls
            run_backup_now() directly."""
            conn = db_connect()
            try:
                settings = get_backup_settings(conn, _user_slug())
                dest = Path(settings["dir"]).expanduser()
                result = run_backup_now(
                    conn, DB_PATH, dest, worktrees_root)
                prune_backups(dest, settings["retention"])
            finally:
                conn.close()
            status = 200 if result["ok"] else 500
            self._send_json(status, result)

        def do_PUT(self):
            parsed = urllib.parse.urlparse(self.path)
            m = re.match(r"^/api/notes/(\d+)$", parsed.path)
            if m:
                self._do_put_note(int(m.group(1)))
                return
            self._send(404, "text/plain", b"Not found")

        def _do_open_claude_tab(self):
            """Spawn `bin/agent-worktrees --issue=<key>` to open a
            single new gnome-terminal tab attached to the user's
            existing terminal window, with `claude --continue` running
            in the right worktree. The dashboard's environment (DISPLAY,
            etc.) is inherited because the server is started from the
            user's interactive desktop session."""
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            model = (body.get("model") or "").strip()
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            if not re.match(r"^[A-Za-z0-9._/-]+$", issue) \
               or issue.startswith(("/", ".")) \
               or ".." in issue.split("/"):
                self._send_json(400, {"error": "invalid issue name"})
                return
            # Model is optional; when set it's passed straight to claude
            # via `--model`. Restricting the alphabet here means the
            # bash word-splitting in agent-worktrees' LAUNCH_BODY can't
            # be abused for shell injection.
            if model and not re.match(r"^[A-Za-z0-9._/-]+$", model):
                self._send_json(400, {"error": "invalid model name"})
                return
            if not (worktrees_root / issue).is_dir():
                self._send_json(404, {
                    "error": f"no worktree dir at {worktrees_root}/{issue}"})
                return
            script = REPO_DIR / "bin" / "agent-worktrees"
            if not script.is_file():
                self._send_json(500, {
                    "error": f"launcher missing at {script}"})
                return
            cmd = [str(script), f"--issue={issue}",
                   f"--worktrees={worktrees_root}"]
            if model:
                cmd.append(f"--model={model}")
            # Detach so the spawned launcher survives this request.
            # POSIX uses start_new_session; Windows needs the
            # CREATE_NEW_PROCESS_GROUP creationflag instead.
            detach_kwargs: dict = {}
            if IS_WINDOWS:
                detach_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                detach_kwargs["start_new_session"] = True
            # Thread the dashboard's own port into the launcher's env
            # so agents spawned from a demo instance on a non-default
            # port (e.g. :9001) POST their `agent-event-notify` hooks
            # back to *this* dashboard, not the user's primary on
            # :8765. bin/agent-worktrees and the per-terminal launch
            # bodies all read AGENT_WORKSPACE_PORT from the
            # environment.
            child_env = dict(os.environ)
            child_env["AGENT_WORKSPACE_PORT"] = str(
                self.server.server_address[1])
            try:
                subprocess.Popen(
                    cmd,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    env=child_env,
                    **detach_kwargs,
                )
            except OSError as ex:
                self._send_json(500, {"error": f"spawn failed: {ex}"})
                return
            self._send_json(200, {"issue": issue, "ok": True, "model": model})

        def _agent_term_env(self, agent_id: str = "") -> dict:
            """Env dict for an inline-agent pty subprocess. Mirrors the
            external launcher's env contract so the spawned `claude`
            looks identical to what gnome-terminal would produce —
            same AGENT_WORKSPACE_LAUNCHED + AGENT_WORKSPACE_PORT,
            same PATH, etc. When `agent_id` is given, also exports
            AGENT_WORKSPACE_AGENT_ID so the UserPromptSubmit mailbox
            hook knows whose inbox to check.

            TERM / COLORTERM / FORCE_COLOR are forced to colour-capable
            values regardless of what the dashboard server inherited.
            Without this, when the server is launched by XDG autostart
            / launchd / Windows Startup (no controlling tty) the parent
            either has TERM unset or TERM=dumb, and the child claude
            renders monochrome inside the xterm.js panel — which does
            support full 256-colour / truecolor."""
            env = dict(os.environ)
            env["AGENT_WORKSPACE_LAUNCHED"] = "1"
            env["AGENT_WORKSPACE_PORT"] = str(self.server.server_address[1])
            env["TERM"] = "xterm-256color"
            env["COLORTERM"] = "truecolor"
            # FORCE_COLOR is honoured by Node / npm / chalk-based tools
            # that don't look at TERM. Belt-and-braces for any helper
            # claude spawns in turn.
            env["FORCE_COLOR"] = "1"
            # Re-add the user's standard local bin dirs to PATH. When
            # the server is launched by XDG autostart / systemd user
            # units the parent PATH is the systemd default (no .bashrc
            # / .profile sourcing), so ~/.local/bin is missing — and
            # `claude` typically lives there, which makes the inline
            # agent pty fail with `claude: command not found`. Prepend
            # only when missing so an interactive launch is unchanged.
            path_parts = env.get("PATH", "").split(os.pathsep)
            for cand in (Path.home() / ".local" / "bin",
                         Path.home() / "bin"):
                cand_s = str(cand)
                if cand.is_dir() and cand_s not in path_parts:
                    path_parts.insert(0, cand_s)
            env["PATH"] = os.pathsep.join(path_parts)
            if agent_id:
                env["AGENT_WORKSPACE_AGENT_ID"] = agent_id
            return env

        def _agent_term_resolve(self, qs) -> tuple[str, Path] | None:
            """Pull `issue` out of the query string, validate, and
            return (issue, cwd). For per-issue agents the cwd is
            <worktrees_root>/<issue> — claude runs there, identical
            to what the external Agent button gives you. The
            sentinel `__agent__` resolves to the user's $HOME and
            powers the pinned, issue-less General Agent tab.
            Sends an error response and returns None on bad input."""
            issue = (qs.get("issue", [""])[0] or "").strip()
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return None
            if issue == "__agent__":
                # Open the General Agent in the dashboard's
                # worktrees root (e.g. ~/github/worktrees), so the
                # agent's cwd is the parent of every issue dir
                # and it can `cd <issue>` into any of them without
                # leaving $HOME first. Falls back to $HOME if the
                # configured root doesn't exist on disk.
                root = worktrees_root if worktrees_root.is_dir() \
                       else Path.home()
                return issue, root
            if not re.match(r"^[A-Za-z0-9._/-]+$", issue) \
               or issue.startswith(("/", ".")) \
               or ".." in issue.split("/"):
                self._send_json(400, {"error": "invalid issue name"})
                return None
            wt = worktrees_root / issue
            if not wt.is_dir():
                self._send_json(404, {
                    "error": f"no issue dir at {wt}"})
                return None
            return issue, wt

        def _do_agent_term_ws(self, qs):
            """WebSocket upgrade for the inline agent console.

            Validates the issue, looks up (or spawns) the pty session,
            performs the RFC 6455 handshake by hand, and runs the
            bridge until the WS closes. The pty session stays alive
            after the WS closes so a browser tab close / reopen
            re-attaches to the same agent. One session per issue, cwd
            = <worktrees_root>/<issue> (matches the external Agent
            button's "open the whole issue dir" semantics).
            """
            resolved = self._agent_term_resolve(qs)
            if resolved is None:
                return
            issue, wt = resolved
            # Handshake headers.
            ws_key = self.headers.get("Sec-WebSocket-Key", "").strip()
            upgrade = (self.headers.get("Upgrade") or "").lower()
            if not ws_key or upgrade != "websocket":
                self._send_json(400, {"error": "not a WebSocket upgrade"})
                return
            try:
                cols = int(qs.get("cols", ["120"])[0])
                rows = int(qs.get("rows", ["32"])[0])
            except ValueError:
                cols, rows = 120, 32
            # Clamp away nonsensical initial dims — a client that
            # measures the host before layout settles can ask for a
            # cols=10 pty, after which every byte claude writes
            # wraps at 10 chars. Hold the floor at a sane default.
            if cols < 40:
                cols = 120
            if rows < 5:
                rows = 32
            # Bake a per-agent MCP config file so the agent CLI can reach the
            # in-process MCP server with the right ?agent=<id> identity.
            # Skipped when the user has turned MCP off — agents launch
            # with no MCP server registered and the tools are invisible.
            mcp_cfg_path: Path | None = None
            if _mcp_enabled_now():
                try:
                    mcp_cfg_path = _write_mcp_config_for_agent(
                        issue, self.server.server_address[1])
                except OSError as ex:
                    log_event("warning", "mcp",
                              "failed to write per-agent mcp config",
                              issue=issue, error=str(ex))
                # Pre-accept the workspace-trust + MCP-enable dialogs
                # for this cwd so the agent launches without pausing
                # on either confirmation. We control the working
                # directory (worktrees_root / <issue>), the MCP server
                # is the dashboard's own in-process one — neither
                # warrants a per-launch prompt.
                _preauth_claude_project(wt, agent_mcp.SERVER_SLUG)
            # Model selection: only honoured for the pinned General
            # Agent today (per-workspace agents have their own external
            # model picker). The pref's empty value means "let the agent
            # CLI pick its default" — we forward None in that case so
            # build_agent_argv omits the --model flag entirely.
            model_pref = None
            provider_pref = "claude"
            try:
                conn = db_connect()
                try:
                    prefs = get_preferences(conn, _user_slug())
                finally:
                    conn.close()
                raw_provider = (prefs.get("default-provider") or "").strip()
                if raw_provider:
                    provider_pref = raw_provider
                if issue == "__agent__":
                    raw = prefs.get("general-agent-model") or ""
                    if raw and raw != "default":
                        model_pref = raw
            except Exception:  # noqa: BLE001
                pass
            argv = agentterm.build_agent_argv(
                issue, wt,
                branch=issue, model=model_pref,
                mcp_config_path=mcp_cfg_path,
                provider_id=provider_pref)
            env = self._agent_term_env(agent_id=issue)
            try:
                session = agentterm.get_or_create(
                    issue, wt, argv, env, cols=cols, rows=rows)
            except OSError as ex:
                self._send_json(500, {"error": f"pty spawn failed: {ex}"})
                return
            if not session.attach_lock.acquire(blocking=False):
                self._send_json(409, {"error":
                    "another WebSocket is already attached to this session"})
                return
            accept = agentterm.ws_accept_key(ws_key)
            resp = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                "\r\n"
            )
            try:
                self.wfile.write(resp.encode("ascii"))
                self.wfile.flush()
            except OSError:
                session.attach_lock.release()
                return
            sock = self.connection
            framer = agentterm.WebSocketFramer(sock)
            # Control frame first: tell the client what size the pty
            # is running at so it can match its xterm to those dims
            # instead of trying to resize the pty (which would
            # SIGWINCH claude and cause a TUI redraw flicker on every
            # browser refresh).
            init = json.dumps({
                "type": "init",
                "cols": session.cols,
                "rows": session.rows,
            }).encode()
            if not framer.send_frame(0x1, init):  # text frame
                session.attach_lock.release()
                return
            # Then replay the rolling scrollback so the new client
            # sees the agent's history. xterm.js treats the replayed
            # bytes the same as live ones — color, cursor, scrollback
            # all reconstruct.
            #
            # Prepend a hard terminal reset (RIS = \x1bc) + alternate
            # screen exit + scroll region reset + clear so the replay
            # starts from a known state. claude's TUI uses absolute
            # cursor positioning + status-bar redraws; without the
            # reset, replaying the full history can leave stacked
            # status bars and duplicated content in scrollback.
            #
            # Client may opt out via ?no_replay=1 (user-initiated
            # Reconnect). The cached bytes were captured at the
            # previous pty width; replaying into a wider xterm
            # would wrap every line wrong. With the opt-out we
            # still send the prelude reset, then let claude's
            # own redraw (nudged by the Ctrl+L the client writes
            # right after attach) repaint the screen cleanly.
            no_replay = qs.get("no_replay", ["0"])[0] in ("1", "true", "yes")
            replay = b"" if no_replay else session.snapshot_scrollback()
            if replay:
                prelude = (b"\x1bc"            # RIS — full terminal reset
                           b"\x1b[?1049l"      # exit alternate screen
                           b"\x1b[r"           # reset scroll region
                           b"\x1b[H\x1b[2J")   # cursor home + clear
                if not framer.send_frame(0x2, prelude + replay):
                    session.attach_lock.release()
                    return
            log_event("info", "agent-term", "attached",
                      issue=issue, pid=session.pid,
                      replay_bytes=len(replay))
            try:
                agentterm.bridge(session, framer)
            finally:
                session.attach_lock.release()
                log_event("info", "agent-term", "detached",
                          issue=issue, pid=session.pid)
            self.close_connection = True

        def _do_terminal_image(self):
            """Queue an image for display in an agent terminal.

            Body (JSON):
              issue  – issue key or '__agent__' (required)
              data   – base64-encoded PNG/JPEG (mutually exclusive with file)
              file   – absolute path to an image file on disk

            The dashboard polls GET /api/terminal-image/pending every second
            and writes the IIP escape sequence directly to xterm.js.
            """
            import base64 as _b64
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            data = body.get("data", "")
            file_path = body.get("file", "")
            if not data and file_path:
                try:
                    with open(file_path, "rb") as fh:
                        data = _b64.b64encode(fh.read()).decode()
                except OSError as exc:
                    self._send_json(400, {"error": str(exc)})
                    return
            if not data:
                self._send_json(400, {"error": "data or file is required"})
                return
            with _TERM_IMAGE_LOCK:
                _TERM_IMAGE_QUEUE.append({"issue": issue, "data": data})
            self._send_json(200, {"queued": True, "issue": issue})

        def _do_agent_term_stop(self):
            """Body: {issue}. SIGTERM the pty session for that issue
            and drop it from the registry."""
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            ok = agentterm.stop_session(issue)
            self._send_json(200, {"issue": issue, "stopped": ok})

        def _do_agent_upload(self, qs):
            """Drag-drop fallback for files the browser only exposes
            as bytes (no host path). Body is the raw file content;
            query params are:
              issue=<id>   target agent (issue key or __agent__)
              name=<file>  client-supplied filename

            Body is streamed in 64 KB chunks to
            `<agent-cwd>/.claude-uploads/<YYYYMMDD-HHMMSS>-<safe>`
            and capped at MAX_UPLOAD_BYTES. Returns
            {ok, path, name, size} on success.
            """
            issue = (qs.get("issue", [""])[0] or "").strip()
            name = (qs.get("name", [""])[0] or "").strip()
            if not issue or not name:
                self._send_json(400,
                    {"error": "issue and name are required"})
                return
            # Issue validation mirrors _agent_term_resolve so a
            # malicious issue can't traverse out of the worktrees
            # root via something like "../etc/passwd".
            if issue == "__agent__":
                target_cwd = worktrees_root
            else:
                if not re.match(r"^[A-Za-z0-9._/-]+$", issue) \
                   or issue.startswith(("/", ".")) \
                   or ".." in issue.split("/"):
                    self._send_json(400, {"error": "invalid issue"})
                    return
                target_cwd = worktrees_root / issue
                if not target_cwd.is_dir():
                    self._send_json(404,
                        {"error": f"no issue dir at {target_cwd}"})
                    return
            # Sanitise the client-supplied filename. Strip any path
            # component, normalise whitespace, fall back to a stub
            # so we always have something writeable.
            safe = re.sub(r"[/\\]", "_", name).strip()
            safe = re.sub(r"[\x00-\x1f]", "", safe)[:200] or "upload"
            # Content-Length sanity: cap before we even start
            # reading. Treat missing / negative as 0 so weird
            # clients don't sneak past — the chunked read below
            # also caps, but bailing here saves the disk hit.
            try:
                claimed = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                claimed = 0
            if claimed > MAX_UPLOAD_BYTES:
                self._send_json(413,
                    {"error": f"file too large (max "
                                f"{MAX_UPLOAD_BYTES // (1024*1024)} MB)"})
                return
            uploads_dir = target_cwd / ".claude-uploads"
            try:
                uploads_dir.mkdir(parents=True, exist_ok=True)
            except OSError as ex:
                self._send_json(500,
                    {"error": f"could not create uploads dir: {ex}"})
                return
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            out_path = uploads_dir / f"{ts}-{safe}"
            # Stream body in chunks, hard-cap at MAX_UPLOAD_BYTES.
            remaining = claimed if claimed > 0 else MAX_UPLOAD_BYTES
            written = 0
            try:
                with out_path.open("wb") as fh:
                    while remaining > 0:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            break
                        fh.write(chunk)
                        written += len(chunk)
                        remaining -= len(chunk)
                        if written > MAX_UPLOAD_BYTES:
                            # The Content-Length lied; bail.
                            fh.close()
                            try:
                                out_path.unlink()
                            except OSError:
                                pass
                            self._send_json(413,
                                {"error": "stream exceeded size cap"})
                            return
            except OSError as ex:
                self._send_json(500,
                    {"error": f"write failed: {ex}"})
                return
            self._send_json(200, {
                "ok": True,
                "path": str(out_path),
                "name": safe,
                "size": written,
            })

        def _do_agent_term_resize(self):
            """Body: {issue, cols, rows}. Update the pty window size
            via TIOCSWINSZ. The browser sends this on every xterm
            resize so claude re-flows its output."""
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            try:
                cols = int(body.get("cols", 0))
                rows = int(body.get("rows", 0))
            except (TypeError, ValueError):
                self._send_json(400, {"error": "cols/rows must be integers"})
                return
            if not issue or cols < 2 or rows < 1:
                self._send_json(400, {"error":
                    "issue required; cols>=2 rows>=1"})
                return
            s = agentterm.get_session(issue)
            if s is None:
                self._send_json(404, {"error": "no session"})
                return
            s.resize(cols, rows)
            self._send_json(200, {"ok": True, "cols": cols, "rows": rows})

        def _do_mcp(self, qs):
            """JSON-RPC 2.0 endpoint for the agent-to-agent MCP server.

            Body is a single JSON-RPC request; the agent's identity
            comes from (in priority order):
              1. URL query string  ?agent=<id>      (Claude Code path)
              2. HTTP header        X-Agent-Id: <id> (Cursor / Codex /
                 Gemini path — their MCP configs are global and the
                 per-launch identity flows through a custom header)
              3. Empty (rejected by the dispatcher)

            The dispatcher in awlib/agent_mcp.McpServer does all the
            real work and decides what to return.
            """
            # MCP can be disabled via the dashboard pref (default ON).
            # Honour that here as defence in depth — even if the
            # agent's mcp-config file points at this endpoint, an
            # off-toggle stops it cold.
            if not _mcp_enabled_now():
                self._send_json(503, {"error": "mcp disabled"})
                return
            agent = (qs.get("agent", [""])[0] or "").strip()
            if not agent:
                agent = (self.headers.get("X-Agent-Id") or "").strip()
            body = self._read_json_body() or {}
            # The dispatcher uses these callbacks to validate
            # send_message recipients and pick broadcast targets.
            # Both close over `worktrees_root` from the handler
            # factory's closure.
            def _known_agents():
                ids: set[str] = {"__agent__"}
                if worktrees_root.is_dir():
                    for p in worktrees_root.iterdir():
                        # Skip hidden dirs like .claude — they're
                        # config, not issue worktrees.
                        if p.is_dir() and not p.name.startswith("."):
                            ids.add(p.name)
                return ids

            def _live_agents():
                return [s.issue for s in agentterm.iter_sessions()]

            srv = agent_mcp.McpServer(
                db_connect,
                known_agents=_known_agents,
                live_agents=_live_agents)
            response = srv.dispatch(agent, body)
            # If this was a tools/call that may have inserted a new
            # row in agent_messages (send_message / request_review),
            # wake the auto-poll thread so the recipient gets nudged
            # within seconds instead of waiting up to a poll cycle.
            try:
                if (isinstance(body, dict)
                        and body.get("method") == "tools/call"
                        and isinstance(response, dict)
                        and "result" in response):
                    name = (body.get("params", {}) or {}).get("name") or ""
                    if name in ("send_message", "request_review",
                                  "broadcast_message"):
                        mailbox_wake_now()
            except Exception:  # noqa: BLE001
                pass
            # `notifications/initialized` returns None — JSON-RPC
            # notifications don't get a reply but the HTTP layer
            # needs something. Send 204 in that case.
            if response is None:
                self._send(204, "text/plain", b"")
                return
            self._send_json(200, response)

        def _do_update_apply(self):
            """Apply the pending dashboard update:

              1. Gracefully stop every live pty session (so claude
                 flushes its session JSONL — same path as the Stop
                 button).
              2. `git pull --ff-only` in REPO_DIR.
              3. Spawn `bin/agent-worktrees-restart` detached so the
                 helper SIGTERMs us and respawns a fresh server.

            Returns:
              202 + {ok, restarting} on success — the helper will
                kill us moments later, so we send the response
                BEFORE invoking it.
              409 + {error}            on a non-FF pull (or any pull
                failure) — nothing was restarted.
              412 + {error}            when the apply prereqs aren't
                met (no remote, not a repo, currently up-to-date,
                no work to do).
            """
            status = _updater.get_status()
            if not status.get("ok"):
                self._send_json(412, {
                    "error": status.get("error")
                             or "update status unknown; check first"})
                return
            if status.get("behind", 0) <= 0:
                self._send_json(412,
                    {"error": "already up to date"})
                return
            # 1. Graceful stop in parallel. session.close() is
            # already bounded (≤2s wait + SIGKILL), so a small
            # pool keeps the total wall-time near a single
            # session's worst case even when many are live.
            sessions = agentterm.iter_sessions()
            stopped: list[str] = []
            if sessions:
                threads = []
                for s in sessions:
                    th = threading.Thread(
                        target=s.close, daemon=True,
                        name=f"update-stop-{s.issue}")
                    th.start()
                    threads.append((th, s.issue))
                for th, issue in threads:
                    th.join(timeout=3.0)
                    stopped.append(issue)
                log_event("info", "updater",
                          "stopped agents for update",
                          agents=stopped)
            # 2. Pull. Refuse to restart on any pull failure so the
            # user can see the git error and fix it in their shell.
            pull = _updater.pull_latest(REPO_DIR)
            if not pull.get("ok"):
                log_event("error", "updater",
                          "pull failed", error=pull.get("error"))
                self._send_json(409, {
                    "error": pull.get("error") or "git pull failed",
                    "stdout": pull.get("stdout") or "",
                })
                return
            # 3. Refresh the cached status so a stray GET in flight
            # doesn't still show the old "behind > 0" badge.
            _updater.set_status(_updater.check_remote(REPO_DIR))
            log_event("info", "updater",
                      "pull succeeded, restarting",
                      stdout=pull.get("stdout", "")[:200])
            # 4. Spawn the restart helper detached and reply right
            # away. The helper will SIGTERM us after the brief delay
            # in its kill loop — by then our response is on the wire.
            restart_helper = REPO_DIR / "bin" / "agent-worktrees-restart"
            detach_kwargs: dict = {}
            if IS_WINDOWS:
                detach_kwargs["creationflags"] = \
                    subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                detach_kwargs["start_new_session"] = True
            try:
                subprocess.Popen(
                    [str(restart_helper),
                      "--port", str(self.server.server_address[1])],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    **detach_kwargs,
                )
            except OSError as ex:
                # Pull already landed; we're stuck on the new code
                # but didn't manage to respawn. Tell the user — a
                # manual restart will recover.
                self._send_json(500, {
                    "error": f"pull succeeded but restart failed: {ex}",
                    "pulled": True,
                })
                return
            self._send_json(202, {
                "ok": True, "restarting": True,
                "stopped_agents": stopped,
            })

        def _do_server_restart(self):
            """Restart the dashboard server without pulling new code.

            Mirrors `_do_update_apply` but skips the git pull and the
            up-to-date precheck — the user just wants a clean restart
            (e.g. to reload MCP config, or because something's stuck).

              1. Gracefully stop every live pty session.
              2. Spawn `bin/agent-worktrees-restart` detached so the
                 helper SIGTERMs us and respawns a fresh server.

            Returns 202 + {ok, restarting, stopped_agents} on success.
            """
            sessions = agentterm.iter_sessions()
            stopped: list[str] = []
            if sessions:
                threads = []
                for s in sessions:
                    th = threading.Thread(
                        target=s.close, daemon=True,
                        name=f"restart-stop-{s.issue}")
                    th.start()
                    threads.append((th, s.issue))
                for th, issue in threads:
                    th.join(timeout=3.0)
                    stopped.append(issue)
                log_event("info", "restart",
                          "stopped agents for restart",
                          agents=stopped)
            restart_helper = REPO_DIR / "bin" / "agent-worktrees-restart"
            detach_kwargs: dict = {}
            if IS_WINDOWS:
                detach_kwargs["creationflags"] = \
                    subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                detach_kwargs["start_new_session"] = True
            try:
                subprocess.Popen(
                    [str(restart_helper),
                      "--port", str(self.server.server_address[1])],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    **detach_kwargs,
                )
            except OSError as ex:
                self._send_json(500, {
                    "error": f"restart failed to spawn helper: {ex}",
                })
                return
            self._send_json(202, {
                "ok": True, "restarting": True,
                "stopped_agents": stopped,
            })

        def _do_primaries_clone(self):
            """Kick off a background clone of one primary repo into
            <primaries_root>/<repo>. Returns 202 Accepted immediately
            so the browser doesn't hold the connection open for the
            duration — the dashboard polls /api/primaries/status to
            track progress.

            Body: {"repo": "core", "url": "<optional override>"}. Uses
            the per-user clone-URL template by default. A second click
            while a clone is in flight returns the existing state
            instead of starting a duplicate.
            """
            body = self._read_json_body() or {}
            repo = (body.get("repo") or "").strip()
            url_override = (body.get("url") or "").strip()
            if not repo or not re.match(r"^[A-Za-z0-9._-]+$", repo):
                self._send_json(400, {
                    "error": "repo must match [A-Za-z0-9._-]+"})
                return
            target = primaries_root / repo
            if (target / ".git").exists():
                self._send_json(409, {
                    "error": f"{target} already exists",
                    "already_present": True,
                })
                return
            # Duplicate-click guard — return the in-flight entry rather
            # than launching a second clone over the same target.
            with _PRIMARIES_CLONE_LOCK:
                existing = _PRIMARIES_CLONE_STATES.get(repo)
                if existing and existing.get("state") == "cloning":
                    self._send_json(202, {**existing, "repo": repo})
                    return
            # Resolve clone URL — priority:
            #   1. explicit ?url= override (validated lightly)
            #   2. github-repos preference entry whose tail matches `repo`
            #   3. legacy {repo}-template preference
            if url_override:
                if not re.match(r"^(?:ssh|https?|git)://", url_override) \
                        and not re.match(r"^[^@\s]+@[^:\s]+:", url_override):
                    self._send_json(400, {
                        "error": "url must be ssh://, https://, http://, "
                                  "git://, or scp-style (user@host:path)"})
                    return
                url = url_override
            else:
                slug = _user_slug()
                gh_url = github_clone_url_for(slug, repo)
                if gh_url:
                    url = gh_url
                else:
                    conn = db_connect()
                    try:
                        tmpl = user_clone_url_template(conn, slug)
                    finally:
                        conn.close()
                    url = tmpl.replace("{repo}", repo) if tmpl else ""
                    if not url:
                        self._send_json(400, {
                            "error": f"no clone URL for {repo!r} — add "
                                      f"<owner>/{repo} to the github-repos "
                                      "preference or set a "
                                      "primaries-clone-url-template"})
                        return
            primaries_root.mkdir(parents=True, exist_ok=True)
            started = int(time.time())
            state = {
                "state": "cloning", "url": url,
                "target": str(target), "started_at": started,
            }
            with _PRIMARIES_CLONE_LOCK:
                _PRIMARIES_CLONE_STATES[repo] = state
            log_event("info", "primaries-clone", "starting",
                      repo=repo, url=url, target=str(target))
            # Shallow clone — depth 1000 covers most issue-branch
            # fork points (i.e., the dashboard's per-issue "Last
            # commits" tab keeps a meaningful merge-base) while
            # still pulling a fraction of the objects a full clone
            # would. `git fetch --unshallow` recovers full history
            # later for the rare case it's needed.
            #
            # Note: `--depth` implies `--single-branch`, so the resulting
            # `remote.origin.fetch` only tracks the default branch.
            # That's intentional here (keeps the clone small — for `core`
            # the multi-branch variant balloons to >10 GB), and
            # create_issue_worktrees widens the refspec on demand
            # before fetching the issue branch.
            def _run():
                """Stream `git clone --progress` and update the
                shared state with the current phase + percent so the
                dashboard's banner can render a live progress bar.

                git emits progress to stderr with \\r as the line
                terminator between updates (it rewrites itself in
                place on a TTY), so we read bytes and split on
                either \\r or \\n. We keep the last 40 stderr lines
                for the failure-case error message."""
                progress_re = re.compile(
                    rb"(Receiving objects|Resolving deltas|Updating files"
                    rb"|Counting objects|Compressing objects)"
                    rb":\s+(\d+)%")
                error: str | None = None
                returncode = -1
                tail: list[str] = []
                try:
                    proc = subprocess.Popen(
                        ["git", "clone", "--progress", "--depth", "1000",
                         url, str(target)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                        env=_git_clone_env(url),
                    )
                except (OSError, subprocess.SubprocessError) as ex:
                    error = f"{type(ex).__name__}: {ex}"
                else:
                    buf = b""
                    deadline = time.time() + 900   # safety ceiling
                    while True:
                        if time.time() > deadline:
                            proc.kill()
                            error = "timed out after 900s"
                            break
                        chunk = proc.stderr.read(256) if proc.stderr else b""
                        if not chunk:
                            if proc.poll() is not None:
                                break
                            time.sleep(0.05)
                            continue
                        buf += chunk
                        # Split on either CR or LF — git clone overwrites
                        # the same progress line with \r between updates.
                        while True:
                            m = re.search(rb"[\r\n]", buf)
                            if not m:
                                break
                            line_b = buf[:m.start()]
                            buf = buf[m.end():]
                            text = line_b.decode("utf-8", errors="replace").strip()
                            if not text:
                                continue
                            tail.append(text)
                            if len(tail) > 40:
                                tail.pop(0)
                            pm = progress_re.search(line_b)
                            if pm:
                                with _PRIMARIES_CLONE_LOCK:
                                    cur = _PRIMARIES_CLONE_STATES.get(repo)
                                    if cur and cur.get("state") == "cloning":
                                        cur["progress"] = {
                                            "phase": pm.group(1).decode(),
                                            "pct": int(pm.group(2)),
                                        }
                    if error is None:
                        returncode = proc.wait()
                        if returncode != 0:
                            error = ("\n".join(tail) or "").strip()[-500:]
                # Clean up the partial clone directory on failure.
                # `git clone` creates <target>/.git before receiving
                # objects, so a mid-clone failure (timeout, network
                # drop) leaves a corrupt repo on disk that
                # primary_repo_status() would still classify as
                # "present" — masking the failure and blocking a
                # retry (`git clone` refuses a non-empty target).
                if error is not None:
                    try:
                        if target.exists():
                            shutil.rmtree(target, ignore_errors=True)
                    except Exception:  # noqa: BLE001
                        pass
                with _PRIMARIES_CLONE_LOCK:
                    if error is None:
                        _PRIMARIES_CLONE_STATES[repo] = {
                            **state, "state": "done",
                            "progress": {"phase": "done", "pct": 100},
                            "finished_at": int(time.time()),
                        }
                    else:
                        _PRIMARIES_CLONE_STATES[repo] = {
                            **state, "state": "failed",
                            "error": error, "returncode": returncode,
                            "finished_at": int(time.time()),
                        }
                if error is None:
                    log_event("info", "primaries-clone", "done",
                              repo=repo, target=str(target))
                else:
                    log_event("error", "primaries-clone", "failed",
                              repo=repo, returncode=returncode,
                              error=error)
            threading.Thread(target=_run, daemon=True,
                              name=f"primaries-clone-{repo}").start()
            self._send_json(202, {**state, "repo": repo})

        def _do_reset_workspace(self):
            """Nuke every worktree under worktrees_root and truncate
            every SQLite table — a "clean slate" reset triggered from
            the dashboard's profile.

            The body must contain {"confirm": "<worktrees_root>"} — a
            literal echo of the path the client is about to wipe.
            Mismatch returns 400; that turns the endpoint from a
            single-button footgun into an explicit acknowledgement of
            *which* workspace is being reset (relevant when the
            primary + a demo run side-by-side).
            """
            body = self._read_json_body() or {}
            confirm = (body.get("confirm") or "").strip()
            if confirm != str(worktrees_root):
                self._send_json(400, {
                    "error": "confirm must equal the worktrees_root",
                    "expected": str(worktrees_root)})
                return

            removed_worktrees: list[str] = []
            errors: list[dict] = []

            # 1. `git worktree remove --force` for every worktree we can
            # discover. We resolve each worktree's primary by walking
            # primaries_root/<repo> and asking it for its worktree list,
            # so a stray issue dir without a matching primary still gets
            # rmtree'd later. Without `git worktree remove`, the primary
            # would keep stale `.git/worktrees/<id>/` entries and refuse
            # a future `git worktree add` at the same path.
            try:
                primaries_iter = list(primaries_root.iterdir()) \
                    if primaries_root.is_dir() else []
            except OSError:
                primaries_iter = []
            for primary in primaries_iter:
                if not (primary / ".git").exists():
                    continue
                try:
                    r = subprocess.run(
                        ["git", "-C", str(primary), "worktree", "list",
                         "--porcelain"],
                        capture_output=True, text=True, timeout=15,
                    )
                except (OSError, subprocess.SubprocessError) as ex:
                    errors.append({"step": "worktree-list",
                                   "primary": str(primary),
                                   "error": f"{type(ex).__name__}: {ex}"})
                    continue
                if r.returncode != 0:
                    continue
                wt_paths: list[str] = []
                for line in r.stdout.splitlines():
                    if line.startswith("worktree "):
                        path = line[len("worktree "):].strip()
                        if path and path != str(primary):
                            wt_paths.append(path)
                for path in wt_paths:
                    rm = subprocess.run(
                        ["git", "-C", str(primary), "worktree", "remove",
                         "--force", path],
                        capture_output=True, text=True, timeout=30,
                    )
                    if rm.returncode == 0:
                        removed_worktrees.append(path)
                    else:
                        errors.append({"step": "worktree-remove",
                                       "path": path,
                                       "error": rm.stderr.strip()[:300]})

            # 2. rm -rf every child of worktrees_root. Stray issue dirs
            # not backed by a primary (e.g. half-removed earlier) get
            # cleaned here.
            try:
                for child in worktrees_root.iterdir():
                    try:
                        shutil.rmtree(child, ignore_errors=True)
                    except Exception as ex:  # noqa: BLE001
                        errors.append({"step": "rmtree",
                                       "path": str(child),
                                       "error": str(ex)})
            except OSError as ex:
                errors.append({"step": "worktrees-iterdir",
                               "error": str(ex)})

            # 3. rm -rf every primary repo checkout under primaries_root.
            # The user explicitly wants a completely clean slate — next
            # startup will surface the "Missing primary repos" banner
            # with one-click clone buttons. We don't touch the
            # primaries_root dir itself (or any non-repo files in it),
            # only directories that look like a git checkout
            # (<dir>/.git exists).
            removed_primaries: list[str] = []
            if primaries_root and primaries_root.is_dir() \
                    and primaries_root != worktrees_root:
                try:
                    for child in primaries_root.iterdir():
                        if not child.is_dir():
                            continue
                        if not (child / ".git").exists():
                            continue
                        # Don't accidentally delete the worktrees root
                        # if it lives inside primaries_root.
                        try:
                            if child.resolve() == worktrees_root.resolve():
                                continue
                        except OSError:
                            continue
                        try:
                            shutil.rmtree(child, ignore_errors=True)
                            removed_primaries.append(str(child))
                        except Exception as ex:  # noqa: BLE001
                            errors.append({"step": "rmtree-primary",
                                           "path": str(child),
                                           "error": str(ex)})
                except OSError as ex:
                    errors.append({"step": "primaries-iterdir",
                                   "error": str(ex)})

            # 4. Truncate every user-data table in the activity DB.
            # Keep the schema + meta migration markers intact so the
            # server doesn't try to re-migrate on next startup.
            user_tables = [
                "agent_events", "agent_tokens", "commits", "notes",
                "worktrees", "week_summaries", "backup_history",
                "preferences",
            ]
            db_rows: dict[str, int] = {}
            try:
                conn = db_connect()
                try:
                    for tbl in user_tables:
                        try:
                            cur = conn.execute(f"DELETE FROM {tbl}")
                            db_rows[tbl] = cur.rowcount
                        except sqlite3.OperationalError:
                            # Table may not exist on older schemas — skip.
                            db_rows[tbl] = 0
                    conn.commit()
                finally:
                    conn.close()
            except Exception as ex:  # noqa: BLE001
                errors.append({"step": "db-truncate",
                               "error": str(ex)})

            log_event("warn", "admin",
                      "workspace reset",
                      worktrees_root=str(worktrees_root),
                      removed_wt=len(removed_worktrees),
                      removed_primaries=len(removed_primaries),
                      errors=len(errors))
            self._send_json(200, {
                "ok": not errors,
                "removed_worktrees": removed_worktrees,
                "removed_primaries": removed_primaries,
                "db_rows_deleted": db_rows,
                "errors": errors,
            })

        def _do_create_issue(self):
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            base = (body.get("base_branch") or "main").strip()
            # Default repos come from the user's expected-repos
            # preference (the same list that drives the missing-repo
            # placeholders + the dashboard's "+ Add issue" dialog).
            if body.get("repos"):
                requested = body.get("repos")
            else:
                try:
                    conn = db_connect()
                    try:
                        requested = user_expected_repos(conn, _user_slug())
                    finally:
                        conn.close()
                except Exception:  # noqa: BLE001
                    requested = list(EXPECTED_REPOS)
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            if not re.match(r"^[A-Za-z0-9._/-]+$", issue):
                self._send_json(400, {
                    "error": "issue must match [A-Za-z0-9._/-]+"})
                return
            if not isinstance(requested, list) or not requested:
                self._send_json(400, {"error": "repos must be a non-empty list"})
                return
            # Sanitise repo list — only allow the well-known set so we
            # don't end up trying to materialise something like '../../etc'.
            safe_repos = [r for r in requested
                          if isinstance(r, str)
                             and re.match(r"^[A-Za-z0-9._-]+$", r)]
            if not safe_repos:
                self._send_json(400, {"error": "no valid repos in request"})
                return
            results = create_issue_worktrees(
                worktrees_root, primaries_root, issue, base, safe_repos)
            ok = all(r["ok"] for r in results)
            self._send_json(200 if ok else 207, {
                "issue": issue,
                "base_branch": base,
                "repos": safe_repos,
                "results": results,
            })

        def _do_restore_sqlite(self):
            """Replace ~/.cache/agent-workspace/activity.sqlite with an
            uploaded backup file, then re-exec the server so every code
            path picks up the new DB cleanly.

            Body is the raw .sqlite bytes (Content-Type:
            application/octet-stream). Validation pipeline:
              1. Length must fit in 200 MB.
              2. First 16 bytes must equal b"SQLite format 3\\x00".
              3. The file must open and pass `PRAGMA integrity_check`.
            On success the current DB is preserved at
            `activity.sqlite.pre-restore-<timestamp>` and the new file
            is atomically swapped in. The response includes per-table
            counts so the UI can confirm the new state, plus a
            `restarting` flag — the server `os.execv`'s itself ~700 ms
            after sending the response.
            """
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                self._send_json(400, {"error": "Content-Length required"})
                return
            if length > 200 * 1024 * 1024:
                self._send_json(413,
                                {"error": "backup too large (200 MB max)"})
                return
            try:
                body = self.rfile.read(length)
            except OSError as ex:
                self._send_json(400, {"error": f"read failed: {ex}"})
                return
            if not body.startswith(b"SQLite format 3\x00"):
                self._send_json(400, {
                    "error": "not a SQLite file (magic header mismatch)"})
                return

            DEFAULT_CACHE.mkdir(parents=True, exist_ok=True)
            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                        dir=str(DEFAULT_CACHE), prefix="restore-",
                        suffix=".sqlite", delete=False) as tf:
                    tf.write(body)
                    tmp_path = Path(tf.name)

                # Open + integrity check before we replace anything.
                try:
                    test = sqlite3.connect(str(tmp_path))
                    try:
                        row = test.execute(
                            "PRAGMA integrity_check").fetchone()
                        check = row[0] if row else "?"
                    finally:
                        test.close()
                except sqlite3.DatabaseError as ex:
                    self._send_json(400, {
                        "error": f"not a valid SQLite database: {ex}"})
                    return
                if check != "ok":
                    self._send_json(400, {
                        "error": f"integrity check failed: {check}"})
                    return

                # Safety copy of the current DB before swap.
                safety = ""
                if DB_PATH.exists():
                    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
                    safety_path = DB_PATH.with_name(
                        f"{DB_PATH.name}.pre-restore-{stamp}")
                    shutil.copy2(DB_PATH, safety_path)
                    safety = str(safety_path)

                # Atomic swap (POSIX rename semantics).
                tmp_path.replace(DB_PATH)
                tmp_path = None  # consumed

                # Per-table counts so the UI can confirm what landed.
                conn = sqlite3.connect(str(DB_PATH))
                try:
                    counts = {
                        "events": conn.execute(
                            "SELECT COUNT(*) FROM agent_events"
                        ).fetchone()[0],
                        "worktrees": conn.execute(
                            "SELECT COUNT(*) FROM worktrees"
                        ).fetchone()[0],
                        "commits": conn.execute(
                            "SELECT COUNT(*) FROM commits"
                        ).fetchone()[0],
                    }
                finally:
                    conn.close()
            except Exception as ex:  # noqa: BLE001
                log_event("error", "restore",
                          "sqlite restore failed", error=str(ex))
                self._send_json(500, {"error": f"restore failed: {ex}"})
                return
            finally:
                if tmp_path and tmp_path.exists():
                    try:
                        tmp_path.unlink()
                    except OSError:
                        pass

            log_event("info", "restore", "sqlite restored",
                      size=len(body), safety=safety, **counts)
            self._send_json(200, {
                "ok": True,
                "size_bytes": len(body),
                "safety_backup": safety,
                "counts": counts,
                "restarting": True,
            })
            # Schedule the self-restart AFTER the response is on the wire.
            schedule_self_restart(delay_seconds=0.7)

        def _do_remove_issue(self):
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            force = bool(body.get("force"))
            delete_branch = bool(body.get("delete_branch"))
            bypass_agent_check = bool(body.get("bypass_agent_check"))
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            if not re.match(r"^[A-Za-z0-9._/-]+$", issue):
                self._send_json(400, {
                    "error": "issue must match [A-Za-z0-9._/-]+"})
                return
            # Belt-and-braces: refuse by default to remove a worktree
            # that still has a live Claude agent attached, so a stale
            # dashboard tab + direct cURL can't yank the worktree out
            # from under a live session. The dashboard's confirm dialog
            # forwards `bypass_agent_check: true` after the user has
            # explicitly OK'd the "remove anyway" prompt, which lets
            # the request through.
            if not bypass_agent_check and issue in running_agent_issues():
                self._send_json(409, {
                    "error": (f"a Claude agent is still running for "
                              f"{issue} — exit it (Ctrl-D in the "
                              f"terminal tab) before removing the "
                              f"worktree, or send bypass_agent_check="
                              f"true to remove anyway."),
                    "agent_running": True,
                })
                return
            # Stop any live agent session before removing the worktree so
            # the process doesn't keep running (and posting notifications)
            # after its filesystem is gone.
            agentterm.stop_session(issue)
            results = remove_issue_worktrees(
                worktrees_root, primaries_root, issue,
                force=force, delete_branch=delete_branch)
            ok = all(r["ok"] for r in results)
            self._send_json(200 if ok else 207, {
                "issue": issue,
                "force": force,
                "delete_branch": delete_branch,
                "results": results,
            })

        def _do_post_note(self):
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            content = body.get("content") or ""
            status = (body.get("status") or "todo").strip()
            priority = (body.get("priority") or "normal").strip()
            tags = body.get("tags") or []
            due_at = body.get("due_at")
            assignee = body.get("assignee")
            sort_order = body.get("sort_order")
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            if not content.strip():
                self._send_json(400, {"error": "content is required"})
                return
            if status not in NOTE_STATUSES:
                self._send_json(400, {
                    "error": f"status must be one of {NOTE_STATUSES}"})
                return
            if priority not in NOTE_PRIORITIES:
                self._send_json(400, {
                    "error": f"priority must be one of {NOTE_PRIORITIES}"})
                return
            conn = db_connect()
            try:
                try:
                    note_id = insert_note(
                        conn, _user_slug(), issue, content, status,
                        tags=tags, due_at=due_at, priority=priority,
                        assignee=assignee, sort_order=sort_order)
                except ValueError as ex:
                    self._send_json(400, {"error": str(ex)})
                    return
                self._send_json(200, {"id": note_id})
            finally:
                conn.close()

        def _do_put_note(self, note_id: int):
            body = self._read_json_body() or {}
            # Build kwargs that distinguish "field not in body" from
            # "field explicitly set to null" — important for nullable
            # fields like due_at / assignee where the user may want to
            # clear the value rather than leave it alone.
            updates = {}
            for key in ("content", "status", "tags", "due_at",
                         "priority", "assignee", "sort_order"):
                if key in body:
                    updates[key] = body[key]
            conn = db_connect()
            try:
                try:
                    ok = update_note(conn, _user_slug(), note_id, **updates)
                except ValueError as ex:
                    self._send_json(400, {"error": str(ex)})
                    return
                if not ok:
                    self._send_json(404, {"error": "note not found"})
                    return
                self._send_json(200, {"updated": True})
            finally:
                conn.close()

        def _do_delete_note(self, note_id: int):
            conn = db_connect()
            try:
                ok = delete_note(conn, _user_slug(), note_id)
                self._send_json(200 if ok else 404, {"deleted": ok})
            finally:
                conn.close()

        def _do_delete_event(self, event_id: int):
            conn = db_connect()
            try:
                ok = delete_agent_event(conn, event_id)
                self._send_json(200 if ok else 404, {"deleted": ok})
            finally:
                conn.close()

        def do_DELETE(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            m = re.match(r"^/api/worklogs/(\d+)$", parsed.path)
            if m:
                conn = db_connect()
                try:
                    ok = delete_worklog(conn, int(m.group(1)))
                    if ok:
                        # Bust cache for any week that may have contained it.
                        # Cheap option: drop everything; regen on next access.
                        conn.execute("DELETE FROM week_summaries")
                        conn.commit()
                    self._send_json(200 if ok else 404, {"deleted": ok})
                finally:
                    conn.close()
                return
            m = re.match(r"^/api/notes/(\d+)$", parsed.path)
            if m:
                self._do_delete_note(int(m.group(1)))
                return
            m = re.match(r"^/api/events/(\d+)$", parsed.path)
            if m:
                self._do_delete_event(int(m.group(1)))
                return
            m = re.match(r"^/api/backup/history/(\d+)$", parsed.path)
            if m:
                conn = db_connect()
                try:
                    result = delete_backup_entry(conn, int(m.group(1)))
                finally:
                    conn.close()
                if result.get("ok"):
                    self._send_json(200, result)
                else:
                    # Distinguish "row not found" (404) from a refused
                    # / failed rm (500). The helper returns the error
                    # message; map known prefixes to the right status.
                    err = result.get("error") or ""
                    status = 404 if "no backup_history row" in err else 500
                    self._send_json(status, result)
                return
            if parsed.path == "/api/week-summary":
                week = (qs.get("week", [""])[0] or "").strip()
                if not re.match(r"^\d{4}-W\d{2}$", week):
                    self._send_json(400, {"error": "week must be 'YYYY-Www'"})
                    return
                conn = db_connect()
                try:
                    cur = conn.execute(
                        "DELETE FROM week_summaries WHERE week_id = ?", (week,))
                    conn.commit()
                    self._send_json(200, {"deleted": cur.rowcount > 0,
                                          "week_id": week})
                finally:
                    conn.close()
                return
            # Agent worklogs are computed and have no row id, so delete by
            # (issue, week) — the exclusion table makes it sticky.
            if parsed.path == "/api/worklogs/agent":
                issue = (qs.get("issue", [""])[0] or "").strip()
                week = (qs.get("week", [""])[0] or "").strip()
                conn = db_connect()
                try:
                    try:
                        added = exclude_agent_worklog(conn, issue, week)
                    except ValueError as ex:
                        self._send_json(400, {"error": str(ex)})
                        return
                    conn.execute("DELETE FROM week_summaries WHERE week_id = ?", (week,))
                    conn.commit()
                    self._send_json(200, {"excluded": True, "newly_added": added})
                finally:
                    conn.close()
                return
            self._send(404, "text/plain", b"Not found")

        def _read_json_body(self) -> dict | None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            if not raw:
                return {}
            try:
                return json.loads(raw.decode())
            except (UnicodeDecodeError, ValueError):
                return None

        def _do_add_worklog(self):
            body = self._read_json_body()
            if body is None:
                self._send_json(400, {"error": "body must be JSON"})
                return
            try:
                issue = body.get("issue") or ""
                minutes = int(body.get("minutes") or 0)
                date_local = body.get("date_local")
                comment = body.get("comment") or ""
            except (TypeError, ValueError):
                self._send_json(400, {"error": "invalid fields"})
                return
            conn = db_connect()
            try:
                try:
                    log = add_worklog(conn, issue=issue, minutes=minutes,
                                      date_local=date_local, comment=comment,
                                      source="manual")
                except ValueError as ex:
                    self._send_json(400, {"error": str(ex)})
                    return
                invalidate_week_summary_for_date(conn, log["date_local"])
                self._send_json(200, log)
            finally:
                conn.close()

        def _do_timer_start(self):
            body = self._read_json_body() or {}
            issue = (body.get("issue") or "").strip()
            comment = body.get("comment") or ""
            if not issue:
                self._send_json(400, {"error": "issue is required"})
                return
            conn = db_connect()
            try:
                t = start_timer(conn, issue=issue, comment=comment)
                self._send_json(200, {"timer": t})
            finally:
                conn.close()

        def _do_timer_stop(self):
            body = self._read_json_body() or {}
            comment = body.get("comment") or ""
            conn = db_connect()
            try:
                log = finalize_timer(conn, comment=comment)
                if log is None:
                    self._send_json(409, {"error": "no timer running"})
                    return
                invalidate_week_summary_for_date(conn, log["date_local"])
                self._send_json(200, {"worklog": log})
            finally:
                conn.close()

        def _do_timer_comment(self):
            body = self._read_json_body() or {}
            comment = body.get("comment") or ""
            conn = db_connect()
            try:
                t = update_timer_comment(conn, comment)
                if t is None:
                    self._send_json(409, {"error": "no timer running"})
                    return
                self._send_json(200, {"timer": t})
            finally:
                conn.close()

        def _do_open_file(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                body = json.loads(raw.decode() or "{}")
            except (UnicodeDecodeError, ValueError):
                self._send_json(400, {"error": "body must be JSON"})
                return
            wt = body.get("worktree") or ""
            rel = body.get("path") or ""
            editor = body.get("editor") or ""
            if not (wt and rel and editor):
                self._send_json(400,
                    {"error": "worktree, path, and editor are required"})
                return
            status, payload = open_file_in_editor(
                wt, rel, editor, worktrees_root)
            self._send_json(status, payload)

        def _do_sync_toggle(self, want: str):
            """Flip the auto-sync ON/OFF flag. `want` ∈ {'1','true','on',
            '0','false','off','toggle'}. Persists to DB so the choice
            survives a server restart."""
            with _SYNC_LOCK:
                if not _SYNC_STATUS.get("thread_running"):
                    self._send_json(409, {"error": "sync thread is disabled (--no-sync)"})
                    return
                current = _SYNC_STATUS.get("enabled", False)
                if want in ("1", "true", "on"):
                    new_val = True
                elif want in ("0", "false", "off"):
                    new_val = False
                else:
                    new_val = not current
                _SYNC_STATUS["enabled"] = new_val
            try:
                conn = db_connect()
                try:
                    db_set_meta(conn, "auto_sync_enabled", "1" if new_val else "0")
                    conn.commit()
                finally:
                    conn.close()
            except Exception as ex:  # noqa: BLE001
                log_event("error", "sync-toggle",
                          "persist failed", error=str(ex))
            self._send_json(200, {"enabled": new_val})

        def _do_sync_now(self):
            """Run one auto_sync_tick + materialize pass synchronously and
            return the result. Used by the dashboard's "Sync now" button."""
            try:
                result = auto_sync_tick()
                if result.get("pulled"):
                    try:
                        created = materialize_missing_worktrees(
                            worktrees_root, primaries_root=None)
                        if created:
                            result["materialized"] = created
                    except Exception as ex:  # noqa: BLE001
                        result["errors"].append(f"materialize: {ex}")
                self._send_json(200, result)
            except Exception as ex:  # noqa: BLE001
                self._send_json(500, {"errors": [str(ex)]})

        def _do_set_cleanup_config(self):
            """Body shape: {"enabled": bool?, "retain_months": int?}.
            Persists to `meta`. Returns the effective config."""
            body = self._read_json_body() or {}
            conn = db_connect()
            try:
                if "enabled" in body:
                    db_set_meta(conn, "cleanup_enabled",
                                 "1" if bool(body["enabled"]) else "0")
                if "retain_months" in body:
                    try:
                        m = int(body["retain_months"])
                    except (TypeError, ValueError):
                        self._send_json(400, {
                            "error": "retain_months must be an integer"})
                        return
                    m = max(1, min(120, m))
                    db_set_meta(conn, "cleanup_retain_months", str(m))
                conn.commit()
                cfg = _cleanup_config(conn)
            finally:
                conn.close()
            self._send_json(200, cfg)

        def _do_cleanup_now(self):
            """Run one cleanup tick synchronously and return the summary."""
            result = run_cleanup_now()
            if "error" in result and len(result) == 1:
                self._send_json(500, result)
                return
            self._send_json(200, result)

        def _scan_throttled(self):
            """Open a short-lived DB connection and run the throttled scans
            (commits + agent token totals). Both have their own throttle
            timestamp in the meta table, so calling per-request is cheap."""
            try:
                conn = db_connect()
                try:
                    scan_commits(worktrees_root, conn)
                    scan_agent_tokens(worktrees_root, conn)
                finally:
                    conn.close()
            except Exception as ex:  # noqa: BLE001
                # Don't fail the request just because the scan blew up.
                log_event("error", "scan", "throttled scan failed",
                          error=str(ex))

        # Content types worth gzip-compressing. Binary formats (PNG, ICO,
        # already-compressed PDF/zip) are skipped — they'd grow.
        _GZIP_TYPES = (
            "text/", "application/javascript", "application/json",
            "application/manifest+json", "image/svg+xml",
        )
        _GZIP_MIN_BYTES = 256

        def _send(self, code: int, ctype: str, body: bytes):
            _record_request(code)
            # Gzip if the client asked for it AND the payload is text-y
            # AND it's big enough to be worth it. Saves ~70% on the
            # static JS/CSS bundles.
            encoded_body = body
            extra_headers: list[tuple[str, str]] = []
            accept = (self.headers.get("Accept-Encoding") or "").lower()
            if ("gzip" in accept and len(body) >= self._GZIP_MIN_BYTES
                    and any(ctype.startswith(t) for t in self._GZIP_TYPES)):
                try:
                    encoded_body = gzip.compress(body, compresslevel=6)
                    extra_headers.append(("Content-Encoding", "gzip"))
                    extra_headers.append(("Vary", "Accept-Encoding"))
                except OSError:
                    encoded_body = body  # fall back to plain
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(encoded_body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in extra_headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(encoded_body)

        def _send_json(self, code: int, obj):
            self._send(code, "application/json", json.dumps(obj).encode())

        def _serve_static(self, name: str):
            # Allow one level of subdirectory (e.g. xterm/xterm.js)
            # but reject anything with .., absolute paths, or hidden
            # entries. STATIC_DIR.resolve() containment check below
            # is the real safety net — the prefix filtering is just
            # to fail fast on obviously-bad inputs.
            if name.startswith(("/", ".")) or ".." in name.split("/"):
                self._send(404, "text/plain", b"Not found")
                return
            f = STATIC_DIR / name
            try:
                f = f.resolve(strict=False)
                static_root = STATIC_DIR.resolve(strict=False)
                # Ensure the resolved path stays inside STATIC_DIR.
                f.relative_to(static_root)
            except (OSError, ValueError):
                self._send(404, "text/plain", b"Not found")
                return
            if not f.is_file():
                self._send(404, "text/plain", b"Not found")
                return
            ctype = {
                ".css":  "text/css; charset=utf-8",
                ".js":   "application/javascript; charset=utf-8",
                ".html": "text/html; charset=utf-8",
                ".svg":  "image/svg+xml",
                ".ico":  "image/x-icon",
                ".json": "application/manifest+json",
                ".md":   "text/markdown; charset=utf-8",
            }.get(f.suffix, "application/octet-stream")
            self._send(200, ctype, f.read_bytes())

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-workspace",
                                     description="Local dashboard server for ~/github/worktrees")
    parser.add_argument("--worktrees", type=Path, default=DEFAULT_WORKTREES,
                        help="Path to the worktrees root (default: ~/github/worktrees)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help=f"HTTP port (default: {DEFAULT_PORT})")
    parser.add_argument("--bind", default="127.0.0.1",
                        help="Address to bind on (default: 127.0.0.1; use 0.0.0.0 in Docker)")
    parser.add_argument("--behind", type=int, default=DEFAULT_BEHIND_LIMIT,
                        help=f"Warn when a branch is >N commits behind (default: {DEFAULT_BEHIND_LIMIT})")
    parser.add_argument("--no-open", action="store_true",
                        help="Don't open a browser tab")
    parser.add_argument("--sync-interval", type=int, default=DEFAULT_SYNC_INTERVAL,
                        help=f"Auto-sync interval in seconds when ON. "
                             f"Default: {DEFAULT_SYNC_INTERVAL} (3h, ~8 ticks/day).")
    parser.add_argument("--auto-sync", action="store_true",
                        help="Start with auto-sync ON. Default is OFF; toggle in the dashboard.")
    parser.add_argument("--no-sync", action="store_true",
                        help="Don't even start the background sync thread (no manual sync either).")
    parser.add_argument("--primaries", type=Path, default=None,
                        help="Root holding the primary repo checkouts (defaults to "
                             "<worktrees>/.. — e.g. ~/git when --worktrees=~/github/worktrees). "
                             "Used to materialize missing worktrees via `git worktree add`.")
    parser.add_argument("--no-materialize", action="store_true",
                        help="Don't auto-create local worktrees that appear in your "
                             "data/<user>/worktrees.json after a sync pull. Existing "
                             "worktrees are never touched regardless.")
    parser.add_argument("--no-hydrate", action="store_true",
                        help="Skip importing data/*/commits.jsonl + worktrees.json into "
                             "the SQLite cache on startup. Useful for an isolated test "
                             "instance — combine with --port N + --worktrees /empty/path "
                             "for a fully blank dashboard.")
    parser.add_argument("--no-backup", action="store_true",
                        help="Don't start the scheduled-backup thread. Backups are still "
                             "available via the Backup tab's 'Run backup now' button.")
    args = parser.parse_args(argv)

    # Per-port SQLite cache so two instances on different ports don't
    # trample each other's activity DB. The default port keeps the
    # legacy `activity.sqlite` filename so existing data is preserved
    # without a migration; non-default ports get `activity.<port>.sqlite`.
    if args.port != DEFAULT_PORT:
        global DB_PATH
        DB_PATH = DEFAULT_CACHE / f"activity.{args.port}.sqlite"
        print(f"using per-port DB: {DB_PATH}")

    # Install the stderr tee + record start time so /api/logs and /api/stats
    # have data to serve. Done before any other startup work so hydrate /
    # materialize warnings are captured into the ring too.
    global _SERVER_START_TS
    _SERVER_START_TS = time.time()
    if not isinstance(sys.stderr, _StderrTee):
        sys.stderr = _StderrTee(sys.stderr)

    if not args.worktrees.is_dir():
        log_event("error", "startup",
                  "worktrees path does not exist",
                  path=str(args.worktrees))
        return 1

    # Hydrate SQLite from data/*.jsonl on startup so a freshly-cloned repo
    # is functional immediately (heatmap + ghost worktrees). Skipped with
    # --no-hydrate for an isolated test instance.
    try:
        conn = db_connect()
        try:
            if args.no_hydrate:
                print("skipping data/ hydration (--no-hydrate)")
                summary = {"commits_imported": 0, "worktrees_imported": 0}
            else:
                summary = import_data(conn)
            if summary["commits_imported"] or summary["worktrees_imported"]:
                print(f"hydrated from data/: {summary}")
            # One-time migration: the previous scan_commits walked all of
            # HEAD's reachable history, which on long-lived branches that
            # share master's object store flooded the heatmap with a year
            # of released commits. The new filter excludes commits also
            # reachable from origin/master and any v<n>.<n>... release
            # ref, so commits in the DB from before this change need to
            # be re-built. Clear once, then let the next scan repopulate.
            if not db_get_meta(conn, "commits_release_filter_v1"):
                conn.execute("DELETE FROM commits")
                conn.execute("DELETE FROM meta WHERE key = 'last_scan_at'")
                db_set_meta(conn, "commits_release_filter_v1", "1")
                conn.commit()
                print("cleared commits table for one-time release-filter migration")
            # Clean up any future-week summary rows that were generated
            # before the "no walking into the future" guard. Empty future
            # weeks just clutter the list view.
            cur = conn.execute(
                "DELETE FROM week_summaries WHERE week_id > ?",
                (iso_week_id(),),
            )
            if cur.rowcount:
                conn.commit()
                print(f"removed {cur.rowcount} future-week summary row(s)")
            # Backfill week summaries for the last 4 weeks if missing.
            try:
                generated = autofill_week_summaries(conn)
                if generated:
                    print(f"generated week summaries: {generated}")
            except Exception as ex:  # noqa: BLE001
                log_event("warn", "week-summary",
                          "autofill failed", error=str(ex))
        finally:
            conn.close()
    except Exception as ex:  # noqa: BLE001
        log_event("warn", "startup", "hydrate failed", error=str(ex))

    # Salvage broken primary clones — directories left behind when a
    # `git clone` subprocess was orphaned by a parent-server restart
    # mid-receive, or otherwise crashed before HEAD was written.
    # Without this, the next /api/primaries/status call would report
    # the corrupt checkout as "present", masking the failure and
    # blocking a retry (`git clone` refuses a non-empty target).
    primaries_root_resolved = args.primaries or args.worktrees.parent
    if primaries_root_resolved and primaries_root_resolved.is_dir():
        try:
            conn = db_connect()
            try:
                expected_primaries = user_expected_repos(conn, _user_slug())
            finally:
                conn.close()
            salvaged = salvage_broken_primary_clones(
                primaries_root_resolved, expected_primaries)
            for name in salvaged:
                log_event("warn", "primaries",
                          "salvaged broken clone",
                          repo=name,
                          target=str(primaries_root_resolved / name))
                print(f"salvaged broken primary clone: {name}")
        except Exception as ex:  # noqa: BLE001
            log_event("warn", "primaries",
                      "salvage scan failed", error=str(ex))

    # On startup, materialize any of MY worktrees missing from disk — but
    # never touch existing ones. Skipped on --no-materialize.
    if not args.no_materialize:
        try:
            results = materialize_missing_worktrees(args.worktrees, args.primaries)
            for r in results:
                tag = "✓" if r["ok"] else "✗"
                print(f"  {tag} {r['issue']}/{r['repo']}: {r['action']} — {r['message']}")
        except Exception as ex:  # noqa: BLE001
            log_event("warn", "materialize",
                      "materialize failed", error=str(ex))

    # Hydrate sync status from DB so a restart preserves both the
    # banner timestamp and the user's auto-sync ON/OFF preference.
    persisted_enabled = None
    try:
        conn = db_connect()
        try:
            ts = db_get_meta(conn, "last_sync_at_ts")
            ok = db_get_meta(conn, "last_sync_ok")
            if ts:
                with _SYNC_LOCK:
                    try:
                        _SYNC_STATUS["last_ts"] = float(ts)
                    except ValueError:
                        pass
                    if ok is not None:
                        _SYNC_STATUS["last_ok"] = (ok == "1")
            saved = db_get_meta(conn, "auto_sync_enabled")
            if saved is not None:
                persisted_enabled = (saved == "1")
        finally:
            conn.close()
    except Exception as ex:  # noqa: BLE001
        log_event("warn", "sync",
                  "sync-status hydrate failed", error=str(ex))

    # Wire the GitHub integration from the user's stored preferences.
    # Token comes from $GITHUB_TOKEN or ~/.config/agent-workspace/github-token.
    _refresh_github_config()

    # Decide initial enabled state. Precedence: CLI --auto-sync flag wins,
    # then DB-persisted preference, then default OFF.
    if args.auto_sync:
        initial_enabled = True
    elif persisted_enabled is not None:
        initial_enabled = persisted_enabled
    else:
        initial_enabled = False

    # Sync thread always runs (when not --no-sync) so the toggle can flip
    # at runtime without restarting. The loop checks the enabled flag at
    # each tick.
    sync_interval = max(60, args.sync_interval)  # never below 60s
    with _SYNC_LOCK:
        _SYNC_STATUS["enabled"] = (initial_enabled and not args.no_sync)
        _SYNC_STATUS["interval"] = sync_interval
        _SYNC_STATUS["thread_running"] = not args.no_sync
    if not args.no_sync:
        threading.Thread(
            target=auto_sync_loop,
            args=(sync_interval, args.worktrees, args.primaries, not args.no_materialize),
            daemon=True, name="auto-sync",
        ).start()
        state = "ON" if _SYNC_STATUS["enabled"] else "OFF (toggle in dashboard)"
        print(f"auto-sync thread started, interval={sync_interval}s, currently {state}")
    else:
        print("auto-sync thread disabled (--no-sync)")

    # Mailbox auto-poll thread. Always runs; the `mailbox-auto-poll`
    # pref (default OFF) gates whether each tick actually does any
    # work, so toggling from the dashboard takes effect immediately.
    threading.Thread(
        target=mailbox_auto_poll_loop,
        daemon=True, name="mailbox-auto-poll",
    ).start()

    # Auto-update checker. Polls the dashboard repo's origin every
    # UPDATE_CHECK_INTERVAL seconds; the `auto-update-check` pref
    # (default ON) gates each tick. The first tick runs immediately
    # on launch so the banner is informative right after a restart.
    threading.Thread(
        target=updater_loop,
        daemon=True, name="updater",
    ).start()

    # Scheduled-backup thread. Always runs (unless --no-backup); the
    # enabled flag is read from preferences on each tick so the user
    # can toggle it from the Backup tab without restarting the server.
    if not args.no_backup:
        def _get_backup_settings_for_loop(c):
            return get_backup_settings(c, _user_slug())
        threading.Thread(
            target=_backup_loop,
            kwargs={
                "db_connect": db_connect,
                "db_path": DB_PATH,
                "worktrees_root": args.worktrees,
                "get_settings": _get_backup_settings_for_loop,
                "log_event": log_event,
            },
            daemon=True, name="backup",
        ).start()
        print("backup thread started "
              f"(default dir: {DEFAULT_BACKUP_DIR}, "
              f"default interval: {DEFAULT_BACKUP_INTERVAL_DAYS}d)")
    else:
        print("backup thread disabled (--no-backup)")

    # Old-data cleanup thread. Always runs — the toggle is read on each
    # tick from the meta table so it can be flipped without restart.
    threading.Thread(
        target=cleanup_loop, daemon=True, name="cleanup",
    ).start()
    try:
        conn = db_connect()
        try:
            _cleanup_status_init = _cleanup_config(conn)
        finally:
            conn.close()
        print(f"cleanup thread started, enabled={_cleanup_status_init['enabled']}, "
              f"retain_months={_cleanup_status_init['retain_months']}")
    except Exception:  # noqa: BLE001
        pass

    # Subclass that downgrades client-disconnect errors. Default
    # ThreadingHTTPServer.handle_error prints the full traceback to stderr;
    # for BrokenPipe / ConnectionReset that just means "client closed the
    # connection" (browser refresh, tab close, auto-refresh racing an
    # in-flight request). Replace the noisy traceback with a single info
    # line — push it directly into the ring with explicit level so the
    # heuristic doesn't reclassify it as 'error' on the word "BrokenPipe".
    class _QuietServer(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            exc = sys.exc_info()[1]
            if isinstance(exc, (BrokenPipeError, ConnectionResetError,
                                ConnectionAbortedError)):
                stamp = datetime.now().strftime("%d/%b/%Y %H:%M:%S")
                # Drop the "Error" suffix from the exception type name to
                # avoid confusing the level heuristic in the rare path
                # where this line goes through the tee.
                short = type(exc).__name__.removesuffix("Error")
                line = (f"[{stamp}] client {client_address[0]}:"
                        f"{client_address[1]} disconnected mid-response "
                        f"({short})")
                stream = (sys.stderr.original
                          if isinstance(sys.stderr, _StderrTee)
                          else sys.stderr)
                stream.write(line + "\n")
                _LOG_RING.append(line, level="info")
                return
            super().handle_error(request, client_address)

    server = _QuietServer((args.bind, args.port),
                          make_handler(args.worktrees, args.behind,
                                        primaries_root=args.primaries))
    # Pidfile is written *after* a successful bind so a failed second
    # start (EADDRINUSE) can't clobber a good pidfile. Removed on exit
    # only if it still points at us — prevents racing a fresh restart.
    pidfile_path = DEFAULT_CACHE / f"server.{args.port}.pid"
    try:
        DEFAULT_CACHE.mkdir(parents=True, exist_ok=True)
        pidfile_path.write_text(f"{os.getpid()}\n")
    except OSError as ex:
        print(f"warning: could not write pidfile {pidfile_path}: {ex}",
              file=sys.stderr)
        pidfile_path = None

    def _remove_pidfile_if_ours() -> None:
        if pidfile_path is None:
            return
        try:
            if pidfile_path.is_file():
                current = pidfile_path.read_text().strip()
                if current == str(os.getpid()):
                    pidfile_path.unlink()
        except OSError:
            pass

    atexit.register(_remove_pidfile_if_ours)
    # SIGTERM (sent by the GNOME extension's Stop button, systemd, etc.)
    # raises KeyboardInterrupt so the existing shutdown path + atexit
    # hooks fire and the pidfile gets removed cleanly.
    def _on_sigterm(_signum, _frame) -> None:
        raise KeyboardInterrupt
    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):
        pass

    visible_host = "127.0.0.1" if args.bind == "0.0.0.0" else args.bind
    url = f"http://{visible_host}:{args.port}/"
    print(f"agent-workspace listening on {url} (bind={args.bind})")
    print(f"  worktrees: {args.worktrees}")
    print("  press Ctrl-C to stop.")

    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down.")
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
