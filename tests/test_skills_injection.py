"""Tests for skill injection.

Exercises the cross-provider dispatcher in `awlib/providers/base.py`,
the reconcile helpers, the SKILL.md frontmatter parser, and the
filesystem-browse endpoint's $HOME guardrail + denylist + 0.0.0.0
gate.

Every reconcile helper writes under `Path.home()`. Tests
monkeypatch `awlib.providers.base.HOME` (and the recomputed module
constants that derive from it) onto a per-test tmp dir so we never
touch the real ~/.claude / ~/.cursor / ~/.gemini.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import awlib.providers.base as base


# ── Fixtures ────────────────────────────────────────────────────────

@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect every HOME-anchored path in providers/base.py at a
    per-test temp dir.

    `base.HOME` and the constants computed from it are read at module
    load — we have to patch each individually rather than rely on a
    single `Path.home` monkeypatch.
    """
    monkeypatch.setattr(base, "HOME", tmp_path)
    monkeypatch.setattr(base, "AIDER_SKILL_DIR",
                         tmp_path / ".cache" / "agent-workspace" /
                         "aider-skills")
    monkeypatch.setattr(base, "GEMINI_CONFIG_PATH",
                         tmp_path / ".gemini" / "GEMINI.md")
    return tmp_path


def _make_skill(root: Path, name: str, body: str = "hello body",
                 frontmatter_name: str | None = None) -> Path:
    """Create a skill folder with SKILL.md (optionally with a
    `name:` frontmatter entry). Returns the folder path.
    """
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    fm = ""
    if frontmatter_name is not None:
        fm = f"---\nname: {frontmatter_name}\n---\n"
    (folder / "SKILL.md").write_text(fm + body, encoding="utf-8")
    return folder


# ── Frontmatter parser ─────────────────────────────────────────────

def test_strip_frontmatter_basic():
    text = "---\nname: x\n---\nbody here\n"
    assert base._strip_skill_frontmatter(text) == "body here\n"


def test_strip_frontmatter_bom():
    text = "﻿---\nname: x\n---\nbody\n"
    assert base._strip_skill_frontmatter(text) == "body\n"


def test_strip_frontmatter_crlf():
    text = "---\r\nname: x\r\n---\r\nbody\r\n"
    out = base._strip_skill_frontmatter(text)
    assert out == "body\n"


def test_strip_frontmatter_no_frontmatter():
    text = "no leading delim\nbody body body"
    assert base._strip_skill_frontmatter(text) == text


def test_strip_frontmatter_multi_dashes_in_body():
    """Only the *first* `---` block should be eaten — multi-doc YAML
    in code examples later in the file stays verbatim."""
    text = (
        "---\nname: x\n---\n"
        "intro\n\n"
        "---\nlater block\n---\n"
        "trailing\n"
    )
    out = base._strip_skill_frontmatter(text)
    assert "intro" in out
    assert "later block" in out
    assert "name: x" not in out


def test_skill_body_truncation(tmp_path: Path):
    body = "x" * (base.SKILL_BODY_MAX_BYTES + 5000)
    folder = _make_skill(tmp_path, "bigskill", body=body)
    out = base._skill_body(folder)
    assert out.endswith(base.SKILL_TRUNC_MARKER)
    # Truncated payload + marker ≤ cap + a couple hundred bytes for the
    # marker. The hard guarantee is that we don't return the full body.
    assert len(out.encode("utf-8")) <= \
        base.SKILL_BODY_MAX_BYTES + len(base.SKILL_TRUNC_MARKER) + 16


def test_parse_skill_name_present(tmp_path: Path):
    folder = _make_skill(tmp_path, "demo", frontmatter_name="my-name")
    assert base.parse_skill_name(folder) == "my-name"


def test_parse_skill_name_missing(tmp_path: Path):
    folder = _make_skill(tmp_path, "noname")
    assert base.parse_skill_name(folder) is None


# ── Claude reconcile ───────────────────────────────────────────────

def test_claude_symlinks_and_marker(isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "db-migrator")
    base.ensure_claude_code_skills(
        [{"path": str(src)}], agent_id="ws-1")
    skills_dir = isolated_home / ".claude" / "skills"
    link = skills_dir / "db-migrator"
    marker = skills_dir / "db-migrator.managed-by-agent-workspace"
    assert link.is_symlink()
    assert link.resolve() == src.resolve()
    assert marker.exists()


