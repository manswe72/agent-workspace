"""Provider ABC + helper utilities."""
from __future__ import annotations

import json
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


def dashboard_mcp_url() -> str:
    """The URL non-Claude providers point their MCP config at.

    Includes the port the dashboard is listening on (read from the
    `AGENT_WORKSPACE_PORT` env var the launcher exports). Path is
    plain `/mcp` — agent identity flows through the `X-Agent-Id`
    header, populated from the `AGENT_WORKSPACE_AGENT_ID` env var
    that the launcher also sets per-shell."""
    import os
    port = os.environ.get("AGENT_WORKSPACE_PORT", "8765")
    return f"http://127.0.0.1:{port}/mcp"


def mcp_server_name() -> str:
    """Slug the dashboard registers under in each provider's config."""
    return "agent-workspace"


def ensure_cursor_mcp_config() -> Path:
    """Idempotently merge the dashboard's MCP server into
    `~/.cursor/mcp.json`. Returns the path. Leaves any other
    pre-existing entries the user added themselves intact."""
    cfg_path = Path.home() / ".cursor" / "mcp.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    name = mcp_server_name()
    entry = {
        "url": dashboard_mcp_url(),
        "headers": {"X-Agent-Id": "${AGENT_WORKSPACE_AGENT_ID}"},
    }
    cfg: dict = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text() or "{}")
            if not isinstance(cfg, dict):
                cfg = {}
        except (OSError, ValueError):
            cfg = {}
    servers = cfg.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        servers = {}
        cfg["mcpServers"] = servers
    # Only rewrite our own entry — preserve anything else.
    if servers.get(name) != entry:
        servers[name] = entry
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
        cfg_path.chmod(0o600)
    return cfg_path


def ensure_codex_mcp_config() -> Path:
    """Idempotently merge the dashboard's MCP server into
    `~/.codex/config.toml` under `[mcp_servers.agent-workspace]`.

    Uses a tiny TOML reader/writer (no toml dep — stdlib stays the
    rule). Edits only the one section; preserves the rest of the
    file byte-for-byte."""
    cfg_path = Path.home() / ".codex" / "config.toml"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    name = mcp_server_name()
    block_header = f"[mcp_servers.{name}]"
    # Codex CLI key names (verified against `codex mcp get` output):
    #   - http_headers       — literal header values (TOML doesn't
    #                           interpolate env vars here, so we
    #                           write a placeholder the user can
    #                           replace OR fall back to
    #                           env_http_headers below)
    #   - env_http_headers   — map of HEADER_NAME → ENV_VAR_NAME;
    #                           Codex reads the value from the env at
    #                           launch. This is what we want — agent
    #                           identity is set per-launch via the
    #                           dashboard's pty env.
    new_block = (
        f"{block_header}\n"
        f'url = "{dashboard_mcp_url()}"\n'
        f'env_http_headers = {{ "X-Agent-Id" = "AGENT_WORKSPACE_AGENT_ID" }}\n'
        f'approval_policy = "never"\n'
    )
    existing = cfg_path.read_text() if cfg_path.is_file() else ""
    if block_header in existing:
        # Replace the existing block (header → next header-or-EOF).
        lines = existing.splitlines(keepends=True)
        out_lines: list[str] = []
        i = 0
        while i < len(lines):
            if lines[i].rstrip() == block_header:
                # Skip until the next section header or EOF.
                out_lines.append(new_block)
                if not out_lines[-1].endswith("\n"):
                    out_lines[-1] += "\n"
                i += 1
                while i < len(lines) and not lines[i].lstrip().startswith("["):
                    i += 1
            else:
                out_lines.append(lines[i])
                i += 1
        new_text = "".join(out_lines)
    else:
        sep = "" if existing.endswith("\n") or not existing else "\n"
        new_text = existing + sep + ("\n" if existing else "") + new_block
    if new_text != existing:
        cfg_path.write_text(new_text)
        cfg_path.chmod(0o600)
    return cfg_path


def ensure_gemini_mcp_config() -> Path:
    """Idempotently merge the dashboard's MCP server into
    `~/.gemini/settings.json` under `mcpServers.<name>`.

    Gemini CLI uses the `httpUrl` key for streamable-HTTP MCP servers
    (Cursor uses `url`; Claude Code uses the same shape via
    `--mcp-config`). Headers support `${VAR}` env-var interpolation
    so the launcher's per-shell AGENT_WORKSPACE_AGENT_ID flows
    through cleanly."""
    cfg_path = Path.home() / ".gemini" / "settings.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    name = mcp_server_name()
    entry = {
        "httpUrl": dashboard_mcp_url(),
        "headers": {"X-Agent-Id": "${AGENT_WORKSPACE_AGENT_ID}"},
    }
    cfg: dict = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text() or "{}")
            if not isinstance(cfg, dict):
                cfg = {}
        except (OSError, ValueError):
            cfg = {}
    servers = cfg.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        servers = {}
        cfg["mcpServers"] = servers
    if servers.get(name) != entry:
        servers[name] = entry
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
        cfg_path.chmod(0o600)
    return cfg_path


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
