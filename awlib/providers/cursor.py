"""Cursor Agent CLI provider — closed-source headless agent."""
from __future__ import annotations

import shlex
from pathlib import Path

from .base import AgentProvider, liveness_bash_block, marker_file


class CursorProvider(AgentProvider):
    id = "cursor"
    display_name = "Cursor Agent"
    binary = "cursor-agent"

    def build_shell_command(
        self,
        *,
        tab_title: str,
        sys_prompt: str,
        model: str | None,
        mcp_config_path: Path | None,
    ) -> str:
        marker = marker_file(Path.cwd(), self.id)
        liveness = liveness_bash_block(marker)
        model_arg = f" --model {shlex.quote(model)}" if model else ""
        return (
            f"{liveness}"
            f"cursor-agent resume{model_arg} 2>/dev/null "
            f"|| cursor-agent{model_arg}"
        )

    def supports_mcp(self) -> bool:
        # Cursor reads MCP servers from ~/.cursor/mcp.json. Dashboard
        # doesn't auto-inject — same caveat as Codex / Gemini.
        return True
