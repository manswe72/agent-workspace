# Crush provider

Charmbracelet's open-source CLI agent. Doesn't speak MCP and has no
lifecycle hooks — the dashboard runs it as a plain launcher.

## Install + auth

```bash
go install github.com/charmbracelet/crush/cmd/crush@latest
crush --version
```

After install, refresh the dashboard and pick **Crush** in
**Profile → Agent CLI**.

## Resume

Crush manages sessions per cwd interactively — no CLI resume flag.
The launcher just runs `crush`; the user picks a session from the
TUI when it opens.

## MCP

Not supported. The dashboard's mailbox tools are invisible to Crush
sessions. The 📬 badge on the workspace tab will count unread mail
but the agent itself can't react programmatically.

## Model picker

Crush's `model_pricing()` is intentionally empty — like Aider, most
users configure models inside Crush itself. The **Profile → Model**
tab doesn't show a Crush sub-tab. Per-workspace model override in
the 🐙 GitHub modal still works as a pass-through to whatever
Crush's CLI accepts.

## Session activity

Crush doesn't write a structured per-message log the dashboard can
parse. The 🤖 Agent panel shows just the "active / idle / closed"
state derived from the launcher's 30-second marker file.
