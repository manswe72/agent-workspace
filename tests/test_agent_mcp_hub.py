"""Tests for hub-and-spoke MCP tools: delegate, route, list_delegations.

The wider agent_mcp module has been exercised by the running dashboard
for a while; these tests focus on the new hub-and-spoke surface so
regressions surface immediately on the next test run.
"""
from __future__ import annotations

import json
import sqlite3

import pytest

from awlib import agent_mcp


@pytest.fixture
def db_path(tmp_path):
    p = tmp_path / "mcp.sqlite"
    # Initialise schema via a one-off connection so the McpServer
    # below can open + close its own handles freely.
    init = sqlite3.connect(p)
    agent_mcp.init_db(init)
    init.close()
    return p


@pytest.fixture
def conn(db_path):
    # Provided to tests that want to inspect rows directly.
    c = sqlite3.connect(db_path)
    yield c
    c.close()


@pytest.fixture
def server(db_path):
    # Three spokes plus the hub. agents_info mirrors the dashboard's
    # real shape (id + display name).
    agents = [
        {"id": "__agent__",       "name": "Agent 007",    "state": "active"},
        {"id": "42-fix-auth",     "name": "Alice",        "state": "active"},
        {"id": "99-docs-cleanup", "name": "DocsBot",      "state": "idle"},
        {"id": "7-frontend",      "name": "FE Helper",    "state": "active"},
    ]
    known = {a["id"] for a in agents}
    name_to_id = {a["name"].lower(): a["id"] for a in agents}

    return agent_mcp.McpServer(
        db_connect=lambda: sqlite3.connect(db_path),
        known_agents=lambda: known,
        live_agents=lambda: [a["id"] for a in agents
                              if a["state"] == "active"
                              and a["id"] != "__agent__"],
        agents_info=lambda: agents,
        resolve_alias=lambda n: name_to_id.get((n or "").lower()),
    )


def _call(server, agent, tool, args):
    """Helper: dispatch one tool/call and return (text, is_error)."""
    resp = server.dispatch(agent, {
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args},
    })
    result = resp.get("result", {})
    content = (result.get("content") or [{}])[0]
    return content.get("text") or "", bool(result.get("isError"))


# ── delegate is hub-only ──────────────────────────────────────────

def test_delegate_rejects_non_hub_caller(server):
    text, err = _call(server, "42-fix-auth", "delegate",
                       {"to": "99-docs-cleanup", "task": "fix the docs"})
    assert err
    assert "hub-only" in text


def test_delegate_rejects_delegating_to_self_hub(server):
    text, err = _call(server, "__agent__", "delegate",
                       {"to": "__agent__", "task": "self-task"})
    assert err
    assert "General Agent itself" in text


