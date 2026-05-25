# Claude Code provider

Anthropic's CLI. The richest of the six providers — the only one with
session-log parsing for token / cost rollup, the only one with
lifecycle hooks, and the canonical MCP target.

## Install + auth

```bash
npm install -g @anthropic-ai/claude-code
claude --version          # confirm
# auth on first run with `claude` or `claude /login`
```

After install, refresh the dashboard and pick **Claude Code** in
**Profile → Agent CLI** (it's the default for a fresh install).

## Resume

`claude --continue` resumes the latest session in the current
workspace folder. The launcher tries that first and falls back to a
fresh `claude` invocation when no prior session exists.

## Session activity (`~/.claude/projects/`)

Claude Code writes each session's prompts, tool calls, and per-message
token usage as JSONL files under
`~/.claude/projects/<encoded-cwd>/*.jsonl`. The dashboard tails those
files to produce:

- Per-workspace token / cost rollup in the 🤖 Agent panel
- `last_claude_prompt` excerpts in the activity feed
- Live `active` / `idle` / `closed` state pills (≤5 min mtime = active,
  ≤24 h = idle, else closed)

No other provider writes a comparably structured log on disk, so this
rich activity panel is Claude-only today. Other providers fall back
to a marker-file mtime check (≤5 min = active, ≤24 h = idle).

## Hooks (`~/.claude/settings.json`)

Claude Code lets the user wire arbitrary scripts into lifecycle
events. Run `./setup.sh --enable-claude-hooks` (idempotent) to merge
entries into `~/.claude/settings.json` for `Stop`, `Notification`,
`UserPromptSubmit`, `SessionStart`, and `SessionEnd`. The hook script
`bin/agent-event-notify`:

- POSTs `{kind, issue, session_id, message, cwd}` to `/api/events`
- fires `notify-send` for `Notification` + `Stop` events on Linux

The dashboard surfaces unread events as a `🔔N` pill on the workspace
tab and in the 🤖 Agent block's *Messages* pane. Marking events read
clears the badge. Disable any time with
`./setup.sh --disable-claude-hooks`. No equivalent hook system exists
for Codex, Aider, Gemini, Cursor, or Crush, so these events fire only
under the Claude Code provider.

## MCP — agent-to-agent messaging

The dashboard's in-process MCP server (slug `agent-workspace`) is
auto-injected into every Claude session via `--mcp-config <path>` +
`--allowedTools mcp__agent-workspace`. Agents can send messages to
each other, request reviews, list peers, and broadcast.

Tools exposed (also available to other MCP-capable providers — see
their docs):

| Tool | What it does |
|---|---|
| `send_message(to, text, in_reply_to?)` | Send a message to another agent. Recipient is the workspace id (`1-fix-auth`), a display name (`Alice`), or `__agent__` (`Agent 007`). |
| `read_messages(unread_only?, limit?)` | Fetch this agent's inbox. Marks each row read. |
| `request_review(target, ref, context?)` | Convenience wrapper that drops a structured `review_request` (with a git sha / branch / path in `ref`) into the target's mailbox. |
| `list_agents(live_only?)` | Returns every agent id + display name + state. Use before `send_message` to pick a recipient that's actually online. |
| `broadcast_message(text)` | Fan one message out to every live workspace agent (the General Agent + the caller are excluded). |

How a Claude session picks up new mail:

1. **`UserPromptSubmit` hook** (`bin/agent-mailbox-inject`) fires on
   every human prompt and prepends `📬 You have N unread message(s)…`
   to the next turn's context, so the agent reacts on its own
   without you having to ask. Wired by
   `./setup.sh --enable-claude-hooks` alongside `agent-event-notify`.
2. **Auto-poll** — when **Profile → Dashboard → Agents → Mailbox
   auto-poll** is on (default ON), the dashboard scans live pty
   sessions every 20 s. If an attached agent has unread mail AND the
   user has been idle in its terminal for ≥15 s, the dashboard types
   a bracketed-paste nudge prompt + Enter so Claude's TUI
   auto-submits. Per-agent throttle (≥60 s between nudges).
3. **Tab badge** — a `📬N` chip on the General Agent tab and on each
   workspace tab counts unread mail.

How you see threads in the dashboard:

- The Messages pane has three views — **Thread** (the default —
  threaded by `in_reply_to`, newest conversation first, replies
  indented under their parent), **Received**, and **Sent**.
- Each conversation root gets a **+N / −N** chip that folds the
  subtree inline.
- Each row carries ✕ (delete) and ↩ (reply). Delete-conversation
  removes the whole subtree in one transaction.

Toggle the whole feature off from **Profile → Dashboard → Agents →
Agent-to-agent messaging**. When off, new agents launch with no
`--mcp-config`, no `--allowedTools` rule, and the `📬` badge is hidden.

State lives in the SQLite `agent_messages` table; messages are local
to one dashboard instance and are not synced across machines.

## Model picker

**Profile → Model → Claude Code** sub-tab. Hand-curated radio list:
Default (Opus 4.7) / Sonnet 4.6 / Haiku 4.5, with a "recommended"
flag on the default.

Per-workspace model override via the **Model** column in the 🐙
GitHub modal — falls back to the Claude Code sub-tab's default when
unset.
