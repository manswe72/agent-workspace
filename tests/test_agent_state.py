"""Tests for `issue_agent_state` — active / idle / closed classification.

The state is derived from the most recent *.jsonl mtime in each repo's
~/.claude/projects/<encoded-path>/ directory, with SessionEnd-trumping
via the `ended_sessions` set. We monkeypatch `claude_project_dir` so
the test controls where the JSONL files live without touching the
real ~/.claude folder.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import agent_workspace as cw


def _make_repo_with_jsonl(issue_dir: Path, repo_name: str,
                           jsonl_basename: str, age_seconds: float) -> Path:
    """Create issue_dir/<repo>/.git and a single JSONL file in the
    monkeypatched claude project dir, with mtime = now - age_seconds.
    Returns the JSONL path so tests can mutate it further."""
    repo = issue_dir / repo_name
    repo.mkdir(parents=True, exist_ok=True)
    (repo / ".git").write_text("gitdir: dummy\n")
    proj = cw.claude_project_dir(repo)
    proj.mkdir(parents=True, exist_ok=True)
    jp = proj / f"{jsonl_basename}.jsonl"
    jp.write_text("")
    t = time.time() - age_seconds
    os.utime(jp, (t, t))
    return jp


def test_no_repos_returns_closed(tmp_path: Path):
    issue = tmp_path / "ws-1"
    issue.mkdir()
    assert cw.issue_agent_state(issue) == "closed"


def test_recent_jsonl_marks_active(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cw, "claude_project_dir",
                        lambda wt: tmp_path / "proj" / wt.name)
    issue = tmp_path / "ws-2"
    _make_repo_with_jsonl(issue, "core", "sess-A", age_seconds=10)
    assert cw.issue_agent_state(issue) == "active"


def test_old_jsonl_marks_idle(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cw, "claude_project_dir",
                        lambda wt: tmp_path / "proj" / wt.name)
    issue = tmp_path / "ws-3"
    # Older than ACTIVE window but within IDLE window.
    age = cw.AGENT_ACTIVE_WINDOW_SEC + 60
    _make_repo_with_jsonl(issue, "core", "sess-B", age_seconds=age)
    assert cw.issue_agent_state(issue) == "idle"


def test_very_old_jsonl_marks_closed(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(cw, "claude_project_dir",
                        lambda wt: tmp_path / "proj" / wt.name)
    issue = tmp_path / "ws-4"
    age = cw.AGENT_IDLE_WINDOW_SEC + 60
    _make_repo_with_jsonl(issue, "core", "sess-C", age_seconds=age)
    assert cw.issue_agent_state(issue) == "closed"


def test_ended_session_excludes_recent_jsonl(monkeypatch, tmp_path: Path):
    """A SessionEnd event for the same session_id should make a recent
    jsonl invisible to the state classification."""
    monkeypatch.setattr(cw, "claude_project_dir",
                        lambda wt: tmp_path / "proj" / wt.name)
    issue = tmp_path / "ws-5"
    _make_repo_with_jsonl(issue, "core", "sess-D", age_seconds=10)
    assert cw.issue_agent_state(issue, ended_sessions={"sess-D"}) == "closed"


def test_strongest_state_wins_across_repos(monkeypatch, tmp_path: Path):
    """If one repo is active and another is idle, the issue is active."""
    monkeypatch.setattr(cw, "claude_project_dir",
                        lambda wt: tmp_path / "proj" / wt.name)
    issue = tmp_path / "ws-6"
    _make_repo_with_jsonl(issue, "core",   "sess-E",
                           age_seconds=cw.AGENT_ACTIVE_WINDOW_SEC + 60)
    _make_repo_with_jsonl(issue, "bssweb", "sess-F",
                           age_seconds=10)
    assert cw.issue_agent_state(issue) == "active"
