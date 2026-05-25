"""In-memory log ring + structured-log helper.

Every line written to stderr is teed (via _StderrTee) into a bounded
ring buffer; the dashboard polls it through /api/logs. `log_event`
emits structured records in either bracket-prefix text or JSON
(`AGENT_WORKSPACE_LOG_JSON=1`) and bypasses level-sniffing because
the caller already knows the severity.

The module is import-cycle-free: no imports from agent_workspace.py
or any other awlib module. Callers wire in their own dependencies
(none required here).
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections import deque
from datetime import datetime


class _LogRing:
    """Bounded thread-safe ring buffer of log lines with monotonic ids.

    Each entry: {id, ts, level, msg}. Level is sniffed from the line text —
    cheap heuristic, good enough for an error console. Records survive any
    number of polls; the cap drops the oldest line on overflow.
    """

    def __init__(self, capacity: int = 1000):
        self._buf: deque[dict] = deque(maxlen=capacity)
        self._lock = threading.Lock()
        self._sn = 0

    def append(self, line: str, level: str | None = None) -> None:
        line = line.rstrip("\n")
        if not line:
            return
        # When the caller knows the level (e.g. log_message has the HTTP
        # status code in args), trust it. Otherwise fall back to keyword
        # heuristics on the line text.
        if level not in ("info", "warn", "error"):
            low = line.lower()
            if any(k in low for k in ("error", "exception", "traceback", "failed")):
                level = "error"
            elif "warn" in low:
                level = "warn"
            else:
                level = "info"
        with self._lock:
            self._sn += 1
            self._buf.append({"id": self._sn, "ts": time.time(),
                              "level": level, "msg": line})

    def query(self, since_id: int = 0, levels: list[str] | None = None,
              q: str | None = None, limit: int = 200) -> list[dict]:
        with self._lock:
            entries = list(self._buf)
        if since_id:
            entries = [e for e in entries if e["id"] > since_id]
        if levels:
            allow = set(levels)
            entries = [e for e in entries if e["level"] in allow]
        if q:
            ql = q.lower()
            entries = [e for e in entries if ql in e["msg"].lower()]
        # Newest last; trim to the most recent `limit`.
        return entries[-max(0, limit):]

    def latest_id(self) -> int:
        with self._lock:
            return self._sn

    def size(self) -> int:
        with self._lock:
            return len(self._buf)

    def levels_summary(self) -> dict[str, int]:
        with self._lock:
            entries = list(self._buf)
        out = {"info": 0, "warn": 0, "error": 0}
        for e in entries:
            out[e["level"]] = out.get(e["level"], 0) + 1
        return out


_LOG_RING = _LogRing(capacity=1000)

# Set to '1' to emit log_event lines as JSON instead of human-friendly
# bracket-prefixed text. Useful when the server is shipped to a log
# aggregator that wants structured fields.
_LOG_JSON = os.environ.get("AGENT_WORKSPACE_LOG_JSON", "0") == "1"


def _fmt_field(v):
    """Render a structured-log value compactly (no whitespace surprises)."""
    if isinstance(v, (int, float, bool)) or v is None:
        return repr(v)
    s = str(v)
    if any(c.isspace() for c in s) or "=" in s or '"' in s:
        return json.dumps(s, ensure_ascii=False)
    return s


def log_event(level: str, component: str, message: str, **fields) -> None:
    """Emit one structured log line.

    `level` is 'info' / 'warn' / 'error'. `component` is a short tag like
    'sync', 'hooks', 'http'. Extra keyword args become ` k=v` pairs in
    text mode or top-level JSON keys in JSON mode.

    Routes through stderr so the existing _StderrTee + _LOG_RING capture
    it for /api/logs. Always best-effort — never raises out of a log
    call (a logging error must never take the server down).
    """
    try:
        if _LOG_JSON:
            line = json.dumps({
                "ts": datetime.now().isoformat(timespec="seconds"),
                "level": level, "component": component,
                "msg": message, **fields,
            }, default=str, ensure_ascii=False)
        else:
            extra = "".join(f" {k}={_fmt_field(v)}" for k, v in fields.items())
            line = f"[{component}] {level.upper()}: {message}{extra}"
        # Write directly to the underlying stream so the tee doesn't try to
        # re-classify the level — we already know it.
        stream = (sys.stderr.original if isinstance(sys.stderr, _StderrTee)
                  else sys.stderr)
        stream.write(line + "\n")
        try:
            stream.flush()
        except Exception:  # noqa: BLE001
            pass
        _LOG_RING.append(line, level=level)
    except Exception:  # noqa: BLE001
        # Logging must never raise. Last-ditch: dump to original stderr.
        try:
            sys.__stderr__.write(f"log_event failed: {component} {message}\n")
        except Exception:  # noqa: BLE001
            pass


class _StderrTee:
    """Write-through wrapper that mirrors stderr writes into _LOG_RING.

    Installed once in main(). Buffers partial writes so we only push complete
    lines into the ring (matches what a `tail -f` reader would see).
    """

    def __init__(self, original):
        self._original = original
        self._buf = ""
        self._lock = threading.Lock()

    @property
    def original(self):
        """Underlying stream — bypass the tee when the caller will push
        into _LOG_RING directly with an explicit level."""
        return self._original

    def write(self, s: str) -> int:
        n = self._original.write(s)
        with self._lock:
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                _LOG_RING.append(line)
        return n

    def flush(self):
        self._original.flush()

    def __getattr__(self, name):
        return getattr(self._original, name)


# ── Request counters (used by /api/stats + per-request log_message) ────
_REQUEST_COUNTERS = {"total": 0, "errors": 0}
_REQ_LOCK = threading.Lock()


def record_request(status: int) -> None:
    """Bump the request totals. Called once per HTTP response from the
    Handler's _send. Errors (status >= 400) bumped separately."""
    with _REQ_LOCK:
        _REQUEST_COUNTERS["total"] += 1
        if status >= 400:
            _REQUEST_COUNTERS["errors"] += 1


def request_counters_snapshot() -> dict:
    """Thread-safe copy of the current counters dict."""
    with _REQ_LOCK:
        return dict(_REQUEST_COUNTERS)
