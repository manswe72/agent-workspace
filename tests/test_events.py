"""Tests for agent_events helpers: insert / list / mark-read / counts."""
from __future__ import annotations

import tempfile

import agent_workspace as cw


def test_insert_agent_event_returns_id(tmp_db):
    eid = cw.insert_agent_event(
        tmp_db, kind="Notification", issue="ws-1",
        session_id="s1", message="hi", cwd=tempfile.gettempdir())
    assert isinstance(eid, int) and eid > 0


def test_pending_event_counts_groups_by_issue(tmp_db):
    cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    cw.insert_agent_event(tmp_db, kind="Notification", issue="B")
    cw.insert_agent_event(tmp_db, kind="Notification")  # no issue → ignored
    assert cw.pending_event_counts(tmp_db) == {"A": 2, "B": 1}


def test_pending_event_counts_by_kind_nested(tmp_db):
    cw.insert_agent_event(tmp_db, kind="Stop",         issue="A")
    cw.insert_agent_event(tmp_db, kind="Stop",         issue="A")
    cw.insert_agent_event(tmp_db, kind="Notification", issue="A")
    cw.insert_agent_event(tmp_db, kind="Stop",         issue="B")
    out = cw.pending_event_counts_by_kind(tmp_db)
    assert out == {
        "A": {"Stop": 2, "Notification": 1},
        "B": {"Stop": 1},
    }


def test_mark_agent_events_read_by_id_only_one(tmp_db):
    a = cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    n = cw.mark_agent_events_read(tmp_db, event_id=a)
    assert n == 1
    assert cw.pending_event_counts(tmp_db) == {"A": 1}


def test_mark_agent_events_read_by_issue(tmp_db):
    cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    cw.insert_agent_event(tmp_db, kind="Stop", issue="B")
    n = cw.mark_agent_events_read(tmp_db, issue="A")
    assert n == 1
    assert cw.pending_event_counts(tmp_db) == {"B": 1}


def test_mark_agent_events_read_all(tmp_db):
    cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    cw.insert_agent_event(tmp_db, kind="Stop", issue="B")
    cw.insert_agent_event(tmp_db, kind="Stop", issue="C")
    n = cw.mark_agent_events_read(tmp_db)
    assert n == 3
    assert cw.pending_event_counts(tmp_db) == {}


def test_mark_already_read_returns_zero(tmp_db):
    eid = cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    cw.mark_agent_events_read(tmp_db, event_id=eid)
    # Second call: nothing left to update.
    assert cw.mark_agent_events_read(tmp_db, event_id=eid) == 0


def test_list_agent_events_orders_newest_first(tmp_db):
    a = cw.insert_agent_event(tmp_db, kind="Stop", issue="A", message="first")
    b = cw.insert_agent_event(tmp_db, kind="Stop", issue="A", message="second")
    c = cw.insert_agent_event(tmp_db, kind="Stop", issue="A", message="third")
    rows = cw.list_agent_events(tmp_db, issue="A")
    assert [r["id"] for r in rows] == [c, b, a]


def test_delete_agent_event(tmp_db):
    eid = cw.insert_agent_event(tmp_db, kind="Stop", issue="A")
    assert cw.delete_agent_event(tmp_db, eid) is True
    # Second delete reports nothing removed.
    assert cw.delete_agent_event(tmp_db, eid) is False
    assert cw.pending_event_counts(tmp_db) == {}