def test_claude_sweep_removes_owned_entries(isolated_home: Path,
                                              tmp_path: Path):
    src = _make_skill(tmp_path, "to-go")
    base.ensure_claude_code_skills(
        [{"path": str(src)}], agent_id="ws-1")
    skills_dir = isolated_home / ".claude" / "skills"
    assert (skills_dir / "to-go").is_symlink()
    base.ensure_claude_code_skills([], agent_id="ws-1")
    assert not (skills_dir / "to-go").exists()
    assert not (skills_dir
                  / "to-go.managed-by-agent-workspace").exists()


def test_claude_never_touches_foreign_directory(isolated_home: Path,
                                                  tmp_path: Path):
    """A `work-tracker` directory that the user installed by hand
    (no `.managed-by-agent-workspace` marker) must survive every
    reconcile.
    """
    foreign = isolated_home / ".claude" / "skills" / "work-tracker"
    foreign.mkdir(parents=True)
    (foreign / "SKILL.md").write_text("hand")
    src = _make_skill(tmp_path, "work-tracker")  # same basename!
    base.ensure_claude_code_skills(
        [{"path": str(src)}], agent_id="ws-1")
    # Foreign dir still exists as a real directory.
    assert foreign.is_dir() and not foreign.is_symlink()
    assert (foreign / "SKILL.md").read_text() == "hand"


def test_claude_skips_missing_source(isolated_home: Path, tmp_path: Path):
    bogus = tmp_path / "never-existed"
    base.ensure_claude_code_skills(
        [{"path": str(bogus)}], agent_id="ws-1")
    skills_dir = isolated_home / ".claude" / "skills"
    assert not (skills_dir / "never-existed").exists()


def test_claude_dangling_link_reaped(isolated_home: Path, tmp_path: Path):
    """Source disappears between launches — the link we own must go."""
    src = _make_skill(tmp_path, "vanishing")
    base.ensure_claude_code_skills(
        [{"path": str(src)}], agent_id="ws-1")
    skills_dir = isolated_home / ".claude" / "skills"
    assert (skills_dir / "vanishing").is_symlink()
    # Remove the source folder…
    (src / "SKILL.md").unlink()
    src.rmdir()
    # …then re-reconcile with the still-stale pref entry. The reconcile
    # should drop the orphan rather than leave a broken symlink.
    base.ensure_claude_code_skills(
        [{"path": str(src)}], agent_id="ws-1")
    assert not (skills_dir / "vanishing").exists()


# ── Cursor reconcile ───────────────────────────────────────────────

def test_cursor_writes_mdc_and_marker(isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "say-hi", body="greet body")
    base.ensure_cursor_skill_rules(
        [{"path": str(src)}], agent_id="ws-1")
    rules_dir = isolated_home / ".cursor" / "rules"
    mdc = rules_dir / "say-hi.mdc"
    marker = rules_dir / "say-hi.mdc.managed-by-agent-workspace"
    assert mdc.is_file()
    assert marker.exists()
    txt = mdc.read_text()
    assert "greet body" in txt
    assert "agent-workspace-inject:" in txt
    assert "name: say-hi" not in txt  # frontmatter stripped


def test_cursor_sweep_drops_unselected(isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "first")
    base.ensure_cursor_skill_rules(
        [{"path": str(src)}], agent_id="ws-1")
    rules_dir = isolated_home / ".cursor" / "rules"
    assert (rules_dir / "first.mdc").is_file()
    base.ensure_cursor_skill_rules([], agent_id="ws-1")
    assert not (rules_dir / "first.mdc").exists()
    assert not (rules_dir
                  / "first.mdc.managed-by-agent-workspace").exists()


def test_cursor_skips_user_authored_collision(isolated_home: Path,
                                                tmp_path: Path):
    rules_dir = isolated_home / ".cursor" / "rules"
    rules_dir.mkdir(parents=True)
    user_mdc = rules_dir / "collide.mdc"
    user_mdc.write_text("user content")
    src = _make_skill(tmp_path, "collide")
    base.ensure_cursor_skill_rules(
        [{"path": str(src)}], agent_id="ws-1")
    # User file untouched, no marker created.
    assert user_mdc.read_text() == "user content"
    assert not (rules_dir
                  / "collide.mdc.managed-by-agent-workspace").exists()


# ── Gemini managed block ──────────────────────────────────────────

def test_gemini_block_creates_file(isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "gem-skill", body="gem body here")
    base.ensure_gemini_skill_block(
        [{"path": str(src)}], agent_id="ws-1")
    cfg = isolated_home / ".gemini" / "GEMINI.md"
    txt = cfg.read_text()
    assert base.GEMINI_BLOCK_BEGIN in txt
    assert base.GEMINI_BLOCK_END in txt
    assert "gem body here" in txt
    assert "gem-skill" in txt


