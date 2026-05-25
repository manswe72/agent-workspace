"""Aider provider — open-source pair-programmer.

Aider auto-loads `.aider.chat.history.md` from cwd; no resume flag.
Often used against local models, so default pricing is empty.
"""
from __future__ import annotations

import shlex
from pathlib import Path

from .base import AgentProvider, liveness_bash_block, marker_file


class AiderProvider(AgentProvider):
    id = "aider"
    display_name = "Aider"
    binary = "aider"

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
        return f"{liveness}aider{model_arg}"
