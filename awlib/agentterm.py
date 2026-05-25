"""Inline agent console plumbing.

Per-issue/per-repo Claude agents running in a server-side pty, bridged
to the browser over a hand-rolled RFC 6455 WebSocket. xterm.js in the
dashboard's "Agent" sub-tab is the client.

The session lifecycle is decoupled from the WebSocket: a closed browser
tab leaves the agent running, and the next visit re-attaches.
"""
from __future__ import annotations

import base64
import errno
import hashlib
import os
import select
import signal
import socket
import struct
import sys
import threading
import time
from pathlib import Path

# ── Platform detection ─────────────────────────────────────────────────────
_IS_WINDOWS = sys.platform == "win32"

# POSIX-only modules — guarded so the server imports cleanly on Windows.
if not _IS_WINDOWS:
    import fcntl
    import pty
    import termios

# Optional Windows PTY backend.  Install via: pip install pywinpty
if _IS_WINDOWS:
    try:
        import winpty as _winpty  # type: ignore[import]
        _WINPTY_AVAILABLE = True
    except ImportError:
        _WINPTY_AVAILABLE = False
        _winpty = None                  # type: ignore[assignment]

# RFC 6455 magic GUID concatenated with the client key, sha1+base64'd to
# form the Sec-WebSocket-Accept handshake response.
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


# ── Per-session state ─────────────────────────────────────────────────────

