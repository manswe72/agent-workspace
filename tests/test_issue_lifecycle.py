"""Tests for create_issue_worktrees / remove_issue_worktrees end-to-end.

These exercise real git binaries against real tempdirs (no mocking) so
the behaviour matches what the dashboard's `+ Add issue` and `🗑 Remove`
actions actually trigger.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import agent_workspace as cw


def _run(cmd, cwd):
    return subprocess.run(cmd, cwd=str(cwd), check=True,
                          capture_output=True, text=True)


def test_create_issue_worktrees_makes_worktree(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    results = cw.create_issue_worktrees(
        worktrees, primaries, issue="BSS-1", base_branch="master",
        repos=["core"])
    assert len(results) == 1
    r = results[0]
    assert r["repo"] == "core"
    assert r["ok"] is True, r
    assert r["action"] == "created"
    wt = worktrees / "BSS-1" / "core"
    assert wt.is_dir()
    assert (wt / ".git").exists()


def test_create_skips_if_worktree_already_exists(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    cw.create_issue_worktrees(
        worktrees, primaries, "BSS-2", "master", ["core"])
    second = cw.create_issue_worktrees(
        worktrees, primaries, "BSS-2", "master", ["core"])
    assert second[0]["ok"] is False
    assert second[0]["action"] == "skip"
    assert "already exists" in second[0]["message"]


def test_create_fails_when_base_branch_missing(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    results = cw.create_issue_worktrees(
        worktrees, primaries, "BSS-3", "no-such-branch", ["core"])
    assert results[0]["ok"] is False
    assert "no-such-branch" in results[0]["message"]


def test_create_skips_when_primary_repo_missing(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    results = cw.create_issue_worktrees(
        worktrees, primaries, "BSS-4", "master", ["unknown-repo"])
    assert results[0]["ok"] is False
    assert results[0]["action"] == "skip"
    assert "no primary repo" in results[0]["message"]


def test_remove_issue_worktrees_clean(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    cw.create_issue_worktrees(
        worktrees, primaries, "BSS-5", "master", ["core"])
    wt = worktrees / "BSS-5" / "core"
    assert wt.is_dir()

    results = cw.remove_issue_worktrees(
        worktrees, primaries, "BSS-5",
        force=False, delete_branch=False)
    repo_results = [r for r in results if r.get("repo") == "core"]
    assert repo_results and repo_results[0]["ok"]
    assert not wt.exists()


def test_remove_refuses_dirty_without_force(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    cw.create_issue_worktrees(
        worktrees, primaries, "BSS-6", "master", ["core"])
    wt = worktrees / "BSS-6" / "core"
    (wt / "scratch.txt").write_text("uncommitted\n")

    results = cw.remove_issue_worktrees(
        worktrees, primaries, "BSS-6",
        force=False, delete_branch=False)
    repo_results = [r for r in results if r.get("repo") == "core"]
    assert repo_results and repo_results[0]["ok"] is False
    assert wt.exists(), "worktree must NOT have been removed"


def test_remove_force_drops_dirty(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    cw.create_issue_worktrees(
        worktrees, primaries, "BSS-7", "master", ["core"])
    wt = worktrees / "BSS-7" / "core"
    (wt / "scratch.txt").write_text("uncommitted\n")

    results = cw.remove_issue_worktrees(
        worktrees, primaries, "BSS-7",
        force=True, delete_branch=False)
    repo_results = [r for r in results if r.get("repo") == "core"]
    assert repo_results and repo_results[0]["ok"]
    assert not wt.exists()


def test_remove_with_delete_branch_drops_local_branch(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    cw.create_issue_worktrees(
        worktrees, primaries, "BSS-8", "master", ["core"])
    primary = primaries / "core"

    # Branch must exist before removal.
    branches = _run(["git", "branch"], cwd=primary).stdout
    assert "BSS-8" in branches

    cw.remove_issue_worktrees(
        worktrees, primaries, "BSS-8",
        force=True, delete_branch=True)

    branches_after = _run(["git", "branch"], cwd=primary).stdout
    assert "BSS-8" not in branches_after


def test_remove_nonexistent_issue_returns_skip(tmp_worktrees_root):
    worktrees, primaries = tmp_worktrees_root
    results = cw.remove_issue_worktrees(
        worktrees, primaries, "BSS-DOES-NOT-EXIST")
    assert results
    assert any(r.get("action") == "skip" for r in results)
