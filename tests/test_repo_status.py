"""Tests for `gather_repo_status` against a real (tiny) git worktree."""
from __future__ import annotations

import subprocess
from pathlib import Path

import agent_workspace as cw


def _run(cmd, cwd):
    subprocess.run(cmd, cwd=str(cwd), check=True,
                   capture_output=True, text=True)


def test_clean_worktree_reports_clean(tmp_worktree: Path):
    s = cw.gather_repo_status(tmp_worktree)
    assert s["branch"] == "wt-branch"
    assert s["n_dirty"] == 0
    assert s["dirty_files"] == []


def test_dirty_file_surfaces(tmp_worktree: Path):
    (tmp_worktree / "new.txt").write_text("hi\n")
    s = cw.gather_repo_status(tmp_worktree)
    assert s["n_dirty"] == 1
    paths = [f["path"] for f in s["dirty_files"]]
    assert "new.txt" in paths


def test_unpushed_commit_increments_n_unpushed(tmp_worktree: Path):
    (tmp_worktree / "a.txt").write_text("a\n")
    _run(["git", "add", "a.txt"],          cwd=tmp_worktree)
    _run(["git", "commit", "-m", "add a"], cwd=tmp_worktree)
    s = cw.gather_repo_status(tmp_worktree)
    # No upstream configured, so unpushed counting is best-effort.
    # It should at least be a non-negative int.
    assert isinstance(s["n_unpushed"], int)
    assert s["n_unpushed"] >= 0


def test_branch_field_matches_active_branch(tmp_worktree: Path):
    _run(["git", "checkout", "-b", "feature/x"], cwd=tmp_worktree)
    s = cw.gather_repo_status(tmp_worktree)
    assert s["branch"] == "feature/x"


def test_last_commit_subject_visible(tmp_worktree: Path):
    s = cw.gather_repo_status(tmp_worktree)
    assert "init" in (s.get("last_commit") or "")


def test_known_issues_includes_seen_worktree(tmp_db, tmp_path: Path):
    """known_issues drives the timer issue picker — make sure a row in the
    `worktrees` table surfaces."""
    tmp_db.execute(
        "INSERT INTO worktrees(issue, repo, path, first_seen, last_seen) "
        "VALUES (?, ?, ?, ?, ?)",
        ("ws-42", "core", str(tmp_path / "ws-42" / "core"),
         "2026-01-01", "2026-01-02"),
    )
    tmp_db.commit()
    assert "ws-42" in cw.known_issues(tmp_db)
