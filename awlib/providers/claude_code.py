"""Claude Code (Anthropic) provider.

The richest provider — full session log parsing, MCP, hooks.
Reads `~/.claude/projects/<encoded-cwd>/*.jsonl` for session state +
activity rollup.
"""
from __future__ import annotations

import re
import shlex
import time
from pathlib import Path

from .base import HOME, AgentProvider

_PROJECTS_DIR = HOME / ".claude" / "projects"


def _encode_cwd(cwd: Path) -> str:
    """Match Claude Code's path-encoding for the projects/<dir> name."""
    return re.sub(r"[^A-Za-z0-9-]", "-", str(cwd))


class ClaudeCodeProvider(AgentProvider):
    id = "claude"
    display_name = "Claude Code"
    binary = "claude"

    def build_shell_command(
        self,
        *,
        tab_title: str,
        sys_prompt: str,
        model: str | None,
        mcp_config_path: Path | None,
    ) -> str:
        name_q = shlex.quote(tab_title)
        prompt_q = shlex.quote(sys_prompt)
        model_arg = f" --model {shlex.quote(model)}" if model else ""
        mcp_arg = ""
        if mcp_config_path:
            from awlib import agent_mcp  # local import — avoid cycle at module load
            allow_rule = shlex.quote(f"mcp__{agent_mcp.SERVER_SLUG}")
            mcp_arg = (
                f" --mcp-config {shlex.quote(str(mcp_config_path))}"
                f" --allowedTools {allow_rule}"
            )
        return (
            f"claude --continue --name {name_q} "
            f"--append-system-prompt {prompt_q}{model_arg}{mcp_arg} 2>/dev/null "
            f"|| claude --name {name_q} "
            f"--append-system-prompt {prompt_q}{model_arg}{mcp_arg}"
        )

    def session_state(self, cwd: Path) -> str:
        log_dir = _PROJECTS_DIR / _encode_cwd(cwd)
        if not log_dir.is_dir():
            return "closed"
        latest = 0.0
        for f in log_dir.glob("*.jsonl"):
            try:
                m = f.stat().st_mtime
            except OSError:
                continue
            if m > latest:
                latest = m
        if latest == 0.0:
            return "closed"
        age = time.time() - latest
        if age <= 5 * 60:
            return "active"
        if age <= 24 * 60 * 60:
            return "idle"
        return "closed"

    def session_log_path(self, cwd: Path) -> Path | None:
        return _PROJECTS_DIR / _encode_cwd(cwd)

    def model_pricing(self) -> dict[str, dict[str, float]]:
        # Per-Mtok USD pricing. Mirrors the table that used to live in
        # awlib/pricing.py — kept here so each provider owns its rates.
        return {
            "claude-opus-4-7":   {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
            "claude-opus-4-6":   {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
            "claude-opus-4-5":   {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
            "claude-sonnet-4-6": {"in":  3.00, "out": 15.00, "cache_r": 0.30, "cache_w":  3.75},
            "claude-haiku-4-5":  {"in":  1.00, "out":  5.00, "cache_r": 0.10, "cache_w":  1.25},
        }

    def supports_mcp(self) -> bool:
        return True

    def supports_hooks(self) -> bool:
        return True
