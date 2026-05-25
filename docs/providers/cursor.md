# Cursor Agent CLI provider

Closed-source headless agent from cursor.com. Speaks MCP — the
dashboard auto-wires its mailbox via `~/.cursor/mcp.json`.

## Install + auth

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent --version
# auth on first run with `cursor-agent login`
```

After install, refresh the dashboard and pick **Cursor Agent** in
**Profile → Agent CLI**.

## Resume

```
cursor-agent resume
```

Resumes the most recent session in the current cwd. The launcher
falls back to a fresh `cursor-agent` invocation when no prior session
exists.

## MCP mailbox auto-wiring

On every launch the dashboard merges this entry into
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-workspace": {
      "url": "http://127.0.0.1:8766/mcp",
      "headers": { "X-Agent-Id": "${AGENT_WORKSPACE_AGENT_ID}" }
    }
  }
}
```

The `${VAR}` interpolation Cursor performs on header values picks
up the `AGENT_WORKSPACE_AGENT_ID` env var the launcher exports per
shell, so the dashboard's `/mcp` endpoint sees the right identity
without rewriting the config file per launch. Cursor's MCP-tool
approval semantics auto-accept tools listed in `mcp.json`, so the
five mailbox tools fire without confirmation prompts.

## Model picker

Cursor manages its own model selection inside the CLI (`/model`).
The dashboard doesn't expose a per-CLI model picker for Cursor yet
— if you set one in the **Model** column of the 🐙 GitHub modal,
it's passed via `--model …` to the launch line.

## Session activity

Cursor doesn't write a structured per-message log the dashboard can
parse, so the 🤖 Agent panel shows just the "active / idle / closed"
state derived from the launcher's marker file. Token totals + cost
are not surfaced.
