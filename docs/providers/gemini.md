# Gemini CLI provider

Google's open-source terminal agent. Speaks MCP — the dashboard
auto-wires its mailbox via `~/.gemini/settings.json`.

## Install + auth

```bash
npm install -g @google/gemini-cli
gemini --version
# auth on first run — see https://github.com/google-gemini/gemini-cli
```

After install, refresh the dashboard and pick **Gemini CLI** in
**Profile → Agent CLI**.

## Resume

Gemini doesn't expose a CLI flag for resuming the previous session
— inside the TUI you use `/chat resume <tag>` interactively. The
launcher just opens a fresh session.

## MCP mailbox auto-wiring

On every launch the dashboard merges this block into
`~/.gemini/settings.json` under the `mcpServers` key:

```json
{
  "mcpServers": {
    "agent-workspace": {
      "httpUrl": "http://127.0.0.1:8766/mcp",
      "headers": { "X-Agent-Id": "${AGENT_WORKSPACE_AGENT_ID}" }
    }
  }
}
```

Gemini's `${VAR}` interpolation on header values picks up the
`AGENT_WORKSPACE_AGENT_ID` env var the launcher exports per shell,
so the dashboard's `/mcp` endpoint sees the right identity without
rewriting the config file per launch.

Tool approval in Gemini is per-tool — the first time an agent calls
`send_message` / `read_messages` etc. you'll get a Gemini-side
confirm. Approving once persists for the session.

## Model picker

**Profile → Model → Gemini CLI** sub-tab. Radio list of the keys in
`model_pricing()`: `gemini:gemini-2.5-pro`, `gemini:gemini-2.5-flash`.
Per-workspace override via the **Model** column in the 🐙 GitHub
modal.

## Session activity

Gemini doesn't write a structured per-message log the dashboard can
parse, so the 🤖 Agent panel shows just the "active / idle / closed"
state derived from the launcher's marker file. Token totals + cost
are not surfaced.