class AgentSession:
    """One pty + one child process (claude) for one (issue, repo) pair.

    Lives until explicitly stopped or the child exits. Stays alive
    across WebSocket disconnects so the user can close their browser
    tab and reattach to the same agent later.
    """

    SCROLLBACK_MAX = 2 * 1024 * 1024

    def __init__(self, issue: str, working_dir: Path,
                  argv: list[str], env: dict[str, str],
                  cols: int = 120, rows: int = 32):
        self.issue = issue
        self.working_dir = working_dir
        self.cols = max(2, int(cols))
        self.rows = max(1, int(rows))
        self.started_at = time.time()
        self.last_activity = self.started_at
        # Distinct from last_activity: only bumps when a human
        # keystroke arrives via the WebSocket bridge. The mailbox
        # auto-poll loop checks this to avoid interrupting a user
        # who's actively typing. last_nudge_ts throttles the
        # synthetic prompt itself so we don't spam claude when a
        # message takes longer than the poll interval to be read.
        self.last_user_input_ts = 0.0
        self.last_nudge_ts = 0.0
        # Snapshot of the unread count taken right after the last
        # mailbox-poll nudge fired. The cooldown is suppressed
        # when the CURRENT unread count is strictly greater —
        # cooldown should silence duplicate nudges for the SAME
        # mail, not block new messages that arrive after the
        # agent's already-in-flight read.
        self.last_nudge_unread = 0
        # Ring of recent pty output for re-attach replay. Grows to
        # SCROLLBACK_MAX bytes then trims its front in 64 KB chunks
        # (cheap on bytearray, avoids per-byte deletion). xterm.js
        # treats the replayed bytes the same as live ones, so
        # color + cursor + scrollback all reconstruct.
        self.scrollback: bytearray = bytearray()
        self._scrollback_lock = threading.Lock()

        # `pty.fork()` returns (pid, master_fd). In the child, stdin/
        # stdout/stderr are wired to the slave pty; we exec claude
        # there. In the parent we keep the master fd for read/write.
        pid, master_fd = pty.fork()
        if pid == 0:
            # Child. Best-effort cleanup of inherited fds, then exec.
            try:
                os.chdir(str(working_dir))
            except OSError:
                pass
            try:
                # Close fds the parent dashboard had open (sqlite
                # handles, log file, listening sockets, …) — only 0/1/2
                # are wired to the pty by pty.fork(), the rest are
                # leftovers from the parent.
                try:
                    sc_open_max = os.sysconf("SC_OPEN_MAX")
                except (OSError, ValueError):
                    sc_open_max = 1024
                os.closerange(3, min(sc_open_max, 65536))
            except OSError:
                pass
            os.environ.clear()
            os.environ.update(env)
            try:
                os.execvp(argv[0], argv)
            except OSError:
                # Bubble up via the pty as a visible error before we
                # disappear from the parent's perspective.
                msg = f"exec failed: {argv}\n".encode()
                try:
                    os.write(2, msg)
                except OSError:
                    pass
                os._exit(127)

        self.pid: int = pid
        self.master_fd: int = master_fd
        # Set the initial window size on the pty so claude wraps right.
        self.resize(self.cols, self.rows)
        # Non-blocking master fd so the bridge can `select` on it.
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        # Only one WebSocket bridge at a time per session — the lock
        # is taken for the duration of bridge(). Second connection
        # gets rejected with 409.
        self.attach_lock = threading.Lock()

    def write(self, data: bytes) -> None:
        """Forward a human keystroke from the WebSocket bridge into
        the pty. Bumps both last_activity and last_user_input_ts so
        the mailbox auto-poller can tell that the user is engaged
        and stay out of the way."""
        try:
            os.write(self.master_fd, data)
            now = time.time()
            self.last_activity = now
            self.last_user_input_ts = now
        except OSError:
            pass

    def inject(self, data: bytes) -> None:
        """Write to the pty WITHOUT counting as user input. Used by
        the dashboard's mailbox auto-poller to send synthetic wake-up
        prompts ("📬 You have N unread messages…") so claude treats
        them as a fresh turn — but the next auto-poll cycle still
        sees the agent as idle (no user activity)."""
        try:
            os.write(self.master_fd, data)
            self.last_activity = time.time()
        except OSError:
            pass

    def resize(self, cols: int, rows: int) -> None:
        cols = max(2, int(cols))
        rows = max(1, int(rows))
        self.cols, self.rows = cols, rows
        try:
            # TIOCSWINSZ packs (rows, cols, xpixel, ypixel) as four
            # unsigned shorts. xpixel/ypixel are unused by claude.
            packed = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, packed)
        except OSError:
            pass

    def alive(self) -> bool:
        try:
            wpid, _ = os.waitpid(self.pid, os.WNOHANG)
            return wpid == 0
        except ChildProcessError:
            return False
        except OSError:
            return False

    def close(self) -> None:
        try:
            os.kill(self.pid, signal.SIGTERM)
        except OSError:
            pass
        # Give claude a moment to flush its session JSONL on SIGTERM.
        for _ in range(20):
            if not self.alive():
                break
            time.sleep(0.1)
        if self.alive():
            try:
                os.kill(self.pid, signal.SIGKILL)
            except OSError:
                pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass

    def append_output(self, data: bytes) -> None:
        """Append pty output to the rolling scrollback buffer. Front-
        trimmed in 64 KB chunks once we cross SCROLLBACK_MAX so the
        per-byte memmove cost stays bounded."""
        with self._scrollback_lock:
            self.scrollback.extend(data)
            if len(self.scrollback) > self.SCROLLBACK_MAX:
                # Drop the oldest 64 KB; cheap, amortises across writes.
                cut = max(64 * 1024, len(self.scrollback) - self.SCROLLBACK_MAX)
                del self.scrollback[:cut]

    def snapshot_scrollback(self) -> bytes:
        with self._scrollback_lock:
            return bytes(self.scrollback)

    def info(self) -> dict:
        return {
            "issue": self.issue,
            "pid": self.pid,
            "started_at": int(self.started_at),
            "last_activity": int(self.last_activity),
            "alive": self.alive(),
            "cols": self.cols,
            "rows": self.rows,
            "working_dir": str(self.working_dir),
        }


# ── Windows PTY session (pywinpty / ConPTY) ───────────────────────────────

