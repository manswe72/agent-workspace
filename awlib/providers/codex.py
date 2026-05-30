"""OpenAI Codex CLI provider.

`codex resume --last` resumes the latest session in cwd; falls back
to `codex` for a fresh session. Pricing follows the public OpenAI
tariff for the default `gpt-5` family (override via the user
pricing pref).

MCP: Codex reads servers from `~/.codex/config.toml` under
`[mcp_servers.<name>]`. Identity flows through `X-Agent-Id` over an
HTTP header that resolves from the launcher's
`$AGENT_WORKSPACE_AGENT_ID` env var.
"""
from __future__ import annotations

import shlex
from pathlib import Path

from .base import (
    AgentProvider,
    ensure_codex_mcp_config,
    liveness_bash_block,
    marker_file,
)


class CodexProvider(AgentProvider):
    id = "codex"
    display_name = "OpenAI Codex CLI"
    binary = "codex"

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
        prompt_q = shlex.quote(sys_prompt)
        model_arg = f" --model {shlex.quote(model)}" if model else ""
        # Auto-register the dashboard's MCP server in
        # ~/.codex/config.toml. Identity per launch is carried by
        # AGENT_WORKSPACE_AGENT_ID (set in the spawned shell).
        ensure_codex_mcp_config()
        return (
            f"{liveness}"
            f"export AGENT_SYS_PROMPT={prompt_q}; "
            f"codex resume --last{model_arg} 2>/dev/null "
            f"|| codex{model_arg}"
        )

    def supports_mcp(self) -> bool:
        return True

    def auto_registers_mcp(self) -> bool:
        return True

    def model_pricing(self) -> dict[str, dict[str, float]]:
        # Best-effort defaults; users override via the dashboard's
        # pricing.json. Cache pricing left at 0 — Codex doesn't
        # surface prompt-cache info the way Claude does.
        return {
            "codex:gpt-5":       {"in": 5.00, "out": 15.00, "cache_r": 0.0, "cache_w": 0.0},
            "codex:gpt-4o":      {"in": 2.50, "out": 10.00, "cache_r": 0.0, "cache_w": 0.0},
            "codex:gpt-4o-mini": {"in": 0.15, "out":  0.60, "cache_r": 0.0, "cache_w": 0.0},
        }
