"""Agent events table CRUD + pending-count helpers.

Backs `/api/events` and the per-issue 🔔 badge. The `agent_events`
SQLite table is created by the schema in agent_workspace.py
(DB_SCHEMA); this module assumes the table exists and operates on
caller-supplied connections.

Pure DB helpers — no other awlib modules needed.
"""
from __future__ import annotations

import sqlite3
import time


def insert_agent_event(conn: sqlite3.Connection, *, kind: str, issue: str = "",
                       session_id: str = "", message: str = "",
                       cwd: str = "") -> int:
    cur = conn.execute(
        "INSERT INTO agent_events(kind, issue, session_id, message, cwd, created_at, read_at) "
        "VALUES (?,?,?,?,?,?,NULL)",
        (kind, issue or None, session_id or None, message or None,
         cwd or None, int(time.time())),
    )
    conn.commit()
    return cur.lastrowid


def list_agent_events(
    conn: sqlite3.Connection, issue: str | None = None, limit: int = 100,
) -> list[dict]:
    # Secondary sort by id DESC so events that share a created_at second
    # (rapid hooks fire well within 1s of each other) still land in
    # insertion order — newest first.
    if issue:
        rows = conn.execute(
            "SELECT id, kind, issue, session_id, message, cwd, created_at, read_at "
            "FROM agent_events WHERE issue = ? "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (issue, limit)).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, kind, issue, session_id, message, cwd, created_at, read_at "
            "FROM agent_events ORDER BY created_at DESC, id DESC LIMIT ?",
            (limit,)).fetchall()
    return [{
        "id": r[0], "kind": r[1], "issue": r[2], "session_id": r[3],
        "message": r[4] or "", "cwd": r[5] or "",
        "created_at": r[6], "read_at": r[7],
    } for r in rows]


def mark_agent_events_read(
    conn: sqlite3.Connection,
    issue: str | None = None,
    event_id: int | None = None,
) -> int:
    """Mark unread events as read. Scoped (in priority order) to a single
    event by id, then to one issue, otherwise marks every unread event.
    Returns the count updated."""
    now = int(time.time())
    if event_id is not None:
        cur = conn.execute(
            "UPDATE agent_events SET read_at = ? "
            "WHERE id = ? AND read_at IS NULL", (now, event_id))
    elif issue:
        cur = conn.execute(
            "UPDATE agent_events SET read_at = ? "
            "WHERE issue = ? AND read_at IS NULL", (now, issue))
    else:
        cur = conn.execute(
            "UPDATE agent_events SET read_at = ? WHERE read_at IS NULL", (now,))
    conn.commit()
    return cur.rowcount


def delete_agent_event(conn: sqlite3.Connection, event_id: int) -> bool:
    """Delete a single agent event. Returns True if a row was removed."""
    cur = conn.execute(
        "DELETE FROM agent_events WHERE id = ?", (event_id,))
    conn.commit()
    return cur.rowcount > 0


def pending_event_counts(conn: sqlite3.Connection) -> dict[str, int]:
    """{issue: count} of unread agent events, used to badge tabs."""
    rows = conn.execute(
        "SELECT issue, COUNT(*) FROM agent_events "
        "WHERE read_at IS NULL AND issue IS NOT NULL GROUP BY issue"
    ).fetchall()
    return {issue: count for issue, count in rows}


def pending_event_counts_by_kind(conn: sqlite3.Connection
                                  ) -> dict[str, dict[str, int]]:
    """{issue: {kind: count}} of unread agent events. Drives the per-kind
    notification filter in the profile popover."""
    rows = conn.execute(
        "SELECT issue, kind, COUNT(*) FROM agent_events "
        "WHERE read_at IS NULL AND issue IS NOT NULL "
        "GROUP BY issue, kind"
    ).fetchall()
    out: dict[str, dict[str, int]] = {}
    for issue, kind, count in rows:
        out.setdefault(issue, {})[kind] = count
    return out


def ended_session_ids(conn: sqlite3.Connection) -> set[str]:
    """session_ids whose **most recent** event is SessionEnd.

    Claude Code can resume an ended session — the session_id stays the
    same, a fresh SessionStart fires, and the existing jsonl file
    starts being appended again. A simple "any SessionEnd in history"
    check would keep treating that session as ended forever; we want
    "the last thing we heard about this session was SessionEnd"."""
    rows = conn.execute(
        "SELECT session_id, kind FROM agent_events "
        "WHERE session_id IS NOT NULL AND session_id != '' "
        "ORDER BY session_id, created_at DESC"
    ).fetchall()
    last_kind: dict[str, str] = {}
    for sid, kind in rows:
        if sid not in last_kind:    # rows are sorted DESC, first wins
            last_kind[sid] = kind
    return {sid for sid, kind in last_kind.items() if kind == "SessionEnd"}