def test_gemini_block_round_trip_preserves_user_content(
        isolated_home: Path, tmp_path: Path):
    """User content above and below the managed block must survive a
    rewrite. (Snailflyer's review highlighted this as where managed-
    block tools usually break first.)"""
    cfg = isolated_home / ".gemini" / "GEMINI.md"
    cfg.parent.mkdir(parents=True)
    above = "# my own notes above\n"
    below = "## below the block\nplenty of stuff here\n"
    cfg.write_text(
        above
        + base.GEMINI_BLOCK_BEGIN + "\nold block contents\n"
        + base.GEMINI_BLOCK_END + "\n"
        + below
    )
    src = _make_skill(tmp_path, "new-skill", body="new body")
    base.ensure_gemini_skill_block(
        [{"path": str(src)}], agent_id="ws-1")
    out = cfg.read_text()
    assert out.startswith(above)
    assert out.endswith(below)
    assert "new body" in out
    assert "old block contents" not in out


def test_gemini_block_empty_replaces_block(isolated_home: Path):
    cfg = isolated_home / ".gemini" / "GEMINI.md"
    cfg.parent.mkdir(parents=True)
    cfg.write_text(
        "above\n"
        + base.GEMINI_BLOCK_BEGIN + "\nold\n" + base.GEMINI_BLOCK_END + "\n"
        + "below\n"
    )
    base.ensure_gemini_skill_block([], agent_id="ws-1")
    out = cfg.read_text()
    assert "above" in out and "below" in out
    assert "old" not in out


# ── Aider tmpfile ─────────────────────────────────────────────────

def test_aider_writes_tmpfile(isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "aider-skill", body="aider body")
    out_path = base.write_aider_skill_file(
        [{"path": str(src)}], agent_id="ws-1")
    assert out_path is not None
    assert out_path.is_file()
    text = out_path.read_text()
    assert "aider body" in text
    assert "agent-workspace-inject:" in text


def test_aider_clears_tmpfile_when_empty(isolated_home: Path,
                                          tmp_path: Path):
    src = _make_skill(tmp_path, "first")
    out_path = base.write_aider_skill_file(
        [{"path": str(src)}], agent_id="ws-1")
    assert out_path is not None and out_path.is_file()
    # Empty pref → tmpfile is cleared.
    out_path2 = base.write_aider_skill_file([], agent_id="ws-1")
    assert out_path2 is None
    assert not out_path.exists()


# ── Dispatcher ─────────────────────────────────────────────────────

def test_dispatcher_aider_returns_tmpfile(isolated_home: Path,
                                            tmp_path: Path):
    src = _make_skill(tmp_path, "x", body="b")
    _, extra = base.inject_skills(
        provider_id="aider",
        injected=[{"path": str(src)}],
        working_dir=tmp_path, agent_id="ws-1",
        sys_prompt="base sys prompt")
    assert extra is not None
    assert extra.is_file()


def test_dispatcher_codex_appends_to_sys_prompt(isolated_home: Path,
                                                  tmp_path: Path):
    src = _make_skill(tmp_path, "x", body="codex body line")
    augmented, extra = base.inject_skills(
        provider_id="codex",
        injected=[{"path": str(src)}],
        working_dir=tmp_path, agent_id="ws-1",
        sys_prompt="base sys")
    assert extra is None
    assert augmented.startswith("base sys")
    assert "codex body line" in augmented


def test_dispatcher_crush_is_a_noop(isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "x")
    augmented, extra = base.inject_skills(
        provider_id="crush",
        injected=[{"path": str(src)}],
        working_dir=tmp_path, agent_id="ws-1",
        sys_prompt="base sys")
    assert extra is None
    assert augmented == "base sys"  # untouched


def test_dispatcher_empty_list_is_a_noop(isolated_home: Path,
                                           tmp_path: Path):
    augmented, extra = base.inject_skills(
        provider_id="claude",
        injected=[],
        working_dir=tmp_path, agent_id="ws-1",
        sys_prompt="sp")
    assert augmented == "sp" and extra is None


def test_dispatcher_unknown_provider_skips_silently(
        isolated_home: Path, tmp_path: Path):
    src = _make_skill(tmp_path, "x")
    augmented, extra = base.inject_skills(
        provider_id="does-not-exist",
        injected=[{"path": str(src)}],
        working_dir=tmp_path, agent_id="ws-1",
        sys_prompt="sp")
    assert augmented == "sp" and extra is None


# ── Audit events ──────────────────────────────────────────────────