if _IS_WINDOWS:
    class _WindowsAgentSession:
        """Windows PTY session backed by pywinpty (ConPTY).

        Drop-in replacement for AgentSession on Windows — exposes the
        same public API so all callers (bridge, registry, mailbox poller)
        work without platform checks beyond the initial dispatch in
        get_or_create().
        """

        SCROLLBACK_MAX = 2 * 1024 * 1024

        def __init__(self, issue: str, working_dir: Path,
                      argv: list[str], env: dict[str, str],
                      cols: int = 120, rows: int = 32):
            self.issue = issue
            self.working_dir = working_dir
            self.cols = max(2, int(cols))
            self.rows = max(1, int(rows))
            self.started_at = time.time()
            self.last_activity = self.started_at
            self.last_user_input_ts = 0.0
            self.last_nudge_ts = 0.0
            self.last_nudge_unread = 0
            self.scrollback: bytearray = bytearray()
            self._scrollback_lock = threading.Lock()
            # -1 is the sentinel value; no real fd exists on Windows.
            # reap_dead() skips os.close() when master_fd < 0.
            self.master_fd = -1
            self.attach_lock = threading.Lock()

            if not _WINPTY_AVAILABLE:
                raise RuntimeError(
                    "pywinpty is not installed — run: pip install pywinpty"
                )
            self._proc = _winpty.PtyProcess.spawn(  # type: ignore[union-attr]
                argv,
                dimensions=(self.rows, self.cols),
                env={k: str(v) for k, v in env.items()},
                cwd=str(working_dir),
            )
            self.pid: int = self._proc.pid

        def write(self, data: bytes) -> None:
            try:
                self._proc.write(data.decode("utf-8", errors="replace"))
                now = time.time()
                self.last_activity = now
                self.last_user_input_ts = now
            except Exception:  # noqa: BLE001
                pass

        def inject(self, data: bytes) -> None:
            try:
                self._proc.write(data.decode("utf-8", errors="replace"))
                self.last_activity = time.time()
            except Exception:  # noqa: BLE001
                pass

        def resize(self, cols: int, rows: int) -> None:
            cols = max(2, int(cols))
            rows = max(1, int(rows))
            self.cols, self.rows = cols, rows
            try:
                self._proc.setwinsize(rows, cols)
            except Exception:  # noqa: BLE001
                pass

        def alive(self) -> bool:
            try:
                return self._proc.isalive()
            except Exception:  # noqa: BLE001
                return False

        def close(self) -> None:
            try:
                self._proc.terminate()
            except Exception:  # noqa: BLE001
                pass
            for _ in range(20):
                if not self.alive():
                    break
                time.sleep(0.1)
            if self.alive():
                try:
                    self._proc.terminate(force=True)
                except Exception:  # noqa: BLE001
                    pass

        def append_output(self, data: bytes) -> None:
            with self._scrollback_lock:
                self.scrollback.extend(data)
                if len(self.scrollback) > self.SCROLLBACK_MAX:
                    cut = max(64 * 1024, len(self.scrollback) - self.SCROLLBACK_MAX)
                    del self.scrollback[:cut]

        def snapshot_scrollback(self) -> bytes:
            with self._scrollback_lock:
                return bytes(self.scrollback)

        def info(self) -> dict:
            return {
                "issue": self.issue,
                "pid": self.pid,
                "started_at": int(self.started_at),
                "last_activity": int(self.last_activity),
                "alive": self.alive(),
                "cols": self.cols,
                "rows": self.rows,
                "working_dir": str(self.working_dir),
            }


# ── Registry — singleton dict keyed by issue ──────────────────────────────

_REG_LOCK = threading.Lock()
_SESSIONS: dict[str, AgentSession] = {}


def get_session(issue: str) -> AgentSession | None:
    with _REG_LOCK:
        return _SESSIONS.get(issue)


def get_or_create(issue: str, working_dir: Path,
                   argv: list[str], env: dict[str, str],
                   cols: int = 120, rows: int = 32) -> AgentSession:
    with _REG_LOCK:
        s = _SESSIONS.get(issue)
        if s is not None and s.alive():
            return s
        if s is not None:
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass
        if _IS_WINDOWS:
            s = _WindowsAgentSession(issue, working_dir, argv, env,
                                     cols=cols, rows=rows)
        else:
            s = AgentSession(issue, working_dir, argv, env,
                             cols=cols, rows=rows)
        _SESSIONS[issue] = s
        return s


def stop_session(issue: str) -> bool:
    with _REG_LOCK:
        s = _SESSIONS.pop(issue, None)
    if s is None:
        return False
    s.close()
    return True


