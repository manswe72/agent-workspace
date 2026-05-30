"""Gemini CLI provider — Google's open-source terminal agent.

No CLI resume flag; sessions are resumed via the `/chat resume <tag>`
slash command interactively.

MCP: Gemini reads servers from `~/.gemini/settings.json` under
`mcpServers`. Identity flows through `X-Agent-Id` over an HTTP header
that resolves from the launcher's `$AGENT_WORKSPACE_AGENT_ID` env
var via Gemini's `${VAR}` interpolation.
"""
from __future__ import annotations

import shlex
from pathlib import Path

from .base import (
    AgentProvider,
    ensure_gemini_mcp_config,
    liveness_bash_block,
    marker_file,
)


class GeminiProvider(AgentProvider):
    id = "gemini"
    display_name = "Gemini CLI"
    binary = "gemini"

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
        # Auto-register the dashboard's MCP server in
        # ~/.gemini/settings.json. Identity per launch is carried by
        # AGENT_WORKSPACE_AGENT_ID, which the launcher exports.
        ensure_gemini_mcp_config()
        return f"{liveness}gemini{model_arg}"

    def supports_mcp(self) -> bool:
        return True

    def auto_registers_mcp(self) -> bool:
        return True

    def model_pricing(self) -> dict[str, dict[str, float]]:
        return {
            "gemini:gemini-2.5-pro":   {"in": 1.25, "out": 5.00, "cache_r": 0.0, "cache_w": 0.0},
            "gemini:gemini-2.5-flash": {"in": 0.30, "out": 2.50, "cache_r": 0.0, "cache_w": 0.0},
        }
