"""agent-workspace shared helpers.

Extracted from agent_workspace.py to keep the main module focused on
the request handler + orchestration. New helpers should land here when
they're not specific to one HTTP route. Each submodule should be
importable on its own (no circular deps with agent_workspace.py).
"""
