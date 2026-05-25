"""Agent-to-agent messaging — MCP server backed by SQLite.

Hosts an in-process Model Context Protocol server (JSON-RPC 2.0 over
HTTP) so the dashboard's agents can leave each other messages. The
HTTP transport lives in `agent_workspace.py`; this module is the
dispatcher + tool implementations + the `agent_messages` table.

Three tools are exposed to claude:

    send_message(to: str, text: str)
        Generic mail. Sender identity is the URL ?agent=<id>.

    read_messages(unread_only: bool = true)
        Returns the calling agent's inbox as a JSON list. Marks each
        returned row read_at = now() so the next call doesn't
        re-deliver them.

    request_review(target: str, ref: str, context: str = "")
        Convenience wrapper that writes a kind='review_request'
        message with structured payload. Recipient reads it via
        read_messages and replies via send_message.

Schema for `agent_messages` is created idempotently by init_db()
which the dashboard calls from its startup migration block.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time

# ── Schema ────────────────────────────────────────────────────────────────

# Table-only DDL — runs first. Indexes are created in init_db AFTER
# the per-column migration below, otherwise an old DB that already
# has the table (without `in_reply_to`) would fail on the index DDL
# before the ALTER TABLE has a chance to add the column.
_SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_messages (
  id          INTEGER PRIMARY KEY,
  from_agent  TEXT NOT NULL,          -- issue key or '__agent__'
  to_agent    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'message' | 'review_request'
                                       --          | 'review_response'
  payload     TEXT NOT NULL,          -- JSON: {text, ref?, context?}
  created_at  INTEGER NOT NULL,
  read_at     INTEGER,                -- NULL = unread
  in_reply_to INTEGER                 -- agent_messages.id this replies to
);
"""

_SCHEMA_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_agent_messages_to_unread
  ON agent_messages(to_agent, read_at);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from
  ON agent_messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_agent_messages_in_reply_to
  ON agent_messages(in_reply_to);
