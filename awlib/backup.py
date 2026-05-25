"""Scheduled-backup helpers for agent-workspace.

A "backup" here is a timestamped directory containing:
  - activity.sqlite        — copy of the SQLite cache via the Online Backup API
  - manifest.json          — summary of what was captured
  - worktrees/             — one `<issue>-<repo>.bundle` per worktree that has
                             commits not reachable from its upstream

Bundles are produced with `git bundle create <path> <upstream>..HEAD` so they
contain only the un-pushed work — the bytes already on origin aren't
duplicated. Restore is `git fetch <bundle> HEAD:<branch>`.

The module never raises out of `run_backup_now`: failures land in the
returned dict and are also recorded in the `backup_history` SQLite table.
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
import subprocess
import time
from collections.abc import Callable
from pathlib import Path


def _git(repo_dir: Path, *args: str, timeout: int = 10) -> tuple[int, str, str]:
    """Run a git subcommand inside `repo_dir`. Returns (rc, stdout, stderr).
    Never raises — a timeout / OSError is reported via rc=-1."""
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_dir), *args],
            capture_output=True, text=True, check=False, timeout=timeout,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (OSError, subprocess.SubprocessError) as ex:
        return -1, "", f"{type(ex).__name__}: {ex}"


def _resolve_upstream(repo_dir: Path) -> str | None:
    """Pick a sensible ref to compare HEAD against when computing the
    "un-pushed" set. Tries the current branch's tracked upstream first,
    then `origin/HEAD`, then `origin/master` / `origin/main`. Returns
    None if nothing usable exists (e.g. detached HEAD on a brand-new
    repo with no remotes)."""
    rc, out, _ = _git(
        repo_dir, "rev-parse", "--abbrev-ref",
        "--symbolic-full-name", "@{u}", timeout=5)
    if rc == 0 and out:
        return out
    rc, out, _ = _git(
        repo_dir, "rev-parse", "--abbrev-ref", "origin/HEAD", timeout=5)
    if rc == 0 and out and out != "origin/HEAD":
        return out
    for cand in ("origin/master", "origin/main"):
        rc, _, _ = _git(repo_dir, "rev-parse", "--verify", cand, timeout=5)
        if rc == 0:
            return cand
    return None


def _bundle_worktree(repo_dir: Path, bundles_dir: Path,
                      issue: str, repo_name: str) -> dict:
    """Bundle un-pushed commits in one worktree. Returns a dict suitable
    for the per-worktree row in the manifest:
      {issue, repo, ok, bundled, commit_count?, size_bytes?, skipped?, error?}

    `bundled=False` with a `skipped` reason means the worktree was healthy
    but there was nothing to bundle. `ok=False` means the bundle attempt
    failed (and the manifest carries the error)."""
    bundle_path = bundles_dir / f"{issue}-{repo_name}.bundle"
    base = {"issue": issue, "repo": repo_name}
    upstream = _resolve_upstream(repo_dir)
    if not upstream:
        return {**base, "ok": True, "bundled": False,
                "skipped": "no upstream ref"}
    rc, out, err = _git(
        repo_dir, "rev-list", "--count", f"{upstream}..HEAD", timeout=10)
    if rc != 0:
        return {**base, "ok": False,
                "error": err or f"rev-list rc={rc}"}
    try:
        ahead = int(out or "0")
    except ValueError:
        ahead = 0
    if ahead == 0:
        return {**base, "ok": True, "bundled": False,
                "skipped": "no un-pushed commits"}

    bundles_dir.mkdir(parents=True, exist_ok=True)
    rc, _, err = _git(
        repo_dir, "bundle", "create", str(bundle_path),
        f"{upstream}..HEAD", timeout=60)
    if rc != 0:
        # Bundle may have been partially created — clean up.
        if bundle_path.exists():
            try:
                bundle_path.unlink()
            except OSError:
                pass
        return {**base, "ok": False, "error": err[:300]}

    size = bundle_path.stat().st_size if bundle_path.exists() else 0
    return {**base, "ok": True, "bundled": True,
            "commit_count": ahead, "size_bytes": size,
            "upstream": upstream}


def _walk_worktrees(worktrees_root: Path):
    """Yield (issue_name, repo_name, repo_path) for every directory in
    `worktrees_root/<issue>/<repo>/` that looks like a git worktree.
    `.git` may be either a directory (regular repo) or a file (worktree
    pointer), so we accept both."""
    if not worktrees_root.is_dir():
        return
    for issue_dir in sorted(worktrees_root.iterdir()):
        if not issue_dir.is_dir():
            continue
        for repo_dir in sorted(issue_dir.iterdir()):
            if not repo_dir.is_dir():
                continue
            git_marker = repo_dir / ".git"
            if not git_marker.exists():
                continue
            yield issue_dir.name, repo_dir.name, repo_dir


def run_backup_now(db_conn: sqlite3.Connection,
                    db_path: Path,
                    dest_root: Path,
                    worktrees_root: Path) -> dict:
    """Create a new timestamped backup at `dest_root/<stamp>/`. Returns a
    summary dict and always records an entry in the `backup_history`
    table — even on partial failure, so the user can see what went wrong
    from the dashboard.

    The SQLite copy uses `Connection.backup(dst)` (the Online Backup
    API) so the file is consistent even if a writer is mid-transaction.
    """
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = Path(dest_root) / stamp
    error: str | None = None
    db_size = 0
    bundle_count = 0
    details: dict = {"worktrees": [], "stamp": stamp}

    try:
        backup_dir.mkdir(parents=True, exist_ok=True)

        # 1. SQLite snapshot via Online Backup API. Open a *new* read
        # connection to the live DB rather than re-using db_conn, so
        # we don't disturb the caller's transaction state.
        db_dest = backup_dir / "activity.sqlite"
        src = sqlite3.connect(str(db_path))
        try:
            dst = sqlite3.connect(str(db_dest))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        db_size = db_dest.stat().st_size

        # 2. Per-worktree un-pushed-commit bundles.
        bundles_dir = backup_dir / "worktrees"
        for issue, repo_name, repo_dir in _walk_worktrees(Path(worktrees_root)):
            row = _bundle_worktree(repo_dir, bundles_dir, issue, repo_name)
            details["worktrees"].append(row)
            if row.get("ok") and row.get("bundled"):
                bundle_count += 1

        # 3. Manifest. Human-readable record of what's in the dir.
        (backup_dir / "manifest.json").write_text(
            json.dumps({"created_at": int(time.time()),
                        "db_size_bytes": db_size,
                        "bundle_count": bundle_count,
                        "worktrees": details["worktrees"]},
                        indent=2, ensure_ascii=False),
            encoding="utf-8")

    except Exception as ex:  # noqa: BLE001 — always record what we got
        error = f"{type(ex).__name__}: {ex}"

    total_size = 0
    if backup_dir.exists():
        for p in backup_dir.rglob("*"):
            if p.is_file():
                try:
                    total_size += p.stat().st_size
                except OSError:
                    pass

    ok = error is None
    db_conn.execute(
        "INSERT INTO backup_history "
        "(created_at, path, ok, error, db_size_bytes, bundle_count, "
        " total_size_bytes, details) VALUES (?,?,?,?,?,?,?,?)",
        (int(time.time()), str(backup_dir), 1 if ok else 0, error,
         db_size, bundle_count, total_size,
         json.dumps(details, ensure_ascii=False)),
    )
    db_conn.commit()

    return {
        "ok": ok,
        "path": str(backup_dir),
        "db_size_bytes": db_size,
        "bundle_count": bundle_count,
        "total_size_bytes": total_size,
        "error": error,
        "details": details,
    }


def prune_backups(dest_root: Path, retention: int) -> list[str]:
    """Keep only the `retention` most-recent timestamped subdirs under
    `dest_root`. Returns the list of deleted paths."""
    deleted: list[str] = []
    root = Path(dest_root)
    if not root.is_dir() or retention <= 0:
        return deleted
    entries = sorted(
        [p for p in root.iterdir() if p.is_dir()],
        key=lambda p: p.name, reverse=True)
    for old in entries[retention:]:
        try:
            shutil.rmtree(old)
            deleted.append(str(old))
        except OSError:
            pass
    return deleted


def list_backup_history(db_conn: sqlite3.Connection, limit: int = 50,
                          with_details: bool = False) -> list[dict]:
    """Return recent backup_history rows, newest first.

    `details` (the per-worktree manifest, typically a few KB per row)
    is omitted by default — the dashboard's history table doesn't
    surface it, so trimming it keeps the response small even on
    instances with hundreds of past backups. Pass `with_details=True`
    when a future drill-down view needs the manifest.
    """
    cols = "id, created_at, path, ok, error, db_size_bytes, " \
            "bundle_count, total_size_bytes"
    if with_details:
        cols += ", details"
    rows = db_conn.execute(
        f"SELECT {cols} FROM backup_history "
        f"ORDER BY created_at DESC LIMIT ?",
        (max(1, limit),),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        if with_details:
            try:
                d = json.loads(r[8]) if r[8] else None
            except json.JSONDecodeError:
                d = None
        else:
            d = None
        out.append({
            "id": r[0],
            "created_at": r[1],
            "path": r[2],
            "ok": bool(r[3]),
            "error": r[4],
            "db_size_bytes": r[5],
            "bundle_count": r[6],
            "total_size_bytes": r[7],
            "details": d,
        })
    return out


def delete_backup_entry(db_conn: sqlite3.Connection, entry_id: int) -> dict:
    """Delete one backup_history row plus the timestamped directory it
    points at on disk. Returns {ok, path, error?}.

    Path safety: only remove the directory if the row's stored path
    points at an existing directory whose basename matches the
    YYYYMMDD-HHMMSS pattern run_backup_now() produces. That keeps a
    bug or tampered row from rm -rf'ing an arbitrary directory.
    """
    row = db_conn.execute(
        "SELECT path FROM backup_history WHERE id = ?",
        (entry_id,),
    ).fetchone()
    if row is None:
        return {"ok": False, "error": f"no backup_history row id={entry_id}"}
    path = Path(row[0])
    # Only nuke directories that look like our timestamped layout.
    safe = bool(re.fullmatch(r"\d{8}-\d{6}", path.name))
    error: str | None = None
    if path.exists():
        if not safe:
            error = f"refusing to delete {path} (unexpected name)"
        elif not path.is_dir():
            error = f"refusing to delete {path} (not a directory)"
        else:
            try:
                shutil.rmtree(path)
            except OSError as ex:
                error = f"rmtree failed: {ex}"
    if error is None:
        db_conn.execute("DELETE FROM backup_history WHERE id = ?",
                         (entry_id,))
        db_conn.commit()
    return {"ok": error is None, "path": str(path), "error": error}


def get_last_backup_at(db_conn: sqlite3.Connection) -> int | None:
    row = db_conn.execute(
        "SELECT MAX(created_at) FROM backup_history WHERE ok = 1"
    ).fetchone()
    return row[0] if row and row[0] is not None else None


def backup_loop(*, db_connect: Callable[[], sqlite3.Connection],
                 db_path: Path,
                 worktrees_root: Path,
                 get_settings: Callable[[sqlite3.Connection], dict],
                 log_event: Callable,
                 check_interval_seconds: int = 300) -> None:
    """Long-running thread target. Wakes every `check_interval_seconds`,
    reads the current backup settings (so toggles via the UI take effect
    without a restart), and runs a backup if one is due.

    `get_settings(conn)` must return a dict with keys:
      enabled (bool), interval_days (int), dir (str), retention (int).
    """
    while True:
        try:
            conn = db_connect()
            try:
                settings = get_settings(conn)
                if settings.get("enabled"):
                    last = get_last_backup_at(conn) or 0
                    interval_s = max(1, int(settings.get("interval_days") or 0)) * 86400
                    if (time.time() - last) >= interval_s:
                        dest = Path(settings.get("dir") or "")
                        if dest:
                            result = run_backup_now(
                                conn, db_path, dest, worktrees_root)
                            prune_backups(
                                dest, int(settings.get("retention") or 0))
                            log_event("info", "backup",
                                      "scheduled backup",
                                      ok=result["ok"],
                                      path=result["path"],
                                      bundles=result["bundle_count"],
                                      bytes=result["total_size_bytes"],
                                      error=result["error"])
            finally:
                conn.close()
        except Exception as ex:  # noqa: BLE001 — keep the loop alive
            try:
                log_event("error", "backup_loop", f"{type(ex).__name__}: {ex}")
            except Exception:  # noqa: BLE001
                pass
        time.sleep(check_interval_seconds)
