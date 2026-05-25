"""Tests for awlib/updater.py — the dashboard's auto-update plumbing.

We build a two-clone local layout (origin + working clone) so the
fetch/pull paths run end-to-end without ever hitting the real network.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from awlib import updater


def _run(cmd: list[str], cwd: Path) -> None:
    subprocess.run(cmd, cwd=str(cwd), check=True,
                   capture_output=True, text=True)


@pytest.fixture
def origin_and_clone(tmp_path: Path) -> tuple[Path, Path]:
    """Build origin (bare) + clone, return (origin_dir, clone_dir).
    The clone is set up to track origin/master so fetch + pull work."""
    seed = tmp_path / "seed"
    seed.mkdir()
    _run(["git", "init", "-b", "master"], cwd=seed)
    _run(["git", "config", "user.email", "test@example.com"], cwd=seed)
    _run(["git", "config", "user.name",  "Test User"],         cwd=seed)
    (seed / "README").write_text("hello\n")
    _run(["git", "add", "README"],         cwd=seed)
    _run(["git", "commit", "-m", "init"],  cwd=seed)

    origin = tmp_path / "origin.git"
    _run(["git", "clone", "--bare", str(seed), str(origin)], cwd=tmp_path)

    clone = tmp_path / "clone"
    _run(["git", "clone", str(origin), str(clone)], cwd=tmp_path)
    _run(["git", "config", "user.email", "test@example.com"], cwd=clone)
    _run(["git", "config", "user.name",  "Test User"],         cwd=clone)
    return origin, clone


def _commit_to_origin(origin: Path, tmp_path: Path,
                       message: str = "second") -> None:
    """Push a fresh commit into `origin` via a throwaway scratch clone
    (bare repos don't have a working tree of their own)."""
    scratch = tmp_path / "scratch"
    if scratch.exists():
        import shutil
        shutil.rmtree(scratch)
    _run(["git", "clone", str(origin), str(scratch)], cwd=tmp_path)
    _run(["git", "config", "user.email", "test@example.com"], cwd=scratch)
    _run(["git", "config", "user.name",  "Test User"],         cwd=scratch)
    (scratch / "f.txt").write_text("new\n")
    _run(["git", "add", "f.txt"], cwd=scratch)
    _run(["git", "commit", "-m", message], cwd=scratch)
    _run(["git", "push", "origin", "master"], cwd=scratch)


def test_check_remote_when_up_to_date(origin_and_clone):
    _, clone = origin_and_clone
    s = updater.check_remote(clone)
    assert s["ok"] is True
    assert s["error"] is None
    assert s["branch"] == "master"
    assert s["behind"] == 0
    # local + remote sha match exactly when there's nothing to fetch
    assert s["current_sha"] == s["remote_sha"]


def test_check_remote_detects_behind(origin_and_clone, tmp_path):
    origin, clone = origin_and_clone
    _commit_to_origin(origin, tmp_path)
    s = updater.check_remote(clone)
    assert s["ok"] is True
    assert s["behind"] == 1
    assert s["current_sha"] != s["remote_sha"]
    assert "second" in s["remote_subject"]


def test_check_remote_on_non_repo(tmp_path):
    s = updater.check_remote(tmp_path / "nope")
    assert s["ok"] is False
    assert "not a git repository" in s["error"]


def test_pull_latest_fast_forwards(origin_and_clone, tmp_path):
    origin, clone = origin_and_clone
    _commit_to_origin(origin, tmp_path)
    # Without a fetch the local doesn't even know about the remote
    # commit yet; check_remote does the fetch for us.
    updater.check_remote(clone)
    r = updater.pull_latest(clone)
    assert r["ok"] is True
    assert r["error"] is None
    # After pulling, behind should drop to zero.
    s = updater.check_remote(clone)
    assert s["behind"] == 0


def test_pull_latest_refuses_non_ff(origin_and_clone, tmp_path):
    """Local commit ahead of origin + a different commit on origin →
    pull --ff-only must refuse with a useful error."""
    origin, clone = origin_and_clone
    # Diverge: local commit
    (clone / "local.txt").write_text("local\n")
    _run(["git", "add", "local.txt"], cwd=clone)
    _run(["git", "commit", "-m", "local"], cwd=clone)
    # Remote also moves
    _commit_to_origin(origin, tmp_path, message="remote")
    # Fetch so git knows it's a non-FF situation
    updater.check_remote(clone)
    r = updater.pull_latest(clone)
    assert r["ok"] is False
    assert r["error"]


def test_status_cache_round_trip():
    """get_status / set_status are thread-safe and copy on read."""
    snap = updater.get_status()
    assert isinstance(snap, dict)
    new = dict(snap, behind=42, current_sha="x")
    updater.set_status(new)
    out = updater.get_status()
    assert out["behind"] == 42
    out["behind"] = 999  # mutating the copy shouldn't leak back
    assert updater.get_status()["behind"] == 42
    # Restore so other tests aren't affected.
    updater.set_status(snap)