"""


def init_db(conn: sqlite3.Connection) -> None:
    """Create the agent_messages table + indexes if they don't exist.

    Idempotent; safe to call on every startup. Also migrates older
    databases that pre-date the `in_reply_to` column.
    """
    conn.executescript(_SCHEMA)
    cols = {r[1] for r in conn.execute(
        "PRAGMA table_info(agent_messages)").fetchall()}
    if "in_reply_to" not in cols:
        conn.execute("ALTER TABLE agent_messages "
                     "ADD COLUMN in_reply_to INTEGER")
    # Indexes go last so the one over in_reply_to never tries to
    # reference a column the migration hasn't added yet.
    conn.executescript(_SCHEMA_INDEXES)
    conn.commit()


# ── Storage helpers ───────────────────────────────────────────────────────

VALID_KINDS = ("message", "review_request", "review_response", "delegation")


def list_delegations(conn: sqlite3.Connection,
                      from_agent: str | None = None,
                      to_agent: str | None = None,
                      status: str = "any",
                      limit: int = 100) -> list[dict]:
    """Return delegation rows + their resolution state.

    A delegation is open until the recipient replies (any agent_messages
    row whose in_reply_to points at the delegation). The first such
    reply resolves it; the resolver's id + summary text are returned
    inline so callers don't need a second query to render a status
    board.

    Filters:
      from_agent — only delegations sent by this agent (the hub).
      to_agent   — only delegations addressed to this agent (a spoke).
      status     — 'open' | 'resolved' | 'any' (default 'any').
    """
    where = ["d.kind = 'delegation'"]
    params: list = []
    if from_agent:
        where.append("d.from_agent = ?")
        params.append(from_agent)
    if to_agent:
        where.append("d.to_agent = ?")
        params.append(to_agent)
    sql = (
        "SELECT d.id, d.from_agent, d.to_agent, d.payload, d.created_at, "
        "       r.id AS reply_id, r.from_agent AS reply_from, "
        "       r.payload AS reply_payload, r.created_at AS reply_at "
        "FROM agent_messages d "
        "LEFT JOIN agent_messages r "
        "       ON r.in_reply_to = d.id "
        "WHERE " + " AND ".join(where)
        + " ORDER BY d.created_at DESC LIMIT ?"
    )
    params.append(int(limit))
    out: list[dict] = []
    for row in conn.execute(sql, params).fetchall():
        try:
            payload = json.loads(row[3])
        except (TypeError, ValueError, json.JSONDecodeError):
            payload = {"text": row[3] or ""}
        item = {
            "id":         row[0],
            "from_agent": row[1],
            "to_agent":   row[2],
            "task":       payload.get("task") or payload.get("text") or "",
            "context":    payload.get("context") or "",
            "deadline":   payload.get("deadline") or "",
            "created_at": row[4],
            "status":     "open",
            "resolved_by": None,
            "resolved_at": None,
            "reply_id":    None,
            "reply_text":  "",
        }
        if row[5] is not None:
            try:
                reply_payload = json.loads(row[7] or "{}")
            except (TypeError, ValueError, json.JSONDecodeError):
                reply_payload = {"text": row[7] or ""}
            item.update({
                "status":      "resolved",
                "resolved_by": row[6],
                "resolved_at": row[8],
                "reply_id":    row[5],
                "reply_text":  reply_payload.get("text") or "",
            })
        if status == "open" and item["status"] != "open":
            continue
        if status == "resolved" and item["status"] != "resolved":
            continue
        out.append(item)
    return out


def send_message(conn: sqlite3.Connection,
                  from_agent: str,
                  to_agent: str,
                  kind: str,
                  payload: dict,
                  in_reply_to: int | None = None) -> int:
    """Insert one row. Returns the new id. `in_reply_to` chains
    this row to a previous agent_messages.id so the dashboard can
    render the conversation thread."""
    if kind not in VALID_KINDS:
        raise ValueError(f"unknown kind: {kind}")
    if not from_agent or not to_agent:
        raise ValueError("from_agent and to_agent are required")
    now = int(time.time())
    cur = conn.execute(
        "INSERT INTO agent_messages "
        "(from_agent, to_agent, kind, payload, created_at, in_reply_to) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (from_agent, to_agent, kind, json.dumps(payload, default=str),
         now, int(in_reply_to) if in_reply_to else None),
    )
    conn.commit()
    return int(cur.lastrowid)


def read_messages(conn: sqlite3.Connection,
                   agent: str,
                   unread_only: bool = True,
                   mark_read: bool = True,
                   limit: int = 100) -> list[dict]:
    """Return the agent's inbox. When mark_read=True, each returned
    row gets read_at set so subsequent calls don't redeliver them.
    """
    if not agent:
        return []
    where = ["to_agent = ?"]
    params: list = [agent]
    if unread_only:
        where.append("read_at IS NULL")
    rows = conn.execute(
        f"SELECT id, from_agent, kind, payload, created_at, read_at, "
        f"       in_reply_to "
        f"FROM agent_messages WHERE {' AND '.join(where)} "
        f"ORDER BY created_at ASC LIMIT ?",
        (*params, limit),
    ).fetchall()
    out: list[dict] = []
    ids_to_mark: list[int] = []
    for r in rows:
        try:
            payload = json.loads(r[3])
        except (TypeError, ValueError):
            payload = {"text": r[3]}
        out.append({
            "id": r[0],
            "from": r[1],
            "kind": r[2],
            "payload": payload,
            "created_at": r[4],
            "read_at": r[5],
            "in_reply_to": r[6],
        })
        if mark_read and r[5] is None:
            ids_to_mark.append(r[0])
    if ids_to_mark:
        now = int(time.time())
        # Use executemany so a single transaction marks the lot.
        conn.executemany(
            "UPDATE agent_messages SET read_at = ? WHERE id = ?",
            [(now, i) for i in ids_to_mark],
        )
        conn.commit()
    return out


def list_thread(conn: sqlite3.Connection,
                 agent: str,
                 limit: int = 200) -> list[dict]:
    """Combined view: every message where this agent is either the
    sender or the recipient, oldest-first so the dashboard can
    render a chronological thread with reply indents."""
    if not agent:
        return []
    rows = conn.execute(
        "SELECT id, from_agent, to_agent, kind, payload, "
        "       created_at, read_at, in_reply_to "
        "FROM agent_messages "
        "WHERE from_agent = ? OR to_agent = ? "
        "ORDER BY created_at ASC LIMIT ?",
        (agent, agent, limit),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        try:
            payload = json.loads(r[4])
        except (TypeError, ValueError):
            payload = {"text": r[4]}
        out.append({
            "id": r[0],
            "from": r[1],
            "to": r[2],
            "kind": r[3],
            "payload": payload,
            "created_at": r[5],
            "read_at": r[6],
            "in_reply_to": r[7],
        })
    return out


def list_outbox(conn: sqlite3.Connection,
                 agent: str,
                 limit: int = 100) -> list[dict]:
    """Sent messages from this agent, newest first. Used by the
    dashboard's Messages sub-tab — never marks anything read."""
    if not agent:
        return []
    rows = conn.execute(
        "SELECT id, to_agent, kind, payload, created_at, read_at, "
        "       in_reply_to "
        "FROM agent_messages WHERE from_agent = ? "
        "ORDER BY created_at DESC LIMIT ?",
        (agent, limit),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        try:
            payload = json.loads(r[3])
        except (TypeError, ValueError):
            payload = {"text": r[3]}
        out.append({
            "id": r[0],
            "to": r[1],
            "kind": r[2],
            "payload": payload,
            "created_at": r[4],
            "read_at": r[5],
            "in_reply_to": r[6],
        })
    return out


def delete_message(conn: sqlite3.Connection, message_id: int) -> bool:
    """Hard-delete one message row. Returns True if a row was
    removed. Used by the dashboard's per-row ✕ button — the
    deletion is not undoable.
    """
    cur = conn.execute(
        "DELETE FROM agent_messages WHERE id = ?", (int(message_id),))
    conn.commit()
    return cur.rowcount > 0


def delete_thread(conn: sqlite3.Connection, message_id: int) -> int:
    """Hard-delete every message in the same in_reply_to chain as
    `message_id`. Walks up to the root (in_reply_to is NULL or
    points outside the chain), then walks down through every
    descendant via in_reply_to, then deletes the whole set in one
    transaction. Returns the row count.
    """
    msg_id = int(message_id)
    # Walk up to the root.
    cur_id: int | None = msg_id
    seen: set[int] = set()
    root = msg_id
    while cur_id is not None and cur_id not in seen:
        seen.add(cur_id)
        row = conn.execute(
            "SELECT in_reply_to FROM agent_messages WHERE id = ?",
            (cur_id,),
        ).fetchone()
        if row is None:
            break
        parent = row[0]
        if parent is None:
            root = cur_id
            break
        cur_id = int(parent)
        root = cur_id
    # Walk down from the root collecting descendants (BFS).
    to_visit: list[int] = [root]
    targets: set[int] = set()
    while to_visit:
        n = to_visit.pop()
        if n in targets:
            continue
        targets.add(n)
        kids = conn.execute(
            "SELECT id FROM agent_messages WHERE in_reply_to = ?",
            (n,),
        ).fetchall()
        for (kid_id,) in kids:
            if kid_id not in targets:
                to_visit.append(int(kid_id))
    if not targets:
        return 0
    placeholders = ",".join("?" * len(targets))
    cur = conn.execute(
        f"DELETE FROM agent_messages WHERE id IN ({placeholders})",
        tuple(targets),
    )
    conn.commit()
    return cur.rowcount


def delete_all_messages(conn: sqlite3.Connection, agent: str) -> int:
    """Hard-delete every message visible to `agent` — those addressed
    to it (inbox) and those sent by it (outbox). Returns deleted count."""
    cur = conn.execute(
        "DELETE FROM agent_messages WHERE from_agent = ? OR to_agent = ?",
        (agent, agent),
    )
    conn.commit()
    return cur.rowcount


def unread_counts(conn: sqlite3.Connection) -> dict[str, int]:
    """Map of agent → count of unread messages addressed to it.
    Used to attach badge counts in gather_all()."""
    rows = conn.execute(
        "SELECT to_agent, COUNT(*) FROM agent_messages "
        "WHERE read_at IS NULL GROUP BY to_agent"
    ).fetchall()
    return {r[0]: int(r[1]) for r in rows}


# ── JSON-RPC 2.0 dispatcher ───────────────────────────────────────────────

# MCP server descriptor — claude reads this during initialize.
SERVER_INFO = {
    "name": "Agentic Engineering MCP",
    "version": "0.1.0",
}

# Slug used as the key under `mcpServers` in each agent's
# --mcp-config file AND as the prefix in claude's --allowedTools
# permission rule (`mcp__<slug>`). Keep these in sync: if you
# rename the slug here, every agent's settings.json claude wrote
# during a previous run will keep the old name in its permission
# allow-list, which is fine but means the rename only takes
# effect on fresh sessions.
SERVER_SLUG = "agentic-engineering"

# Tool list. Each entry follows MCP's tools/list schema. Inputs use
# JSON-Schema. claude reads `description` to decide when to call;
# keep it short, action-oriented.
TOOLS = [
    {
        "name": "send_message",
        "description": (
            "Send a message to another agent on this dashboard. "
            "The recipient is identified by its issue key (e.g. "
            "'42-fix-auth') or the sentinel '__agent__' for the "
            "General Agent. When replying to a message from "
            "read_messages, pass that message's `id` as "
            "`in_reply_to` so the dashboard threads your reply "
            "underneath the original."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {"type": "string",
                        "description": "Recipient agent id."},
                "text": {"type": "string",
                          "description": "Message body."},
                "in_reply_to": {"type": "integer",
                                 "description": ("Optional id of the "
                                                  "message you are "
                                                  "replying to.")},
            },
            "required": ["to", "text"],
        },
    },
    {
        "name": "read_messages",
        "description": (
            "Read this agent's inbox. Returns a JSON list of "
            "messages addressed to me. By default returns only "
            "unread messages and marks them read. Pass "
            "unread_only=false to see history too."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "unread_only": {"type": "boolean", "default": True},
                "limit": {"type": "integer", "default": 50,
                           "minimum": 1, "maximum": 200},
            },
        },
    },
    {
        "name": "request_review",
        "description": (
            "Ask another agent (typically '__agent__', the General "
            "Agent) to review some work. The `ref` is usually a "
            "git commit sha, branch, or file path the reviewer can "
            "inspect; `context` is free-form text explaining what "
            "to focus on."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {"type": "string",
                            "description": "Reviewer agent id."},
                "ref": {"type": "string",
                         "description": ("Git commit sha, branch, "
                                          "or file path to review.")},
                "context": {"type": "string",
                             "description": "What to focus on.",
                             "default": ""},
            },
            "required": ["target", "ref"],
        },
    },
    {
        "name": "broadcast_message",
        "description": (
            "Send the same message to every issue agent that has a "
            "live terminal on the dashboard right now. The General "
            "Agent ('__agent__') is excluded — broadcasts are for "
            "fanning information out to per-issue workers, not "
            "echoing back to yourself."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string",
                          "description": "Message body."},
            },
            "required": ["text"],
        },
    },
    {
        "name": "list_agents",
        "description": (
            "List every agent the dashboard currently knows about: "
            "each workspace under the worktrees root plus the pinned "
            "General Agent ('__agent__'). Each entry includes the "
            "canonical id, an optional human-friendly display name "
            "(when the user set one), and a session state of "
            "'active', 'idle', or 'closed' based on the launcher's "
            "marker / session log. Useful before send_message so you "
            "can pick a recipient that's actually online."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "live_only": {"type": "boolean",
                               "description":
                                  "Skip closed agents. Default false."},
            },
        },
    },
    {
        "name": "delegate",
        "description": (
            "Hub-only. As the General Agent ('__agent__'), hand a "
            "task to a specific spoke agent and track its completion. "
            "Delegations are first-class in the dashboard: they "
            "appear on a Delegations board until the recipient "
            "replies (via `send_message` with `in_reply_to` set to "
            "the delegation id), which marks them resolved. Use this "
            "instead of `send_message` when you're parcelling out "
            "work you actually expect to get an answer back on."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "to":       {"type": "string",
                              "description":
                                "Recipient agent id (workspace id or "
                                "display name)."},
                "task":     {"type": "string",
                              "description":
                                "Short one-line task description."},
                "context":  {"type": "string",
                              "description":
                                "Longer context, hints, links — "
                                "everything the worker needs to "
                                "actually do it.",
                              "default": ""},
                "deadline": {"type": "string",
                              "description":
                                "Optional free-form deadline string "
                                "('EOD', 'tomorrow', '2026-12-01'). "
                                "Stored as-is.",
                              "default": ""},
            },
            "required": ["to", "task"],
        },
    },
    {
        "name": "route",
        "description": (
            "Fan a message out to every agent whose canonical id OR "
            "display name matches a substring/regex pattern. The "
            "General Agent ('__agent__') is excluded unless the "
            "pattern explicitly matches it. Useful when you don't "
            "know the exact recipient id but know a tag/role/team "
            "you've baked into your workspace names — e.g. "
            "`route(pattern='docs', text='...')` reaches every "
            "workspace whose name contains 'docs'. Returns the "
            "number of recipients + their ids so the sender knows "
            "the message landed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string",
                             "description":
                               "Substring or /regex/ pattern. "
                               "Matched against canonical id AND "
                               "display name."},
                "text":    {"type": "string",
                             "description": "Message body."},
                "exclude_self": {"type": "boolean",
                                   "description":
                                     "Skip the caller. Default true.",
                                   "default": True},
            },
            "required": ["pattern", "text"],
        },
    },
    {
        "name": "list_delegations",
        "description": (
            "Return current and historical delegations. By default "
            "shows every delegation visible on this dashboard "
            "(useful for the General Agent as a status board); "
            "narrow with the filters below. A delegation is 'open' "
            "until the recipient replies; the first reply resolves "
            "it. Returns JSON: id, from_agent, to_agent, task, "
            "context, deadline, status, resolved_by, resolved_at, "
            "reply_text, etc."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "status":   {"type": "string",
                              "enum": ["open", "resolved", "any"],
                              "default": "any"},
                "mine_only":{"type": "boolean",
                              "description":
                                "Only delegations I sent. Default "
                                "false (show everyone's).",
                              "default": False},
                "to_me":    {"type": "boolean",
                              "description":
                                "Only delegations addressed to me. "
                                "Default false.",
                              "default": False},
                "limit":    {"type": "integer",
                              "default": 50, "minimum": 1,
                              "maximum": 200},
            },
        },
    },
]


