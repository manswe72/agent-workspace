"""Notes table CRUD + per-user todo count summary.

The `notes` table is created by the schema in agent_workspace.py
(DB_SCHEMA); this module assumes it exists and operates on
caller-supplied connections. Pure DB helpers — no other awlib
modules needed.

Notes are synced via data/<user-slug>/notes.jsonl, so every note
is scoped to a user_slug. Status is one of NOTE_STATUSES; priority
is one of NOTE_PRIORITIES. Tags are stored as a JSON array of
lowercase strings.
"""
from __future__ import annotations

import json
import sqlite3
import time

NOTE_STATUSES = ("todo", "done", "not_done")
NOTE_PRIORITIES = ("low", "normal", "high")

# Column list used in every SELECT — keep the order stable so the
# row-to-dict mapper below stays correct.
_COLS = (
    "id, issue, content, status, created_at, updated_at, "
    "tags, due_at, priority, assignee, sort_order"
)


def _row_to_dict(r: tuple) -> dict:
    try:
        tags = json.loads(r[6]) if r[6] else []
    except (TypeError, ValueError):
        tags = []
    if not isinstance(tags, list):
        tags = []
    return {
        "id": r[0],
        "issue": r[1],
        "content": r[2],
        "status": r[3],
        "created_at": r[4],
        "updated_at": r[5],
        "tags": tags,
        "due_at": r[7],
        "priority": r[8] or "normal",
        "assignee": r[9],
        "sort_order": r[10],
    }


def _normalize_tags(tags) -> list[str]:
    """Dedupe, strip, lowercase. Drops empty strings. Sorted for
    deterministic JSON output."""
    if tags is None:
        return []
    if not isinstance(tags, list):
        raise ValueError("tags must be a list")
    seen = set()
    out: list[str] = []
    for t in tags:
        s = str(t).strip().lower()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    out.sort()
    return out


def _normalize_assignee(assignee) -> str | None:
    if assignee is None:
        return None
    if not isinstance(assignee, str):
        raise ValueError("assignee must be string or null")
    s = assignee.strip()
    return s if s else None


def list_notes(conn: sqlite3.Connection,
               user_slug: str,
               issue: str | None = None) -> list[dict]:
    """All notes for a user, optionally narrowed to one issue.
    Returned newest-first so the modal renders most-recent at the top.
    Manual reordering is applied client-side when the user picks the
    'manual' sort mode."""
    if issue is not None:
        rows = conn.execute(
            f"SELECT {_COLS} FROM notes WHERE user_slug = ? AND issue = ? "
            "ORDER BY created_at DESC",
            (user_slug, issue)).fetchall()
    else:
        rows = conn.execute(
            f"SELECT {_COLS} FROM notes WHERE user_slug = ? "
            "ORDER BY created_at DESC",
            (user_slug,)).fetchall()
    return [_row_to_dict(r) for r in rows]


def insert_note(conn: sqlite3.Connection,
                user_slug: str, issue: str,
                content: str, status: str,
                *,
                tags: list[str] | None = None,
                due_at: int | None = None,
                priority: str = "normal",
                assignee: str | None = None,
                sort_order: float | None = None) -> int:
    """Add a fresh note. Returns the new id."""
    if status not in NOTE_STATUSES:
        raise ValueError(f"invalid status: {status}")
    if priority not in NOTE_PRIORITIES:
        raise ValueError(f"invalid priority: {priority}")
    if not issue:
        raise ValueError("issue is required")
    if not content.strip():
        raise ValueError("content is required")
    tags_json = json.dumps(_normalize_tags(tags))
    clean_assignee = _normalize_assignee(assignee)
    due_val = int(due_at) if due_at is not None else None
    sort_val = float(sort_order) if sort_order is not None else None
    now = int(time.time())
    cur = conn.execute(
        "INSERT INTO notes(user_slug, issue, content, status, "
        "created_at, updated_at, tags, due_at, priority, assignee, "
        "sort_order) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (user_slug, issue, content, status, now, now,
         tags_json, due_val, priority, clean_assignee, sort_val))
    conn.commit()
    return cur.lastrowid


# Sentinel for update_note: lets callers say "leave this field alone"
# distinctly from "set this nullable field to NULL".
_UNSET = object()


def update_note(conn: sqlite3.Connection,
                user_slug: str, note_id: int,
                *,
                content=_UNSET,
                status=_UNSET,
                tags=_UNSET,
                due_at=_UNSET,
                priority=_UNSET,
                assignee=_UNSET,
                sort_order=_UNSET) -> bool:
    """Patch any subset of a note's fields. Pass only the fields you
    want to change; nullable fields accept None to clear the value.
    Returns False if the note doesn't belong to the user (so 404 stays
    a 404 in the API)."""
    row = conn.execute(
        "SELECT id FROM notes WHERE id = ? AND user_slug = ?",
        (note_id, user_slug)).fetchone()
    if not row:
        return False
    fields, params = [], []
    if content is not _UNSET:
        if not str(content).strip():
            raise ValueError("content cannot be empty")
        fields.append("content = ?")
        params.append(content)
    if status is not _UNSET:
        if status not in NOTE_STATUSES:
            raise ValueError(f"invalid status: {status}")
        fields.append("status = ?")
        params.append(status)
    if tags is not _UNSET:
        fields.append("tags = ?")
        params.append(json.dumps(_normalize_tags(tags)))
    if due_at is not _UNSET:
        if due_at is not None and not isinstance(due_at, (int, float)):
            raise ValueError("due_at must be int unix timestamp or null")
        fields.append("due_at = ?")
        params.append(int(due_at) if due_at is not None else None)
    if priority is not _UNSET:
        if priority not in NOTE_PRIORITIES:
            raise ValueError(f"invalid priority: {priority}")
        fields.append("priority = ?")
        params.append(priority)
    if assignee is not _UNSET:
        fields.append("assignee = ?")
        params.append(_normalize_assignee(assignee))
    if sort_order is not _UNSET:
        if sort_order is not None and not isinstance(sort_order, (int, float)):
            raise ValueError("sort_order must be number or null")
        fields.append("sort_order = ?")
        params.append(float(sort_order) if sort_order is not None else None)
    if not fields:
        return True
    fields.append("updated_at = ?")
    params.append(int(time.time()))
    params.extend([note_id, user_slug])
    conn.execute(
        f"UPDATE notes SET {', '.join(fields)} "
        "WHERE id = ? AND user_slug = ?",
        params)
    conn.commit()
    return True


def delete_note(conn: sqlite3.Connection,
                user_slug: str, note_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM notes WHERE id = ? AND user_slug = ?",
        (note_id, user_slug))
    conn.commit()
    return cur.rowcount > 0


def todo_counts_by_issue(conn: sqlite3.Connection,
                          user_slug: str) -> dict[str, int]:
    """{issue: count} of notes whose status is 'todo'. Drives the
    per-tab badge so the user can see at a glance which issues have
    pending work-items."""
    rows = conn.execute(
        "SELECT issue, COUNT(*) FROM notes "
        "WHERE user_slug = ? AND status = 'todo' GROUP BY issue",
        (user_slug,)).fetchall()
    return {issue: count for issue, count in rows}