def _capture_log(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Replace base.log_event with a list-recorder. Returns the list."""
    rows: list[dict] = []
    def fake(level, component, msg, **fields):
        rows.append({"level": level, "component": component,
                     "msg": msg, **fields})
    monkeypatch.setattr(base, "log_event", fake)
    return rows


def test_audit_event_emitted_per_skill_claude(isolated_home: Path,
                                                tmp_path: Path,
                                                monkeypatch):
    rows = _capture_log(monkeypatch)
    src = _make_skill(tmp_path, "audit-skill")
    base.ensure_claude_code_skills(
        [{"path": str(src)}], agent_id="ws-1")
    skill_rows = [r for r in rows if r["component"] == "skills"]
    assert len(skill_rows) == 1
    r = skill_rows[0]
    assert r["provider"] == "claude"
    assert r["skill_name"] == "audit-skill"
    assert r["result"] == "linked"
    assert r["inject_tag"]
    assert "audit-skill" in r["injection_path"]


def test_audit_event_for_cursor_includes_hash(isolated_home: Path,
                                                tmp_path: Path,
                                                monkeypatch):
    rows = _capture_log(monkeypatch)
    src = _make_skill(tmp_path, "hash-skill", body="contents go here")
    base.ensure_cursor_skill_rules(
        [{"path": str(src)}], agent_id="ws-1")
    rule_rows = [r for r in rows if r.get("result") == "rule-written"]
    assert len(rule_rows) == 1
    assert re.fullmatch(r"[0-9a-f]{12}",
                         rule_rows[0]["body_sha256"]) is not None


def test_audit_event_skipped_for_missing_source(isolated_home: Path,
                                                  tmp_path: Path,
                                                  monkeypatch):
    rows = _capture_log(monkeypatch)
    base.ensure_claude_code_skills(
        [{"path": str(tmp_path / "ghost")}], agent_id="ws-1")
    skill_rows = [r for r in rows if r["component"] == "skills"]
    assert any(r["result"] == "skipped" for r in skill_rows)


# ── /api/fs/browse hardening ─────────────────────────────────────

def _fs_browse(monkeypatch, qs_path: str | None,
                bind: tuple[str, int] = ("127.0.0.1", 0)) -> tuple[int, dict]:
    """Drive the handler in isolation. We synthesize the minimum
    self/server attributes the two new methods touch.
    """
    import agent_workspace as cw

    class _DummyServer:
        server_address = bind

    captured: list[tuple[int, dict]] = []

    class _DummyHandler:
        server = _DummyServer()

        def _send_json(self, code: int, obj: dict) -> None:
            captured.append((code, obj))

    # The real Handler class is created by `make_handler` (a closure
    # over the server config). Materialise one to harvest the methods.
    cls = cw.make_handler(Path.cwd(), behind_limit=10)
    for name in ("_handle_fs_browse", "_resolve_under_home",
                 "_fs_browse_allowed_root", "_fs_browse_loopback_only",
                 "_fs_browse_denied"):
        setattr(_DummyHandler, name, getattr(cls, name))
    setattr(_DummyHandler, "_FS_BROWSE_DENYLIST", cls._FS_BROWSE_DENYLIST)
    h = _DummyHandler()
    qs = {} if qs_path is None else {"path": [qs_path]}
    h._handle_fs_browse(qs)
    return captured[0]


def test_fs_browse_lists_home(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    # Path.home() reads $HOME on POSIX.
    (tmp_path / "demo").mkdir()
    code, payload = _fs_browse(monkeypatch, str(tmp_path))
    assert code == 200
    assert any(e["name"] == "demo" for e in payload["entries"])


def test_fs_browse_rejects_path_outside_home(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    code, payload = _fs_browse(monkeypatch, "/etc")
    assert code == 400


def test_fs_browse_refuses_denylist_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    ssh = tmp_path / ".ssh"
    ssh.mkdir()
    (ssh / "id_rsa").write_text("private")
    code, _ = _fs_browse(monkeypatch, str(ssh))
    assert code == 403


def test_fs_browse_blocks_non_loopback_bind(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("AGENT_WORKSPACE_ALLOW_FS_BROWSE_REMOTE",
                       raising=False)
    code, _ = _fs_browse(monkeypatch, str(tmp_path),
                          bind=("0.0.0.0", 0))
    assert code == 403


def test_fs_browse_allows_non_loopback_when_opted_in(
        tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("AGENT_WORKSPACE_ALLOW_FS_BROWSE_REMOTE", "1")
    (tmp_path / "demo").mkdir()
    code, _ = _fs_browse(monkeypatch, str(tmp_path),
                          bind=("0.0.0.0", 0))
    assert code == 200
