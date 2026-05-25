"""Shared fixtures for the agent-workspace test suite.

The application is a single-file `agent_workspace.py` at the repo
root with no package wrapper, so we import it directly. The
`pythonpath` setting in pyproject.toml ensures the import resolves.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

import pytest

import agent_workspace as cw


@pytest.fixture
def tmp_db():
    """In-memory SQLite with the production schema applied."""
    conn = sqlite3.connect(":memory:")
    conn.executescript(cw.DB_SCHEMA)
    yield conn
    conn.close()


@pytest.fixture
def tmp_git_repo(tmp_path: Path) -> Path:
    """Create a bare-bones git repo in tmp_path with one commit on master."""
    repo = tmp_path / "primary"
    repo.mkdir()
    _run(["git", "init", "-b", "master"], cwd=repo)
    _run(["git", "config", "user.email", "test@example.com"], cwd=repo)
    _run(["git", "config", "user.name",  "Test User"],         cwd=repo)
    (repo / "README").write_text("hello\n")
    _run(["git", "add", "README"],          cwd=repo)
    _run(["git", "commit", "-m", "init"],   cwd=repo)
    return repo


@pytest.fixture
def tmp_worktree(tmp_git_repo: Path, tmp_path: Path) -> Path:
    """A working git worktree for `tmp_git_repo`'s master branch.

    Layout:
        tmp_path/
          primary/         (the bare-bones repo)
          wt/              (a worktree of primary's master)
    """
    wt = tmp_path / "wt"
    # `master` is checked out in the primary, so we can't add a worktree
    # tracking the same branch — git refuses. Create a new branch
    # `wt-branch` for the worktree instead. Tests that care about the
    # branch label adjust their expectation accordingly.
    _run(["git", "worktree", "add", "-b", "wt-branch", str(wt)],
         cwd=tmp_git_repo)
    return wt


@pytest.fixture
def tmp_worktrees_root(tmp_path: Path) -> tuple[Path, Path]:
    """A worktrees-style layout with a primary `core` repo so
    `create_issue_worktrees` and `remove_issue_worktrees` have
    something to operate on.

    Returns (worktrees_root, primaries_root). primaries_root is the
    parent of worktrees_root, mirroring how the dashboard sees the
    real `~/github/worktrees/` + `~/github/<repo>/` layout.
    """
    primaries = tmp_path / "primaries"
    primaries.mkdir()
    core = primaries / "core"
    core.mkdir()
    _run(["git", "init", "-b", "master"], cwd=core)
    _run(["git", "config", "user.email", "test@example.com"], cwd=core)
    _run(["git", "config", "user.name",  "Test User"],         cwd=core)
    (core / "README").write_text("hello core\n")
    _run(["git", "add", "README"],         cwd=core)
    _run(["git", "commit", "-m", "init"],  cwd=core)

    worktrees = primaries / "worktrees"
    worktrees.mkdir()
    return worktrees, primaries


def _run(cmd: list[str], cwd: Path) -> None:
    """Run a subprocess, raising on non-zero. Silences output."""
    subprocess.run(cmd, cwd=str(cwd), check=True,
                   capture_output=True, text=True)
