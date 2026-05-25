#!/bin/sh
# Snap entry point — forwards to the Python server.
exec /usr/bin/env python3 "$SNAP/share/agent-workspace/agent_workspace.py" "$@"