def reap_dead() -> None:
    """Drop sessions whose pty/child has exited. Called once per
    /api/agent/term/sessions request so the response is current."""
    with _REG_LOCK:
        for key, s in list(_SESSIONS.items()):
            if not s.alive():
                if s.master_fd >= 0:  # -1 is the Windows sentinel; no fd to close
                    try:
                        os.close(s.master_fd)
                    except OSError:
                        pass
                _SESSIONS.pop(key, None)


def list_sessions() -> list[dict]:
    reap_dead()
    with _REG_LOCK:
        return [s.info() for s in _SESSIONS.values()]


def iter_sessions() -> list[AgentSession]:
    """Snapshot the live session list — used by the dashboard's
    mailbox auto-poller, which needs the AgentSession object
    itself (to call .inject() / inspect last_user_input_ts)
    rather than the dict shape returned by list_sessions()."""
    reap_dead()
    with _REG_LOCK:
        return list(_SESSIONS.values())


# ── WebSocket framing — RFC 6455, server-side, single-frame messages ──────

def ws_accept_key(client_key: str) -> str:
    """Compute the Sec-WebSocket-Accept response for a client key."""
    sha = hashlib.sha1((client_key + _WS_GUID).encode("ascii")).digest()
    return base64.b64encode(sha).decode("ascii")


class WebSocketFramer:
    """Minimal RFC 6455 frame reader/writer over a connected socket.

    Server-side: incoming frames are masked, outgoing are not. We
    handle text (0x1), binary (0x2), close (0x8), ping (0x9), pong
    (0xA). Continuation frames (0x0) are accepted but the buffer is
    accumulated and the eventual message is delivered as a single
    payload — claude's TUI sends one frame per write, so this rarely
    matters.
    """

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self.buf = b""
        # Non-blocking so the bridge can `select` on it.
        sock.setblocking(False)

    def recv_some(self) -> bool | None:
        """Pull more bytes into the buffer. Returns True on data,
        None on peer close, False if nothing was readable right now."""
        try:
            data = self.sock.recv(16384)
        except BlockingIOError:
            return False
        except OSError:
            return None
        if not data:
            return None
        self.buf += data
        return True

    def next_frame(self) -> tuple[int, bytes, bool] | None:
        """Parse one frame from the buffer. Returns (opcode, payload,
        fin) or None if the frame is incomplete."""
        b = self.buf
        if len(b) < 2:
            return None
        b0, b1 = b[0], b[1]
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        plen = b1 & 0x7F
        off = 2
        if plen == 126:
            if len(b) < off + 2:
                return None
            plen = struct.unpack_from("!H", b, off)[0]
            off += 2
        elif plen == 127:
            if len(b) < off + 8:
                return None
            plen = struct.unpack_from("!Q", b, off)[0]
            off += 8
        if masked:
            if len(b) < off + 4:
                return None
            mask = b[off:off + 4]
            off += 4
        else:
            mask = None
        if len(b) < off + plen:
            return None
        payload = bytes(b[off:off + plen])
        if mask is not None:
            payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        self.buf = b[off + plen:]
        return (opcode, payload, fin)

    def send_frame(self, opcode: int, payload: bytes) -> bool:
        """Send one server-side (unmasked) frame. Blocks (with select
        backpressure) until the entire payload is sent. Returns False
        on socket error."""
        header = bytearray([0x80 | (opcode & 0x0F)])
        ln = len(payload)
        if ln < 126:
            header.append(ln)
        elif ln < 65536:
            header.append(126)
            header += struct.pack("!H", ln)
        else:
            header.append(127)
            header += struct.pack("!Q", ln)
        msg = bytes(header) + payload
        total = 0
        while total < len(msg):
            try:
                sent = self.sock.send(msg[total:])
                if sent == 0:
                    return False
                total += sent
            except BlockingIOError:
                # Send-side backpressure — wait up to 1s for the socket
                # to drain. Beyond that the peer's probably gone.
                ready = select.select([], [self.sock], [], 1.0)[1]
                if not ready:
                    return False
            except OSError:
                return False
        return True

    def close(self, code: int = 1000, reason: bytes = b"") -> None:
        payload = struct.pack("!H", code) + reason
        try:
            self.send_frame(0x8, payload)
        except Exception:  # noqa: BLE001
            pass
        try:
            self.sock.close()
        except OSError:
            pass


