"""Coding-agent CLI provider registry.

Each module under this package defines one AgentProvider implementation
that knows how to launch its CLI, where to find its session state, and
its model pricing. The dashboard launches the Claude Code provider by
default; users can swap via the `default-provider` preference or pass
a provider id at terminal-spawn time.

The provider interface is deliberately leaky — Claude Code is the
rich provider (session JSONL parsing, MCP support, hooks). The other
five (Codex CLI, Aider, Gemini CLI, Cursor Agent, Crush) implement a
subset: launcher + lightweight session-liveness via a marker file
the launcher's bash wrapper touches.
"""
from __future__ import annotations

from .base import AgentProvider, ProviderNotFoundError
from . import claude_code, codex, aider, gemini, cursor, crush

# Registry — id → provider instance.
_PROVIDERS: dict[str, AgentProvider] = {
    p.id: p for p in (
        claude_code.ClaudeCodeProvider(),
        codex.CodexProvider(),
        aider.AiderProvider(),
        gemini.GeminiProvider(),
        cursor.CursorProvider(),
        crush.CrushProvider(),
    )
}


def get(provider_id: str) -> AgentProvider:
    """Look up a provider by id. Raises ProviderNotFoundError on miss."""
    p = _PROVIDERS.get(provider_id)
    if p is None:
        raise ProviderNotFoundError(provider_id)
    return p


def all_providers() -> list[AgentProvider]:
    """All registered providers in deterministic order."""
    return list(_PROVIDERS.values())


def installed_providers() -> list[AgentProvider]:
    """Subset whose CLI binary is found on PATH."""
    return [p for p in _PROVIDERS.values() if p.is_installed()]


__all__ = [
    "AgentProvider",
    "ProviderNotFoundError",
    "get",
    "all_providers",
    "installed_providers",
]
