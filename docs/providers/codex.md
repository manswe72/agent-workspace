# OpenAI Codex CLI provider

`codex` is the open-source CLI for OpenAI's coding models. The
dashboard launches it the same way it launches Claude Code (the
🤖 Agent button + the **Profile → Agent CLI → OpenAI Codex CLI**
radio); on top of that it auto-wires the agent-to-agent MCP mailbox
so Codex sessions can talk to Claude / Cursor / each other.

## Install + auth

```bash
npm install -g @openai/codex
export OPENAI_API_KEY=sk-...          # in your shell rc
codex --version                        # confirm
```

After install, refresh the dashboard and switch **Profile → Agent CLI**
to **OpenAI Codex CLI**. The row's "installed" pill turns green; the
🤖 Agent button now launches `codex` in the workspace cwd.

## Resume / session storage

`codex resume --last` resumes the most recent session in the current
workspace folder. Codex stores its own session metadata under
`~/.codex/sessions/` — the dashboard doesn't parse that file format
(yet), so the per-workspace Agent panel shows the simpler
"active / idle / closed" state derived from the launcher's 30-second
marker file. Token totals and per-prompt cost from a running Codex
session aren't surfaced; you can still see them with `codex` built-in
commands inside the terminal.

## MCP mailbox auto-wiring

On every launch the dashboard merges this block into
`~/.codex/config.toml`:

```toml
[mcp_servers.agent-workspace]
url = "http://127.0.0.1:8766/mcp"
env_http_headers = { "X-Agent-Id" = "AGENT_WORKSPACE_AGENT_ID" }
approval_policy = "never"
```

`env_http_headers` is Codex's mechanism for "read this env var at
launch and use it as the header value" — the dashboard's pty wrapper
exports `AGENT_WORKSPACE_AGENT_ID=<workspace-id>` per shell, so the
MCP server sees the right identity without a per-launch config
rewrite. `approval_policy = "never"` pre-approves the five mailbox
tools (`send_message`, `read_messages`, `request_review`,
`broadcast_message`, `list_agents`) so Codex doesn't pause for a
permission prompt every time it pokes the mailbox.

Verify the wiring with:

```bash
codex mcp get agent-workspace
# transport: streamable_http
# url: http://127.0.0.1:<port>/mcp
# env_http_headers: X-Agent-Id=AGENT_WORKSPACE_AGENT_ID
```

The dashboard's `/mcp` endpoint accepts agent identity from either
`?agent=<id>` (Claude Code's per-launch config) or the `X-Agent-Id`
header (everyone else), so all five mailbox tools work across
providers — a Codex session can `send_message(to="Alice")` and an
attached Claude session sees the message in its inbox.

## Model picker

**Profile → Model → OpenAI Codex CLI** sub-tab. Radio list of the
keys in `model_pricing()`: `codex:gpt-5`, `codex:gpt-4o`,
`codex:gpt-4o-mini`. Per-workspace override via the **Model** column
in the 🐙 GitHub modal.

## Manual launch from the shell

```bash
cd ~/github/worktrees/1-the-first-isssue-for-testing/agent-workspace
AGENT_WORKSPACE_PORT=8766 \
AGENT_WORKSPACE_AGENT_ID=1-the-first-isssue-for-testing \
  codex
# inside Codex: ask it to call the agent-workspace.send_message tool
```