# Protocol version we advertise; claude-cli checks this during
# initialize and falls back gracefully if mismatched.
PROTOCOL_VERSION = "2024-11-05"


class McpServer:
    """JSON-RPC 2.0 dispatcher. Statless; every dispatch call takes
    the calling agent's id (pulled from the URL ?agent= by the HTTP
    handler in agent_workspace.py) and a connection-factory so the
    server doesn't hold its own sqlite handle.

    Two optional callbacks let the HTTP layer share what it knows
    about agents without this module importing agent_workspace:

      known_agents() → set[str]   — every recognised id; used by
                                     send_message to reject typos /
                                     non-existent recipients.
      live_agents()  → list[str]  — agents with an active pty;
                                     used by broadcast_message to
                                     pick recipients.

    Both default to "accept anything / no-one" so existing callers
    (the smoke tests) don't break.
    """

    def __init__(self, db_connect, *,
                  known_agents=None, live_agents=None,
                  agents_info=None, resolve_alias=None):
        # db_connect: zero-arg callable that returns a fresh
        # sqlite3.Connection. The handler closes it after each call.
        # agents_info() → list of {id, name, state} dicts powering
        #   the list_agents MCP tool.
        # resolve_alias(name) → canonical id, or None. Lets agents
        #   address each other by friendly display name (set in the
        #   dashboard's workspace-names pref).
        self._db = db_connect
        self._known_agents = known_agents
        self._live_agents = live_agents or (lambda: [])
        self._agents_info = agents_info or (lambda: [])
        self._resolve_alias = resolve_alias or (lambda _name: None)

    def dispatch(self, agent: str, req: dict) -> dict:
        """Handle one JSON-RPC request. Returns the response object.

        Always returns a result-shaped dict (with `jsonrpc`, `id`,
        and either `result` or `error`). The HTTP handler just
        json.dumps and sends back.
        """
        rpc_id = req.get("id")
        method = req.get("method") or ""
        params = req.get("params") or {}
        try:
            if method == "initialize":
                return self._ok(rpc_id, {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                })
            if method == "notifications/initialized":
                # Notifications carry no id and want no response.
                return None
            if method == "tools/list":
                return self._ok(rpc_id, {"tools": TOOLS})
            if method == "tools/call":
                return self._handle_tool_call(agent, rpc_id, params)
            return self._err(rpc_id, -32601, f"method not found: {method}")
        except Exception as ex:  # noqa: BLE001
            return self._err(rpc_id, -32603, f"internal error: {ex}")

    # ── tool/call routing ────────────────────────────────────────

    def _handle_tool_call(self, agent: str, rpc_id, params: dict) -> dict:
        name = params.get("name") or ""
        args = params.get("arguments") or {}
        if not agent:
            return self._err(rpc_id, -32602,
                              "missing agent id (URL ?agent=…)")
        try:
            if name == "send_message":
                text = self._tool_send_message(agent, args)
            elif name == "read_messages":
                text = self._tool_read_messages(agent, args)
            elif name == "request_review":
                text = self._tool_request_review(agent, args)
            elif name == "broadcast_message":
                text = self._tool_broadcast_message(agent, args)
            elif name == "list_agents":
                text = self._tool_list_agents(args)
            elif name == "delegate":
                text = self._tool_delegate(agent, args)
            elif name == "route":
                text = self._tool_route(agent, args)
            elif name == "list_delegations":
                text = self._tool_list_delegations(agent, args)
            else:
                return self._err(rpc_id, -32602, f"unknown tool: {name}")
        except ValueError as ex:
            # Surface validation errors as a tool error block so
            # claude sees a useful message instead of a JSON-RPC
            # framing error.
            return self._ok(rpc_id, {
                "content": [{"type": "text",
                              "text": f"error: {ex}"}],
                "isError": True,
            })
        return self._ok(rpc_id, {
            "content": [{"type": "text", "text": text}],
        })

    def _resolve_recipient(self, to: str) -> str:
        """Canonical-ID resolution: agents can address each other by
        the workspace id (`1-fix-auth`) OR a custom display name set
        in the dashboard's `workspace-names` preference (`Alice`).
        Returns the canonical id used for DB inserts. Raises
        ValueError on typos / dead recipients.
        """
        if self._known_agents is None:
            return to  # smoke-test mode — fall open
        try:
            known = self._known_agents()
        except Exception:  # noqa: BLE001 — never crash the dispatcher
            return to
        if to in known:
            return to
        try:
            alias = self._resolve_alias(to)
        except Exception:  # noqa: BLE001
            alias = None
        if alias and alias in known:
            return alias
        sample = sorted(known)
        if len(sample) > 6:
            sample = sample[:6] + ["…"]
        raise ValueError(
            f"unknown agent: {to!r}. Known: {', '.join(sample)}")

    def _tool_send_message(self, agent: str, args: dict) -> str:
        to = (args.get("to") or "").strip()
        text = (args.get("text") or "").strip()
        in_reply_to = args.get("in_reply_to")
        if not to:
            raise ValueError("missing `to`")
        if not text:
            raise ValueError("missing `text`")
        if in_reply_to is not None:
            try:
                in_reply_to = int(in_reply_to)
            except (TypeError, ValueError) as ex:
                raise ValueError(
                    "`in_reply_to` must be an integer id") from ex
        canonical = self._resolve_recipient(to)
        conn = self._db()
        try:
            mid = send_message(conn, agent, canonical, "message",
                                {"text": text},
                                in_reply_to=in_reply_to)
        finally:
            conn.close()
        suffix = "" if canonical == to else f" ({canonical!r})"
        if in_reply_to:
            return (f"sent message #{mid} to {to}{suffix} "
                    f"(reply to #{in_reply_to})")
        return f"sent message #{mid} to {to}{suffix}"

    def _tool_broadcast_message(self, agent: str, args: dict) -> str:
        """Send `text` to every live agent except the General Agent
        (and the sender). Returns a count + the recipient list so the
        caller knows who got it."""
        text = (args.get("text") or "").strip()
        if not text:
            raise ValueError("missing `text`")
        try:
            recipients = list(self._live_agents() or [])
        except Exception:  # noqa: BLE001
            recipients = []
        recipients = [r for r in recipients
                      if r and r != "__agent__" and r != agent]
        if not recipients:
            return "no live issue agents to broadcast to"
        conn = self._db()
        try:
            ids: list[int] = []
            for to in recipients:
                mid = send_message(conn, agent, to, "message",
                                    {"text": text, "broadcast": True})
                ids.append(mid)
        finally:
            conn.close()
        return (f"broadcast to {len(ids)} agent(s): "
                f"{', '.join(recipients)} (ids: "
                f"{', '.join(f'#{i}' for i in ids)})")

    def _tool_read_messages(self, agent: str, args: dict) -> str:
        unread_only = bool(args.get("unread_only", True))
        limit = int(args.get("limit", 50))
        conn = self._db()
        try:
            msgs = read_messages(conn, agent,
                                  unread_only=unread_only,
                                  mark_read=True,
                                  limit=limit)
        finally:
            conn.close()
        if not msgs:
            return ("no new messages" if unread_only
                    else "no messages")
        # Return as JSON so claude can parse without extra prompting.
        return json.dumps(msgs, indent=2, default=str)

    def _tool_request_review(self, agent: str, args: dict) -> str:
        target = (args.get("target") or "").strip()
        ref = (args.get("ref") or "").strip()
        context = (args.get("context") or "").strip()
        if not target:
            raise ValueError("missing `target`")
        if not ref:
            raise ValueError("missing `ref`")
        canonical = self._resolve_recipient(target)
        conn = self._db()
        try:
            mid = send_message(conn, agent, canonical, "review_request",
                                {"ref": ref, "context": context,
                                 "text": (f"Please review {ref}"
                                          + (f" — {context}" if context
                                             else ""))})
        finally:
            conn.close()
        return f"sent review_request #{mid} to {target} for ref={ref}"

    def _tool_list_agents(self, args: dict) -> str:
        live_only = bool(args.get("live_only", False))
        try:
            agents = self._agents_info()
        except Exception as ex:  # noqa: BLE001
            raise ValueError(f"could not enumerate agents: {ex}") from ex
        if live_only:
            agents = [a for a in agents if a.get("state") == "active"]
        if not agents:
            return "no agents"
        return json.dumps(agents, indent=2, default=str)

    # ── hub-and-spoke tools ─────────────────────────────────────

    def _tool_delegate(self, agent: str, args: dict) -> str:
        """Hub-only handoff. Only the General Agent ('__agent__')
        can call this — spokes use `send_message` instead. Creates
        a kind='delegation' row that the dashboard surfaces on a
        Delegations board until the recipient replies."""
        if agent != "__agent__":
            raise ValueError(
                "delegate is hub-only — only the General Agent "
                "('__agent__') can call it. Spoke agents use "
                "`send_message` for non-tracked communication.")
        to = (args.get("to") or "").strip()
        task = (args.get("task") or "").strip()
        context = (args.get("context") or "").strip()
        deadline = (args.get("deadline") or "").strip()
        if not to:
            raise ValueError("missing `to`")
        if not task:
            raise ValueError("missing `task`")
        canonical = self._resolve_recipient(to)
        if canonical == "__agent__":
            raise ValueError(
                "can't delegate to the General Agent itself")
        payload = {"task": task, "context": context}
        if deadline:
            payload["deadline"] = deadline
        # Build a richer `text` field so the recipient's
        # read_messages sees a useful summary without needing to
        # parse the structured fields.
        text_lines = [f"📋 Delegation: {task}"]
        if context:
            text_lines.append("")
            text_lines.append(context)
        if deadline:
            text_lines.append("")
            text_lines.append(f"Deadline: {deadline}")
        text_lines.append("")
        text_lines.append(
            "(Reply to this message — set in_reply_to=<this id> on "
            "your send_message call — to mark the delegation done.)")
        payload["text"] = "\n".join(text_lines)
        conn = self._db()
        try:
            mid = send_message(conn, agent, canonical, "delegation",
                                payload)
        finally:
            conn.close()
        suffix = "" if canonical == to else f" ({canonical!r})"
        return (f"delegated #{mid} to {to}{suffix}: {task!r}")

    def _tool_route(self, agent: str, args: dict) -> str:
        """Fan a message out to every agent whose canonical id OR
        display name matches a substring or /regex/ pattern. Hub-
        agnostic — any agent can call this, but the prototypical
        use is the hub addressing a role-tagged subset of spokes."""
        pattern = (args.get("pattern") or "").strip()
        text = (args.get("text") or "").strip()
        exclude_self = bool(args.get("exclude_self", True))
        if not pattern:
            raise ValueError("missing `pattern`")
        if not text:
            raise ValueError("missing `text`")
        # /…/ syntax → regex; bare string → case-insensitive substring.
        regex = None
        if len(pattern) >= 2 and pattern[0] == "/" and pattern[-1] == "/":
            try:
                regex = re.compile(pattern[1:-1], re.IGNORECASE)
            except re.error as ex:
                raise ValueError(f"bad regex: {ex}") from ex
        try:
            agents = self._agents_info()
        except Exception as ex:  # noqa: BLE001
            raise ValueError(f"could not enumerate agents: {ex}") from ex
        recipients: list[str] = []
        for a in agents:
            aid = a.get("id") or ""
            name = a.get("name") or ""
            # The hub itself is only matched when the pattern is
            # explicit about it; bare 'docs' shouldn't grab Agent 007.
            if aid == "__agent__" and pattern.lower() not in (
                    "__agent__", "agent", "agent 007", "general"):
                if not (regex and (regex.search(aid)
                                    or regex.search(name))):
                    continue
            haystack = f"{aid}\x00{name}".lower()
            matched = (
                regex.search(aid) or regex.search(name)
                if regex else (pattern.lower() in haystack)
            )
            if matched:
                recipients.append(aid)
        if exclude_self:
            recipients = [r for r in recipients if r != agent]
        if not recipients:
            return (f"no agents matched pattern {pattern!r} "
                    f"(searched id + display name)")
        conn = self._db()
        try:
            ids: list[int] = []
            for to in recipients:
                mid = send_message(conn, agent, to, "message",
                                    {"text": text, "routed": True,
                                     "route_pattern": pattern})
                ids.append(mid)
        finally:
            conn.close()
        return (f"routed to {len(ids)} agent(s) matching "
                f"{pattern!r}: {', '.join(recipients)} (ids: "
                f"{', '.join(f'#{i}' for i in ids)})")

    def _tool_list_delegations(self, agent: str, args: dict) -> str:
        status = (args.get("status") or "any").lower()
        if status not in ("open", "resolved", "any"):
            raise ValueError(
                "`status` must be one of: open, resolved, any")
        mine_only = bool(args.get("mine_only", False))
        to_me = bool(args.get("to_me", False))
        limit = int(args.get("limit", 50))
        conn = self._db()
        try:
            rows = list_delegations(
                conn,
                from_agent=(agent if mine_only else None),
                to_agent=(agent if to_me else None),
                status=status,
                limit=limit,
            )
        finally:
            conn.close()
        if not rows:
            return "no delegations"
        return json.dumps(rows, indent=2, default=str)

    # ── helpers ─────────────────────────────────────────────────

    @staticmethod
    def _ok(rpc_id, result):
        return {"jsonrpc": "2.0", "id": rpc_id, "result": result}

    @staticmethod
    def _err(rpc_id, code, message):
        return {"jsonrpc": "2.0", "id": rpc_id,
                "error": {"code": code, "message": message}}
