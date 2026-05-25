"""Local user identity + data-folder paths.

`_user_slug` is the per-user namespace under data/ — derived from
`git config user.email`'s local-part so multiple users sharing the
same git remote write to disjoint subfolders. Falls back to $USER,
then 'unknown'.

`user_profile` returns the avatar / name / email blob the dashboard
header used to render before the title was removed; still used by
the in-app profile popover.

The `user_*_json / user_*_jsonl` helpers are thin wrappers that
build paths under DATA_DIR/<slug>/.

REPO_DIR and DATA_DIR are wired in via configure() so the module
stays import-cycle-free with agent_workspace.py.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

# Defaults — replaced via configure() by the caller. The defaults
# work if the module is imported from the repo root (e.g. tests).
REPO_DIR = Path(__file__).parent.parent.resolve()
DATA_DIR = REPO_DIR / "data"


def configure(repo_dir: Path | None = None,
               data_dir: Path | None = None) -> None:
    """Override the module-level path defaults."""
    global REPO_DIR, DATA_DIR
    if repo_dir is not None:
        REPO_DIR = repo_dir
    if data_dir is not None:
        DATA_DIR = data_dir


def _user_slug() -> str:
    """
    Per-user namespace: derived from `git config user.email` local-part so
    multiple users can sync into the same repo without colliding. Falls back
    to $USER, then 'unknown'.
    """
    res = subprocess.run(
        ["git", "-C", str(REPO_DIR), "config", "user.email"],
        capture_output=True, text=True, check=False,
    )
    email = res.stdout.strip()
    if email and "@" in email:
        return email.split("@", 1)[0].lower().replace("/", "-")
    return os.environ.get("USER", "unknown")


def user_profile() -> dict:
    """Identity blob for the dashboard's profile button: email, name, slug,
    and a 1–2 char initials string for the avatar. Falls back gracefully if
    `git config user.email/user.name` aren't set."""
    def _cfg(key: str) -> str:
        try:
            res = subprocess.run(
                ["git", "-C", str(REPO_DIR), "config", key],
                capture_output=True, text=True, check=False,
            )
            return res.stdout.strip()
        except OSError:
            return ""
    email = _cfg("user.email")
    name = _cfg("user.name")
    slug = _user_slug()
    initials = ""
    if name:
        parts = [p for p in re.split(r"\s+", name) if p]
        initials = "".join(p[0] for p in parts[:2]).upper()
    if not initials and slug:
        initials = slug[:2].upper()
    return {
        "email": email,
        "name": name or slug,
        "slug": slug,
        "initials": initials or "?",
    }


def user_data_dir() -> Path:
    return DATA_DIR / _user_slug()


def user_commits_jsonl() -> Path:
    return user_data_dir() / "commits.jsonl"


def user_worktrees_json() -> Path:
    return user_data_dir() / "worktrees.json"


def user_agent_tokens_json() -> Path:
    return user_data_dir() / "agent_tokens.json"


def user_meta_json() -> Path:
    return user_data_dir() / "meta.json"


def user_preferences_json() -> Path:
    return user_data_dir() / "preferences.json"


def user_notes_jsonl() -> Path:
    return user_data_dir() / "notes.jsonl"
