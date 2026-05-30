"""Crush provider — Charmbracelet's open-source CLI agent.

Per-cwd sessions; no explicit resume flag in the public CLI.
"""
from __future__ import annotations

from pathlib import Path

from .base import AgentProvider, liveness_bash_block, marker_file


class CrushProvider(AgentProvider):
    id = "crush"
    display_name = "Crush (Charm)"
    binary = "crush"

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
        return f"{liveness}crush"
