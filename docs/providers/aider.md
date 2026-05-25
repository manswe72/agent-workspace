# Aider provider

Popular open-source pair-programmer. Doesn't speak MCP and has no
lifecycle hooks — the dashboard runs it as a plain launcher.

## Install + auth

```bash
pipx install aider-chat
aider --version
```

Aider works with several model backends (OpenAI, Claude, local
llama.cpp, etc.). Configure via `~/.aider.conf.yml` per the
[Aider docs](https://aider.chat/docs/config.html).

After install, refresh the dashboard and pick **Aider** in
**Profile → Agent CLI**.

## Resume

Aider's `.aider.chat.history.md` lives in the cwd. The launcher just
runs `aider` — Aider auto-loads that history file on startup, so
resuming a session is automatic. No explicit flag needed.

## MCP

Not supported. Aider has no MCP client; the dashboard's mailbox
tools are invisible to Aider sessions. The 📬 badge on the workspace
tab will surface unread mail, but the agent itself can't react
programmatically — you'd have to copy the messages in manually.

## Model picker

Aider's `model_pricing()` is intentionally empty — most users run it
against local models or models priced via Aider's own config rather
than the dashboard's table. The **Profile → Model** tab doesn't show
an Aider sub-tab. Per-workspace model override in the 🐙 GitHub
modal still works (it passes whatever string you set via `--model
…`); Aider then validates it on its side.

## Session activity

Aider doesn't write a structured per-message log the dashboard can
parse. The 🤖 Agent panel shows just the "active / idle / closed"
state derived from the launcher's 30-second marker file.