def test_delegate_via_display_name(server, conn):
    """Hub delegates to a spoke addressed by display name."""
    text, err = _call(server, "__agent__", "delegate",
                       {"to": "Alice", "task": "review PR #4",
                        "context": "edge cases in the regex",
                        "deadline": "EOD"})
    assert not err
    assert "delegated" in text and "42-fix-auth" in text
    # Row landed with kind='delegation' and the structured payload.
    rows = conn.execute(
        "SELECT from_agent, to_agent, kind, payload FROM agent_messages"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "__agent__"
    assert rows[0][1] == "42-fix-auth"
    assert rows[0][2] == "delegation"
    payload = json.loads(rows[0][3])
    assert payload["task"] == "review PR #4"
    assert payload["context"] == "edge cases in the regex"
    assert payload["deadline"] == "EOD"
    # `text` field has a useful human-readable summary.
    assert "📋 Delegation" in payload["text"]
    assert "EOD" in payload["text"]


def test_delegate_unknown_recipient(server):
    text, err = _call(server, "__agent__", "delegate",
                       {"to": "nobody", "task": "x"})
    assert err
    assert "unknown agent" in text


# ── list_delegations resolves via reply chains ────────────────────

def test_list_delegations_status_transition(server, conn):
    # 1. Hub delegates to Alice.
    text, _ = _call(server, "__agent__", "delegate",
                     {"to": "Alice", "task": "task A"})
    delegation_id = int(text.split("#")[1].split()[0])

    # 2. Both 'open' filter and 'any' filter return the row.
    text, err = _call(server, "__agent__", "list_delegations",
                       {"status": "open"})
    assert not err
    rows = json.loads(text)
    assert len(rows) == 1
    assert rows[0]["status"] == "open"
    assert rows[0]["task"] == "task A"

    # 3. Alice replies via send_message in_reply_to.
    text, err = _call(server, "42-fix-auth", "send_message",
                       {"to": "__agent__", "text": "done",
                        "in_reply_to": delegation_id})
    assert not err

    # 4. Same delegation row now resolves as 'resolved' with the
    # reply's text inlined.
    text, _ = _call(server, "__agent__", "list_delegations",
                     {"status": "resolved"})
    rows = json.loads(text)
    assert len(rows) == 1
    assert rows[0]["status"] == "resolved"
    assert rows[0]["resolved_by"] == "42-fix-auth"
    assert rows[0]["reply_text"] == "done"

    # 5. status='open' filter now returns empty.
    text, _ = _call(server, "__agent__", "list_delegations",
                     {"status": "open"})
    assert text == "no delegations"


def test_list_delegations_mine_only_and_to_me(server, conn):
    # Hub delegates two tasks to two different spokes.
    _call(server, "__agent__", "delegate",
          {"to": "Alice", "task": "A"})
    _call(server, "__agent__", "delegate",
          {"to": "DocsBot", "task": "B"})
    # Alice asks for delegations addressed to her.
    text, _ = _call(server, "42-fix-auth", "list_delegations",
                     {"to_me": True})
    rows = json.loads(text)
    assert {r["task"] for r in rows} == {"A"}
    # Hub asks for "mine_only" — returns both since hub sent them.
    text, _ = _call(server, "__agent__", "list_delegations",
                     {"mine_only": True})
    rows = json.loads(text)
    assert {r["task"] for r in rows} == {"A", "B"}


# ── route: substring + regex matching ─────────────────────────────

def test_route_substring_against_id_and_name(server, conn):
    # Pattern 'docs' matches the workspace id "99-docs-cleanup" AND
    # the display name "DocsBot" — same agent either way, so it
    # only gets one message.
    text, err = _call(server, "__agent__", "route",
                       {"pattern": "docs", "text": "publish the README"})
    assert not err
    assert "1 agent" in text and "99-docs-cleanup" in text

    rows = conn.execute(
        "SELECT to_agent, payload FROM agent_messages "
        "WHERE from_agent = '__agent__'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == "99-docs-cleanup"
    payload = json.loads(rows[0][1])
    assert payload["routed"] is True
    assert payload["route_pattern"] == "docs"


def test_route_regex_pattern(server, conn):
    # /^[0-9]+/ matches any workspace whose id starts with digits —
    # all three spokes (42-fix-auth, 99-docs-cleanup, 7-frontend)
    # qualify; the hub is excluded by the "explicit-only" rule.
    text, err = _call(server, "__agent__", "route",
                       {"pattern": "/^[0-9]+/",
                        "text": "ack required"})
    assert not err
    assert "3 agent" in text
    rows = conn.execute(
        "SELECT to_agent FROM agent_messages WHERE from_agent='__agent__'"
    ).fetchall()
    assert {r[0] for r in rows} == {
        "42-fix-auth", "99-docs-cleanup", "7-frontend"}


@pytest.mark.parametrize("pattern", [
    "/(a+)+/", "/(a*)*/", "/(.*)+/", "/(x+)*/", "/(ab+)+/", "/(a+){2,}/",
    "/(a|a)+/",      # alternation explosion
    "/(a|ab)*/",     # alternation explosion
    "/((a)+)+/",     # nested quantified group
    "/(?:a+)+/",     # non-capturing outer group still ReDoS
])
def test_route_rejects_redos_shape(server, conn, pattern):
    # Catastrophic-backtracking shapes are refused before re.compile
    # (py/regex-injection, alert #17) and nothing is queued.
    text, err = _call(server, "__agent__", "route",
                       {"pattern": pattern, "text": "x"})
    assert err
    assert "catastrophic backtracking" in text
    assert conn.execute(
        "SELECT COUNT(*) FROM agent_messages").fetchone()[0] == 0


@pytest.mark.parametrize("pattern", [
    "/(ab)+/",          # single linear group — no inner branching
    "/(?:fix|feat)-/",  # alternation in a NON-quantified group
    "/[a-z]+/",
    "/[A-Z]{3}-\\d+/",
    "/^[0-9]+-/",
    "/docs|core/",
    "/(a+)?/",          # optional, not repeated — bounded
])
def test_route_allows_linear_patterns(server, conn, pattern):
    # Genuinely-linear patterns must pass the ReDoS gate (no false
    # positives) — they may match 0 agents, but must not error.
    text, err = _call(server, "__agent__", "route",
                       {"pattern": pattern, "text": "x"})
    assert not err, text
    assert "catastrophic backtracking" not in text


def test_route_rejects_overlong_regex(server, conn):
    text, err = _call(server, "__agent__", "route",
                       {"pattern": "/" + "a" * 129 + "/", "text": "x"})
    assert err
    assert "too long" in text


def test_route_allows_benign_quantifier(server, conn):
    # A single (non-nested) quantifier is fine — must still route.
    text, err = _call(server, "__agent__", "route",
                       {"pattern": "/^[0-9]+-/", "text": "ok"})
    assert not err
    assert "3 agent" in text


def test_route_no_matches(server, conn):
    text, err = _call(server, "__agent__", "route",
                       {"pattern": "zzz-nothing", "text": "x"})
    assert not err
    assert "no agents matched" in text
    assert conn.execute(
        "SELECT COUNT(*) FROM agent_messages").fetchone()[0] == 0


def test_route_excludes_self_by_default(server, conn):
    # FE Helper routes by its own substring; exclude_self default
    # keeps it out of the recipient list, so we get zero hits.
    text, err = _call(server, "7-frontend", "route",
                       {"pattern": "frontend", "text": "hi me"})
    assert not err
    # Only match would be 7-frontend → self → excluded.
    assert "no agents matched" in text


def test_route_explicit_self_pattern(server, conn):
    # When the user does want to include themselves, they pass
    # exclude_self=False. Verifies the default flips correctly.
    text, err = _call(server, "7-frontend", "route",
                       {"pattern": "frontend", "text": "hi me",
                        "exclude_self": False})
    assert not err
    assert "1 agent" in text and "7-frontend" in text
