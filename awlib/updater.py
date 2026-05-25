"""Auto-update plumbing for the dashboard repo.

The dashboard is a long-running local server checked out from a git
remote. This module is the read-side of the "is there a new version?"
question: a background thread in `agent_workspace.py` calls
`check_remote()` every ~10 min and stuffs the result into a module-
level `_STATUS` dict; the HTTP layer exposes it as JSON; the frontend
banner reads that JSON.

`pull_latest()` is the write-side, called from the apply route after
the user clicks Update. It runs `git pull --ff-only` — refusing to
merge anything non-trivial — and reports stdout/error back so the
frontend can surface a useful message when the pull fails.

Neither function raises. Failures (no remote, fetch denied, non-FF
divergence, …) come back as `ok=False` + populated `error` so the
loop / HTTP handler can log and move on without crashing.
"""
from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

# ── Thread-safe status cache ──────────────────────────────────────────────

# Shape mirrors what /api/update/status returns. Initialised to a
# clean "we haven't checked yet" state so the frontend's banner can
# tell the difference between "no update" and "never checked".
_STATUS: dict = {
    "ok": False,
    "checked_at": 0,
    "current_sha": "",
    "current_subject": "",
    "remote_sha": "",
    "remote_subject": "",
    "remote_date": "",
    "behind": 0,
    "branch": "",
    "error": None,
}
_LOCK = threading.Lock()


def get_status() -> dict:
    """Return a copy of the cached status — safe to expose over HTTP
    without giving the caller a handle to mutate our state."""
    with _LOCK:
        return dict(_STATUS)


def set_status(new: dict) -> None:
    """Replace the cached status atomically."""
    with _LOCK:
        _STATUS.clear()
        _STATUS.update(new)


# ── git helpers ───────────────────────────────────────────────────────────

def _git(cwd: Path, *args: str, timeout: float = 10.0
          ) -> tuple[int, str, str]:
    """Run `git <args>` in `cwd`. Returns (returncode, stdout, stderr).
    Never raises — OS / timeout failures collapse to rc=-1."""
    try:
        r = subprocess.run(
            ["git", *args], cwd=str(cwd),
            capture_output=True, text=True,
            timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as ex:
        return -1, "", f"{ex}"
    return r.returncode, r.stdout or "", r.stderr or ""


def _git_out(cwd: Path, *args: str, timeout: float = 10.0) -> str:
    """Convenience: just stdout if rc=0, else empty string."""
    rc, out, _ = _git(cwd, *args, timeout=timeout)
    return out if rc == 0 else ""


def _current_branch(repo_dir: Path) -> str:
    """The branch HEAD points at. Empty on detached HEAD or non-repo."""
    return _git_out(repo_dir, "symbolic-ref", "--short", "HEAD").strip()


# ── Public API ────────────────────────────────────────────────────────────

def check_remote(repo_dir: Path) -> dict:
    """Fetch `origin <branch>` and report how many commits HEAD is
    behind, plus the remote tip's subject/sha/date for the banner."""
    out: dict = {
        "ok": False,
        "checked_at": int(time.time()),
        "current_sha": "",
        "current_subject": "",
        "remote_sha": "",
        "remote_subject": "",
        "remote_date": "",
        "behind": 0,
        "branch": "",
        "error": None,
    }
    if not (repo_dir / ".git").exists():
        out["error"] = "not a git repository"
        return out
    branch = _current_branch(repo_dir)
    if not branch:
        out["error"] = "detached HEAD or no branch"
        return out
    out["branch"] = branch
    # Local HEAD metadata — cheap, never needs the network.
    head = _git_out(repo_dir, "log", "-1", "--format=%H%n%s", "HEAD")
    if head:
        parts = head.splitlines()
        out["current_sha"] = parts[0][:12] if parts else ""
        out["current_subject"] = parts[1] if len(parts) > 1 else ""
    # Fetch origin/<branch> — bounded timeout so a slow network can't
    # stall the dashboard's daemon thread for minutes.
    rc, _, ferr = _git(repo_dir, "fetch", "--quiet", "origin", branch,
                        timeout=30.0)
    if rc != 0:
        out["error"] = (ferr or "git fetch failed").strip()
        return out
    # Remote tip metadata + count.
    remote_ref = f"origin/{branch}"
    rinfo = _git_out(repo_dir, "log", "-1",
                      "--format=%H%n%s%n%cI", remote_ref)
    if rinfo:
        rp = rinfo.splitlines()
        out["remote_sha"] = rp[0][:12] if rp else ""
        out["remote_subject"] = rp[1] if len(rp) > 1 else ""
        out["remote_date"] = rp[2] if len(rp) > 2 else ""
    count = _git_out(repo_dir, "rev-list",
                      f"HEAD..{remote_ref}", "--count").strip()
    out["behind"] = int(count) if count.isdigit() else 0
    out["ok"] = True
    return out


def pull_latest(repo_dir: Path) -> dict:
    """`git pull --ff-only`. Returns {ok, stdout, error}. Non-FF
    divergence or any pull failure collapses to ok=False with a
    populated error — caller decides how to surface it.

    Local uncommitted changes (e.g. a hand-edited dashboard.js) are
    stashed before the pull and popped afterwards so they don't block
    a clean fast-forward. If the pop produces a conflict the pull is
    still reported as ok=True — the stash stays on the stack for
    manual resolution, and a warning is included in stdout."""
    out: dict = {"ok": False, "stdout": "", "error": None}
    if not (repo_dir / ".git").exists():
        out["error"] = "not a git repository"
        return out
    # Stash any local changes so they don't block the ff-only merge.
    rc_st, st_out, _ = _git(repo_dir, "stash", "push",
                             "-m", "auto-stash before dashboard update")
    stashed = rc_st == 0 and "No local changes to save" not in st_out
    # Pull.
    rc, stdout, stderr = _git(repo_dir, "pull", "--ff-only", timeout=60.0)
    out["stdout"] = stdout.strip()
    if rc != 0:
        if stashed:
            _git(repo_dir, "stash", "pop")
        out["error"] = (stderr or stdout
                        or f"git pull --ff-only exited {rc}").strip()
        return out
    # Re-apply local changes. Conflict → leave stash in place, warn.
    if stashed:
        rc_pop, pop_out, pop_err = _git(repo_dir, "stash", "pop")
        if rc_pop != 0:
            out["stdout"] += (
                "\nNote: local changes were stashed before the pull but "
                "could not be re-applied cleanly. Run `git stash pop` "
                "manually to resolve the conflict."
            )
    out["ok"] = True
    return out