# ── Bridge — pump bytes between pty <-> websocket ─────────────────────────

def _bridge_windows(session: AgentSession, framer: WebSocketFramer) -> None:
    """Windows bridge using a reader thread for the ConPTY.

    select() on file descriptors is not supported on Windows, so a
    dedicated thread drains the pty and posts binary frames to the
    WebSocket. The main loop handles the socket side (select on sockets
    works fine on Windows) and the idle ping.
    """
    proc = session._proc  # type: ignore[attr-defined]
    sock = framer.sock
    stop_evt = threading.Event()

    def _pty_reader() -> None:
        while not stop_evt.is_set():
            if not session.alive():
                stop_evt.set()
                return
            try:
                text = proc.read(4096)
            except Exception:  # noqa: BLE001
                stop_evt.set()
                return
            if text:
                raw = text.encode("utf-8", errors="replace")
                session.append_output(raw)
                if not framer.send_frame(0x2, raw):
                    stop_evt.set()
                    return
                session.last_activity = time.time()
            else:
                if not session.alive():
                    stop_evt.set()
                    return
                time.sleep(0.01)

    reader = threading.Thread(target=_pty_reader, daemon=True)
    reader.start()

    last_ping = time.time()
    PING_EVERY = 10.0

    while not stop_evt.is_set():
        if not session.alive():
            framer.close(code=1000)
            stop_evt.set()
            break
        try:
            r, _, _ = select.select([sock], [], [], 0.5)
        except (OSError, ValueError):
            framer.close(code=1011)
            stop_evt.set()
            break
        if sock in r:
            status = framer.recv_some()
            if status is None:
                stop_evt.set()
                break
            while True:
                f = framer.next_frame()
                if f is None:
                    break
                op, payload, _fin = f
                if op == 0x8:
                    framer.close(code=1000)
                    stop_evt.set()
                    break
                if op == 0x9:
                    framer.send_frame(0xA, payload)
                    continue
                if op == 0xA:
                    continue
                if op in (0x1, 0x2):
                    session.write(payload)
        now = time.time()
        if now - last_ping >= PING_EVERY:
            if not framer.send_frame(0x9, b"cw"):
                stop_evt.set()
                break
            last_ping = now

    reader.join(timeout=2.0)


def bridge(session: AgentSession, framer: WebSocketFramer) -> None:
    """Run until either side closes. Reads from master_fd, ships
    server→client; reads from socket, ships client→master_fd.

    Sends a server-side WebSocket ping every 10 seconds when the
    connection is otherwise idle, so a NAT / proxy idle timer can't
    close the connection out from under us.

    Idempotent on session.close — closing the session just drops the
    master_fd which makes the next select wake up with an EOF read,
    and we exit cleanly.
    """
    if _IS_WINDOWS:
        _bridge_windows(session, framer)
        return
    master_fd = session.master_fd
    sock = framer.sock
    last_ping = time.time()
    PING_EVERY = 10.0
    while True:
        if not session.alive():
            framer.close(code=1000)
            return
        try:
            r, _, _ = select.select([master_fd, sock], [], [], 0.5)
        except (OSError, ValueError):
            framer.close(code=1011)
            return

        if master_fd in r:
            try:
                data = os.read(master_fd, 16384)
            except OSError as e:
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                    data = b""
                else:
                    framer.close(code=1000)
                    return
            if data:
                # Cache before sending so a reattach within the same
                # tick sees this batch in its replay.
                session.append_output(data)
                if not framer.send_frame(0x2, data):  # binary out
                    return
                session.last_activity = time.time()
            elif not session.alive():
                framer.close(code=1000)
                return

        if sock in r:
            status = framer.recv_some()
            if status is None:
                # Peer hung up. Leave the session alive.
                return
            while True:
                f = framer.next_frame()
                if f is None:
                    break
                op, payload, _fin = f
                if op == 0x8:
                    framer.close(code=1000)
                    return
                if op == 0x9:
                    framer.send_frame(0xA, payload)
                    continue
                if op == 0xA:
                    continue  # pong, ignore
                if op in (0x1, 0x2):
                    session.write(payload)

        # Idle ping. Keeps the WS alive through any NAT / proxy
        # idle-close timers. send_frame returns False if the socket
        # is already gone; that's how we discover a peer that
        # disappeared without sending a TCP RST.
        now = time.time()
        if now - last_ping >= PING_EVERY:
            if not framer.send_frame(0x9, b"cw"):  # ping
                return
            last_ping = now


