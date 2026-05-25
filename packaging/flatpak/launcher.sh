#!/bin/sh
# Entry point invoked by Flatpak when the user runs the app.
# Forwards any arguments to the Python server.
exec /usr/bin/python3 /app/share/agent-workspace/agent_workspace.py "$@"
