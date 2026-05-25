"""Provider ABC + helper utilities."""
from __future__ import annotations

import re
import shlex
import shutil
import time
from abc import ABC, abstractmethod
from pathlib import Path


class ProviderNotFoundError(KeyError):
    """Raised by providers.get() for an unknown id."""


HOME = Path.home()
MARKER_DIR = HOME / ".cache" / "agent-workspace" / "markers"

_SAFE_PATH_RE = re.compile(r"[^A-Za-z0-9_.-]")


def _safe_token(s: str) -> str:
    return _SAFE_PATH_RE.sub("-", s)


def marker_file(cwd: Path, provider_id: str) -> Path:
    """The marker file a provider's launcher touches to signal liveness.

    Path-encodes the cwd into a single filename so every provider/cwd
    pair has its own marker. The launcher arranges for the inner bash
    to `touch` this file at start + every 30 s in a background loop.
    """
    return MARKER_DIR / f"{_safe_token(str(cwd))}.{provider_id}.alive"


def marker_state(cwd: Path, provider_id: str) -> str:
    """Compute active/idle/closed from a marker file's mtime."""
    try:
        age = time.time() - marker_file(cwd, provider_id).stat().st_mtime
    except OSError:
        return "closed"
    if age <= 5 * 60:
        return "active"
    if age <= 24 * 60 * 60:
        return "idle"
    return "closed"


def liveness_bash_block(marker_path: Path) -> str:
    """Build a small bash snippet that:
      - mkdir -p the marker dir
      - touches the marker file on launch
      - spawns a background loop that re-touches it every 30 s
        for as long as this shell lives.

    Used by providers that don't have their own session-file mechanism.
    """
    q = shlex.quote(str(marker_path))
    return (
        f"mkdir -p {shlex.quote(str(marker_path.parent))}; "
        f"touch {q}; "
        f"( while [ -e /proc/$$ ] 2>/dev/null || kill -0 $$ 2>/dev/null; "
        f"do touch {q}; sleep 30; done ) >/dev/null 2>&1 & "
    )


class AgentProvider(ABC):
    """Abstract base for an agent CLI provider.

    Implementations:
      - ``id``: short stable string ("claude", "codex", "aider", …).
      - ``display_name``: human label for the dashboard UI.
      - ``binary``: the CLI's executable name; used for is_installed().

    The optional methods (``session_log_path``, ``parse_log_events``,
    ``supports_mcp``, ``supports_hooks``) default to "no" — Claude Code
    overrides them. Other providers can opt in as their CLIs grow
    support.
    """

    id: str = ""
    display_name: str = ""
    binary: str = ""

    def is_installed(self) -> bool:
        return bool(self.binary) and shutil.which(self.binary) is not None

    @abstractmethod
    def build_shell_command(
        self,
        *,
        tab_title: str,
        sys_prompt: str,
        model: str | None,
        mcp_config_path: Path | None,
    ) -> str:
        """Return the inner-shell command string the dashboard's pty
        wrapper will exec. The wrapper adds `exec bash` after this so
        the user lands at a prompt when the agent exits.
        """

    def session_state(self, cwd: Path) -> str:
        """Return 'active' / 'idle' / 'closed'. Default uses the marker
        file the launcher touches; providers that store per-cwd session
        logs (Claude Code) override this to read the log's mtime."""
        return marker_state(cwd, self.id)

    def default_model(self) -> str | None:
        return None

    def model_pricing(self) -> dict[str, dict[str, float]]:
        """Per-Mtok USD pricing keyed by model name. May be empty for
        providers running against local models."""
        return {}

    # ── Optional, default no-op ────────────────────────────────────────
    def session_log_path(self, cwd: Path) -> Path | None:
        return None

    def parse_log_events(self, path: Path) -> list[dict]:
        return []

    def supports_mcp(self) -> bool:
        """The CLI itself speaks MCP as a client. Used by the dashboard
        UI to decide whether to surface MCP-related affordances for
        this provider."""
        return False

    def auto_registers_mcp(self) -> bool:
        """The dashboard auto-injects its in-process MCP server into
        this CLI's launch line. Only Claude Code today, because
        every CLI accepts MCP config differently (flag vs. TOML vs.
        JSON in its own dotdir). Users of other MCP-capable providers
        can wire it themselves — see README."""
        return False

    def supports_hooks(self) -> bool:
        return False