# ── Helper: build the bash -c argv ────────────────────────────────────────

def build_agent_argv(issue: str,
                     working_dir: Path, branch: str | None,
                     model: str | None = None,
                     mcp_config_path: Path | None = None,
                     provider_id: str = "claude") -> list[str]:
    """Build the `bash -c` argv that the pty execs. Mirrors the
    LAUNCH_BODY in bin/agent-worktrees so the inline session is
    behaviourally byte-identical to the external one.

    The chosen agent CLI is looked up via the provider registry. The
    Claude Code provider uses `claude --continue` to resume a prior
    session and falls back to a fresh invocation when --continue
    exits non-zero. Other providers use their own resume semantics
    (or none, when the CLI has no resume flag). `exec bash` afterwards
    so the user lands at a shell prompt once the agent exits, rather
    than the pty closing instantly.

    The shell command is constructed with shell-safe quoting via
    `shlex.quote` so the issue name and system prompt can contain
    arbitrary characters without breaking the line.
    """
    import shlex
    from awlib import providers
    # The pinned "General Agent" tab uses the sentinel issue name
    # __agent__ and lives at the dashboard's worktrees root so the
    # agent's cwd is the parent of every workspace dir and
    # `cd <workspace>/<repo>` reaches any of them.
    if issue == "__agent__":
        tab_title = "Agent 007"
        sys_prompt = (
            "You are the general-purpose agent for the agent-workspace "
            "dashboard. You are NOT tied to a specific workspace — "
            "every subdirectory of your working directory is one "
            "workspace, so you can `cd <workspace>/<repo>` to reach "
            f"any of them. Working directory: {working_dir}.\n\n"
            "Other workspace-scoped agents on this dashboard can send "
            "you messages via the agent-workspace MCP server (tools: "
            "read_messages, send_message, request_review, "
            "broadcast_message). At the start of every turn, call "
            "`read_messages` with unread_only=true. If it returns "
            "any rows — especially kind='review_request' — handle "
            "them first: do the work (typically `git show <ref>` "
            "for a review), then reply IMMEDIATELY with "
            "`send_message(to=<original sender>, "
            "in_reply_to=<that message's id>, text=<your review>)`. "
            "Do NOT ask the human to confirm before replying — the "
            "agent-to-agent mailbox is autonomous; the recipient is "
            "another agent waiting on you, not the user. Only after "
            "the inbox is empty should you address the user's most "
            "recent prompt."
        )
    else:
        tab_title = issue
        prompt_lines = [
            "You are working in the agent-workspace dashboard. "
            "Active context for this session:",
            f"- Workspace: {issue}",
            f"- Working directory: {working_dir}",
        ]
        if branch:
            prompt_lines.append(f"- Branch: {branch}")
        prompt_lines.append(
            "Treat the working directory as your project root. Each "
            "subdirectory is a repo worktree on its own per-workspace branch."
        )
        sys_prompt = "\n".join(prompt_lines)
    provider = providers.get(provider_id)
    inner = provider.build_shell_command(
        tab_title=tab_title,
        sys_prompt=sys_prompt,
        model=model,
        mcp_config_path=mcp_config_path,
    )
    name_q = shlex.quote(tab_title)
    inner = (
        f"{inner}; "
        f"printf '\\033]0;%s\\a' {name_q}; "
        f"exec bash"
    )
    return ["bash", "-c", inner]
