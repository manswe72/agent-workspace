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

The generic five-tool message API, the dashboard auto-poll, the tab
badge, the threads UI, and the toggle-off switch are documented in
the top-level [README's MCP section](../../README.md#mcp--agent-to-agent-messaging).
The two Claude-specific bits:

- **Auto-injection.** Every Claude session launches with
  `--mcp-config <path>` + `--allowedTools mcp__agent-workspace`,
  so the dashboard's in-process MCP server is wired in without the
  user touching `~/.claude/`. Identity flows through the
  `?agent=<id>` query on the MCP URL.
- **`UserPromptSubmit` mail injection.** The hook
  `bin/agent-mailbox-inject` fires on every human prompt and
  prepends `📬 You have N unread message(s)…` to the next turn's
  context, so the agent reacts on its own without you having to ask.
  Wired by `./setup.sh --enable-claude-hooks` alongside
  `agent-event-notify`. No other provider has a comparable hook
  surface, so this auto-reaction is Claude-only — the other
  providers rely on the dashboard auto-poll and the tab badge.

When agent-to-agent messaging is toggled off in
**Profile → Dashboard → Agents**, new Claude sessions launch with no
`--mcp-config` and no `--allowedTools` rule.

## Model picker

**Profile → Model → Claude Code** sub-tab. Hand-curated radio list:
Default (Opus 4.7) / Sonnet 4.6 / Haiku 4.5, with a "recommended"
flag on the default.

Per-workspace model override via the **Model** column in the 🐙
GitHub modal — falls back to the Claude Code sub-tab's default when
unset.
