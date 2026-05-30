"""Cursor Agent CLI provider.

Closed-source agent CLI from cursor.com. Speaks MCP — reads its
server list from `~/.cursor/mcp.json`. Identity flows via an
`X-Agent-Id` HTTP header that the launcher's exported
`$AGENT_WORKSPACE_AGENT_ID` env var resolves into.
"""
from __future__ import annotations

import shlex
from pathlib import Path

from .base import (
    AgentProvider,
    ensure_cursor_mcp_config,
    liveness_bash_block,
    marker_file,
)


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
        aider_skill_path: Path | None = None,
    ) -> str:
        marker = marker_file(Path.cwd(), self.id)
        liveness = liveness_bash_block(marker)
        model_arg = f" --model {shlex.quote(model)}" if model else ""
        # Auto-register the dashboard's MCP server in the user's
        # global ~/.cursor/mcp.json. Identity per launch is carried by
        # AGENT_WORKSPACE_AGENT_ID, which the dashboard sets in the
        # spawned shell's env (see agentterm + agent_workspace.py).
        ensure_cursor_mcp_config()
        return (
            f"{liveness}"
            f"cursor-agent resume{model_arg} 2>/dev/null "
            f"|| cursor-agent{model_arg}"
        )

    def supports_mcp(self) -> bool:
        return True

    def auto_registers_mcp(self) -> bool:
        return True
