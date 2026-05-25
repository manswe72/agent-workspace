# Agent Workspace · Status Board

A local HTTP dashboard for `~/github/worktrees/<workspace>/<repo>` —
your **Agent Workspace · Status Board**. Shows git status across
every active worktree branch, time tracking, week summaries, and a
server diagnostics console. Pluggable coding-agent CLI launcher
(Claude Code, OpenAI Codex CLI, Aider, Gemini CLI, Cursor Agent,
Crush). GitHub-native: per-workspace issue and PR pills, opt-in
multi-repo cloning per workspace.

Single-file Python stdlib server (no deps), SQLite cache, vanilla JS
frontend. The server is read-only against your worktrees — it never
runs git mutations on your behalf. When you use the Claude Code
provider it can additionally ingest events posted via hooks (see
*Claude Code provider* below).

## Agent CLI providers

Six providers ship out of the box. Pick one in **Profile → Agent
CLI**. The dashboard auto-detects which are on PATH; rows for
missing binaries are greyed out until you install the tool.

| Provider | Binary | Install | Resume in cwd | MCP | Hooks |
|---|---|---|---|---|---|
| Claude Code (Anthropic) | `claude` | `npm install -g @anthropic-ai/claude-code` | `claude --continue` | ✓ auto | ✓ |
| OpenAI Codex CLI (open source) | `codex` | `npm install -g @openai/codex` | `codex resume --last` | ✓ auto | — |
| Aider (open source) | `aider` | `pipx install aider-chat` | auto (`.aider.chat.history.md`) | — | — |
| Gemini CLI (open source) | `gemini` | `npm install -g @google/gemini-cli` | `/chat resume <tag>` (interactive) | manual | — |
| Cursor Agent | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent resume` | ✓ auto | — |
| Crush (Charm, open source) | `crush` | `go install github.com/charmbracelet/crush/cmd/crush@latest` | per-cwd, interactive | — | — |

The launcher gives every provider the same workspace context (cwd,
branch, system prompt) and tracks session liveness via either the
provider's own session log (Claude Code) or a marker file the launcher
touches every 30 s (everything else). The event-hook →
`/api/events` route only fires on the Claude Code provider (it
depends on `~/.claude/settings.json` hooks, which the others don't
have an equivalent for). MCP is broader: see *Claude Code provider*
below for the agent-to-agent messaging tools, and *OpenAI Codex CLI*
below for the auto-wiring of those same tools into Codex sessions.

## GitHub integration

The dashboard treats GitHub as the source of truth for what
**issues** and **PRs** map to a workspace. There's no `.conf` file —
configuration lives in two places:

| What | Where | Why |
|---|---|---|
| Repo list (`owner/repo`, one or more) | Dashboard preference `github-repos`, editable in **Profile → Dashboard → GitHub repos** | Non-sensitive; lives in SQLite next to the rest of your prefs. |
| Personal access token | `$GITHUB_TOKEN` env var, or `~/.config/agent-workspace/github-token` (chmod 600) | Kept out of plaintext SQLite/backups. Used for REST list calls + `git clone` over HTTPS via `GIT_ASKPASS`. |

Generate a **fine-grained PAT** at
https://github.com/settings/personal-access-tokens with **Pull
requests: Read** + **Contents: Read** on the repos in your list.
Anonymous fetches work for public repos at 60 req/h; authenticated
calls get 5000 req/h.

### What you see

- **Per-tab pill** — workspaces named `<num>-<slug>` (e.g.
  `42-fix-auth`) auto-link to issue `#42`. A green `#42` pill on
  the tab opens the issue; a `PR` pill appears next to it when a
  PR's head branch matches the workspace name.
- **🐙 GitHub modal** (toolbar button) — two tables:
  - **Issues assigned to you** — Repo / # / Title / State / Workspace
    / Model / Actions columns. **+ Add** opens a per-issue dialog
    with checkboxes for each configured repo (defaults to all) so
    multi-repo issues can clone just the relevant subset.
    **🗑 Remove** walks `/api/issue/remove` and surfaces partial
    failures.
  - **Open PRs you authored** — Repo / # / Title / State / Workspace
    columns. Same workspace-existence indicator as the issues table.
- **Missing-primary banner** — auto-derived from the `github-repos`
  preference. Clone buttons use `https://github.com/<owner>/<repo>.git`
  with your PAT via `GIT_ASKPASS`; the token never lands in
  `.git/config` or `ps` output.

If `github-repos` is empty, all of the GitHub UI is hidden and the
dashboard works as a plain worktree-watcher.

## What's on the dashboard

Top header with a **profile avatar** in the upper right (initials from
`git config user.name` / `user.email`, hue derived from the email). Clicking
it opens a popover with:
- **Editor** picker (VS Code, Cursor, Zed, IntelliJ family, Sublime, …) —
  used when you click a file in a Working tree list. Server allowlists +
  `shutil.which()` decide what's available.
- **Sync** toggle — show/hide the sync controls in the toolbar (default
  off — sync is opt-in).
- **Server** diagnostics — uptime, request count, log buffer state
  config status, PID + Python version. **🪵 View server logs** opens a
  modal with sticky column header, draggable column resizers, level-filter
  chips, search, and auto-refresh.
- **Dashboard** meta — last-generated timestamp, last sync, worktrees-root
  path.

The toolbar action row:
- **Refresh now** — re-pulls `/api/status` immediately. The button shows
  a circular progress ring that fills as the next auto-refresh
  approaches; the tooltip shows the remaining time.
- **📅 Week summary** — modal with stats tiles, per-day commits/tokens
  bars, by-issue rollup, work logs, and a list view of all cached weeks
  (◀/▶ to step weeks; ▶ disabled on the current one).
- **⇅ Sync now / ⏵ Auto-sync** — only visible when sync controls are on.
- **☰ Filters** — toggles a second row with search / sort / "show
  removed worktrees" / dirty / unpushed chips. Default closed.

Below the toolbar: an **Activity heatmap** card (commits + tokens, year
window) and a collapsible **Timer** card with an issue-picker `<select>`,
comment input, Start / Stop, plus `+ Add manual log`.

Then the **tabs** — single-row, horizontally scrollable, with `◀ ▶`
arrows on the right when overflowing. 
Each tab carries a `🔔N` pill when there are unread agent events.
Idle 14+ days gets a `💤 Nd` card prepended to the issue heading.

Inside each tab:
- **Repo cards**: per-worktree, foldable, default collapsed. Title bar shows
  branch ⟂ upstream, friendly path, an `↗` "open in editor" button, disk
  usage badge, and status pills. A 🌿 section icon matches the agent
  block's 🤖. Inside: four inner tabs — *Working tree* / *Last commits*
  (now sized to your full ahead-of-master count, capped at 200) / *Unpushed*
  / *Authors*.
- **🤖 Agent**: per-workspace agent terminal + activity panel.
  Launches whichever CLI you picked in Profile → Agent CLI.
  When using the Claude Code provider this also shows a session
  rollup (token totals, cost, top tools, last prompt) parsed from
  `~/.claude/projects/<encoded>/*.jsonl`; for other providers the
  panel is launcher-only (no per-message activity yet).

## Quick start

```bash
git clone <agent-workspace-url> ~/github/agent-workspace
cd ~/github/agent-workspace
./setup.sh
```

`setup.sh` checks prerequisites (Python ≥ 3.10, git), symlinks the
binaries into `~/.local/bin`, installs bash completions, and offers
to wire Claude Code hooks (Claude Code provider only). On Linux it
also drops an **Agent Workspace** app-launcher entry under
`~/.local/share/applications/` (so the dashboard shows up in your system
menu / dock — clicking it starts the server if needed and opens the
dashboard) and offers to register an autostart entry so the server
starts on login. The per-platform mechanism is auto-detected:

| Platform | Autostart mechanism |
|---|---|
| Linux | XDG autostart — `~/.config/autostart/agent-workspace.desktop` |
| macOS | LaunchAgent — `~/Library/LaunchAgents/io.github.agent-workspace.plist` (bootstrapped via `launchctl`) |
| Windows / Git Bash | Startup folder — `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-workspace.vbs` (silent .vbs launcher, no console window) |

The autostart prompt can be skipped with `--no-autostart` or pre-answered
yes with `--autostart`. `setup.sh --uninstall` removes whichever entry
matches the current OS. Then:

```bash
agent-worktrees-server         # start the dashboard
# → opens http://127.0.0.1:8765/ in your browser
```

Tested on Linux, macOS, and Windows (via Git Bash). The per-platform
notes below cover the small differences.

### Windows (via Git Bash)

The server detects Windows at startup and switches to Microsoft's
directory layout — `%LOCALAPPDATA%\agent-workspace\` for the SQLite
cache / pidfile / logs and `%APPDATA%\agent-workspace\backups\` for
backups. Bash scripts run unmodified under Git Bash; the only thing
`setup.sh` does differently is **copy** the scripts into `~/bin`
instead of symlinking (MSYS symlinks need Developer Mode), so re-run
`./setup.sh` after a `git pull` to refresh the copies.

| Feature | Windows behaviour |
|---|---|
| Dashboard server (HTTP, SQLite, agent events, backups, sync) | ✅ works |
| Backup git bundles (`git bundle`) | ✅ works |
| 💻 Console button | ✅ Windows Terminal (`wt.exe`) — auto-detected; ships with Windows 11 |
| Editor open buttons | ✅ same VS Code / Cursor / Sublime / Zed / IntelliJ-family detection as elsewhere (CLI helper must be on PATH) |
| Desktop popups for Claude `Notification` hooks | ✅ via the BurntToast PowerShell module (install once with the command below); silent fallback if the module isn't installed |
| Symlinks into `~/bin` | replaced by file copies — re-run `setup.sh` to refresh after pulling |
| `--systemd` autostart | n/a — `setup.sh --autostart` drops a silent `.vbs` launcher into `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` so the server starts on login with no console window (`--uninstall` / `--no-autostart` removes it). `schtasks /Create /SC ONLOGON …` works too if you prefer Task Scheduler. |

Prereqs (one-time):

```bash
# Git for Windows (bundles Git Bash) — https://git-scm.com/download/win
# Python 3.10+                       — https://www.python.org/downloads/
#                                      (tick "Add python.exe to PATH" in the installer)

# Desktop notifications: one-time PowerShell module install
powershell -Command "Install-Module -Name BurntToast -Scope CurrentUser"

# Python dependencies (agent terminal + pre-push checks)
pip install pywinpty ruff pytest
```

Install (run inside Git Bash):

```bash
git clone <agent-workspace-url> ~/github/agent-workspace
cd ~/github/agent-workspace
./setup.sh
agent-worktrees-server
```

`~/bin` is on Git Bash's PATH by default, so `agent-worktrees-server`,
`agent-worktrees-restart`, and `agent-worktrees-stop` are
immediately available in any new shell.

### macOS

The server detects macOS at startup and switches to Apple's directory
layout — `~/Library/Caches/agent-workspace/` for the SQLite cache /
pidfile / logs and `~/Library/Application Support/agent-workspace/`
for backups. The shell helpers (`agent-worktrees-restart`, `-stop`)
follow the same rule, so Python and the wrappers always agree.

| Feature | macOS behaviour |
|---|---|
| Dashboard server (HTTP, SQLite, agent events, backups, sync) | ✅ works |
| Backup git bundles (`git bundle`) | ✅ works |
| 💻 Console button (opens terminal tab with `claude --continue`) | ✅ Terminal.app via AppleScript (auto-detected); Ghostty also supported if installed |
| Editor open buttons | ✅ Detects VS Code / Cursor / Sublime / Zed / Windsurf / IntelliJ family — also BBEdit, MacVim, TextMate, Nova when their CLI helpers are on PATH (VS Code's "Install 'code' in PATH" command etc.) |
| Desktop popups for Claude `Notification` hooks | ✅ routes through `osascript`'s `display notification` (built-in Notification Center popup) when `sys.platform == "darwin"`; `notify-send` is used on Linux |

Prereqs (one-time):

```bash
# Python 3.10+ and git
brew install python git

# Optional — Ghostty is supported alongside the built-in Terminal.app
brew install --cask ghostty

# Make sure ~/.local/bin is on PATH (zsh, the macOS default shell)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

Install:

```bash
git clone <agent-workspace-url> ~/github/agent-workspace
cd ~/github/agent-workspace
./setup.sh
agent-worktrees-server
```

Grant the dashboard tab Web Notification permission from the toolbar so
agent events still surface on your desktop. The in-page toast pop-up
works on macOS regardless.

### One-line bootstrap (new machine)

`install.sh` clones (or fast-forwards) the repo and runs `setup.sh`:

```bash
# After hosting install.sh on any HTTPS endpoint:
curl -fsSL https://<host>/install.sh | bash

# Or straight from the SSH remote (no HTTPS host needed):
ssh <git-host> 'git archive --remote=<repo-path> HEAD install.sh' \
  | tar -xO install.sh | bash
```

Flags: `--repo URL`, `--dir PATH`, `--branch NAME`, `--no-setup`. Anything
else is forwarded to `setup.sh` (e.g. `--non-interactive`, `--systemd`,
`--enable-claude-hooks`).

### Install as a PWA (recommended on every platform)

The dashboard ships a `manifest.json` + service worker, so Chromium-based
browsers (Chrome, Edge, Brave, Arc, Vivaldi) expose an **Install Claude
Workspace…** prompt in the address bar (or three-dot menu → Apps →
Install). Safari 17+ supports it via **File → Add to Dock…**. On GNOME
the Files app exposes the same as **Install as App** when you're in
Chromium. Installing gives you:

- a standalone window without browser chrome,
- a dock / launcher icon + ⌘-Tab / Alt-Tab entry,
- the OS-level launcher badge for the 🔔 unread-event count (via
  `navigator.setAppBadge` — Chromium and Safari 17.4+, no-op elsewhere),
- a persistent notification surface — system popups still arrive when
  the standalone window is closed.

Firefox doesn't currently support PWA install; it works fine as a
regular tab.

### Running multiple instances

Each instance picks a per-port SQLite cache (`activity.<port>.sqlite`) and a
per-port pidfile (`server.<port>.pid`) under `~/.cache/agent-workspace/`,
so a second server on a different port can't trample the primary's data.
The default port (8765) keeps the legacy `activity.sqlite` filename for
backwards compatibility.

```bash
# Spawn an isolated test instance with empty state:
agent-worktrees-server --port 9000 --no-sync --no-hydrate \
                         --no-backup --no-open \
                         --worktrees /tmp/cw-empty
```

## Time tracking + week summaries

The dashboard doubles as a worklog system:

- **Timer card** below the heatmap — pick an issue from current worktrees,
  start, stop. On stop, a worklog row is created (rounded up to ≥1 min).
- **Manual entries** via "+ Add manual log".
- **Agent worklogs**: one synthetic row per (issue, week), computed from
  message-to-message gaps in `~/.claude/projects/<encoded>/*.jsonl` (gaps
  ≤ 5 min count as active). 🤖-marked, deletable per (issue, week) via an
  `agent_worklog_exclusions` table.
- **Week summary modal** rolls everything up: commits + tokens + cost +
  hours per issue, stats tiles, per-day bars, sortable tables, list view
  of all cached weeks. **🤖 Agent on/off** toggle to include or exclude
  computed agent time. Past weeks are autofilled on startup.

All tables (by-issue, work logs, week list) are click-to-sort with
direction toggle and per-table state in `localStorage`.

## Claude Code provider

Two integrations only exist for the Claude Code provider because they
depend on Claude-specific data formats. Other providers run as plain
launchers.

### Session activity (`~/.claude/projects/`)

Claude Code writes each session's prompts, tool calls, and token
usage as JSONL files under `~/.claude/projects/<encoded-cwd>/*.jsonl`.
The dashboard tails those files to produce:

- Per-workspace token / cost rollup in the 🤖 Agent panel
- `last_claude_prompt` excerpts in the activity feed
- Live `active` / `idle` / `closed` state pills (≤5 min mtime = active,
  ≤24 h = idle, else closed)

When the active provider is anything other than Claude Code, the
dashboard falls back to a much simpler "is the launcher's marker
file fresh?" check (≤5 min = active, ≤24 h = idle). Tokens and cost
are not displayed for non-Claude providers — their CLIs don't write
a comparably structured log on disk.

### Hooks (`~/.claude/settings.json`)

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

### Agent-to-agent messaging (MCP)

**MCP itself is an open protocol** — Claude Code, OpenAI Codex CLI,
Gemini CLI, and Cursor Agent all support it as clients (Aider and
Crush don't). What's Claude-specific here is just the **auto-wiring**:
the dashboard injects a per-agent `--mcp-config <path>` flag into
the Claude launch line so the mailbox tools appear in `/mcp` without
the user touching any config file.

If you'd like the mailbox from another MCP-capable provider, add an
entry pointing at `http://127.0.0.1:<port>/mcp?agent=<your-id>` to
that CLI's MCP config file (`~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.cursor/mcp.json`, …). Use any string
as `<your-id>` — the dashboard treats it as the agent identity for
the `read_messages` / `send_message` tool calls below.

The dashboard's in-process MCP server (slug `agent-workspace`)
exposes these tools to whichever agent connects:

| Tool | What it does |
|---|---|
| `send_message(to, text, in_reply_to?)` | Send a message to another agent. Set `in_reply_to=<id>` to thread your reply under a message you got from `read_messages`. Recipient `to` is the issue key (e.g. `BSS-3733`) or `__agent__` for the General Agent. The dispatcher validates `to` against the dashboard's known-agent set (every issue under `--worktrees` plus `__agent__`) and returns an MCP error block on typos. |
| `read_messages(unread_only=true, limit=50)` | Fetch this agent's inbox. Marks each returned row read so subsequent calls don't redeliver them. |
| `request_review(target, ref, context?)` | Convenience wrapper that drops a structured `review_request` (with a git sha / branch / path in `ref`) into the target's mailbox. Replies travel back via `send_message`. |
| `broadcast_message(text)` | Send the same text to every issue agent that currently has a live pty session on the dashboard. The General Agent and the calling agent are excluded so a broadcast never echoes back. Surfaced in the dashboard's compose picker as a "📢 Broadcast (all live issue agents)" pseudo-recipient. |

How an agent picks up new mail:

1. **UserPromptSubmit hook** (`bin/agent-mailbox-inject`) — fires on every
   human prompt and prepends `📬 You have N unread message(s)…` to the
   next turn's context, so the agent reacts on its own without you having
   to ask. Register once with `./setup.sh --enable-claude-hooks` (same
   block that wires `agent-event-notify`).
2. **Optional auto-poll** — when **Profile → Dashboard → Agents → Mailbox
   auto-poll** is on (default OFF), the dashboard scans live pty
   sessions every 20 s. If an attached agent has unread mail AND the
   user has been idle in its terminal for ≥15 s, the dashboard types a
   bracketed-paste nudge prompt + Enter so claude's TUI auto-submits.
   Per-agent throttle (≥60 s between nudges) so a slow read isn't
   repeatedly poked. **Every `send_message` / `broadcast_message` /
   `request_review` over MCP also wakes the poll loop immediately**, so
   the recipient typically gets the nudge within a second.
3. **Tab badge** — a `📬N` chip on the General Agent tab and on each
   issue tab counts unread mail addressed to that agent.

How you see threads:

- The General Agent's panel has a vertical icon strip on the left
  (🤖 Agent / 📬 Messages / 💾 Stashes). Issue tabs get the same
  strip (🤖 Agent / 🌿 Branches / 💾 Stashes) when the inline-console
  pref is on.
- The Messages pane has three views — **Thread** (the default —
  threaded by `in_reply_to`, newest conversation first, replies
  indented under their parent), **Received**, and **Sent**.
- Each conversation root gets a **+N / −N** chip that folds the
  subtree inline; a pane-head **⊞** button toggles every
  conversation at once.
- Each row carries ✕ (delete) and ↩ (reply). When the row is part
  of a thread, ✕ opens a three-button confirm — **Cancel** /
  **Delete** / **Delete Conversation (N)** — so accidental Enter
  can't take a whole thread down.
- Clicking ↩ docks the compose form **as a child of the message
  row** with an accent left rail, so the reply UI is physically
  anchored to its target. Sending or clearing returns it to the
  top of the pane.
- Pane head has a search box (substring match against body /
  branch / ref / sender / recipient — all three views) and a
  "📢 Broadcast (all live issue agents)" pseudo-entry in the
  recipient picker.
- The pane self-refreshes every 4 s while it's on screen so
  agent-originated mail appears without clicking ↻.

Toggle the whole feature off from **Profile → Dashboard → Agents →
Agent-to-agent messaging**. When off, new agents launch with no
`--mcp-config`, no `--allowedTools` rule, and the `📬` badge is hidden.

State lives in the SQLite `agent_messages` table; messages are local
to one dashboard instance and are not synced across machines.

## OpenAI Codex CLI provider

`codex` is the open-source CLI for OpenAI's coding models. The
dashboard launches it the same way it launches Claude Code (the
🤖 Agent button + the **Profile → Agent CLI → OpenAI Codex CLI**
radio); on top of that it auto-wires the agent-to-agent MCP mailbox
so Codex sessions can talk to Claude / Cursor / each other.

### Install + auth

```bash
npm install -g @openai/codex
export OPENAI_API_KEY=sk-...          # in your shell rc
codex --version                        # confirm
```

After install, refresh the dashboard and switch **Profile → Agent CLI**
to **OpenAI Codex CLI**. The row's "installed" pill turns green; the
🤖 Agent button now launches `codex` in the workspace cwd.

### Resume / session storage

`codex resume --last` resumes the most recent session in the
current workspace folder. Codex stores its own session metadata
under `~/.codex/sessions/` — the dashboard doesn't parse that file
format (yet), so the per-workspace Agent panel shows the simpler
"active / idle / closed" state derived from the launcher's
30-second marker file. Token totals and per-prompt cost from a
running Codex session aren't surfaced; you can still see them with
`codex` built-in commands inside the terminal.

### MCP mailbox auto-wiring

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
rewrite. `approval_policy = "never"` pre-approves the four mailbox
tools (`send_message`, `read_messages`, `request_review`,
`list_agents`) so Codex doesn't pause for a permission prompt every
time it pokes the mailbox.

Verify the wiring with:

```bash
codex mcp get agent-workspace
# Should print: transport: streamable_http
#               url: http://127.0.0.1:<port>/mcp
#               env_http_headers: X-Agent-Id=AGENT_WORKSPACE_AGENT_ID
```

The dashboard's `/mcp` endpoint accepts agent identity from EITHER
`?agent=<id>` (Claude Code's per-launch config) OR `X-Agent-Id`
header (everyone else), so the same four mailbox tools work across
providers — a Codex session can `send_message(to="Alice")` and an
attached Claude session sees the message in its inbox.

### Manual MCP wiring (Cursor / Gemini)

Cursor Agent's wiring is automatic too — the dashboard writes
`~/.cursor/mcp.json` with the same shape (URL + `${AGENT_WORKSPACE_AGENT_ID}`
header placeholder). Gemini CLI is not auto-wired yet; if you want
the mailbox there, paste this into `~/.gemini/settings.json`:

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

## Agent console UX (quick messages + drag-drop)

The inline agent terminal (per-issue + General Agent) has two
convenience surfaces beyond the bare xterm:

- **Quick-messages bar** — a small segmented control on the same row
  as Start / Disconnect / Stop / Info / Fullscreen. Pick a saved
  message from the dropdown and hit **Send** to drop it into the
  agent's pty as a bracketed-paste + Enter (so claude's TUI auto-
  submits). **➕** adds a new entry; **🗑** removes the picked one.
  The list is stored under the synced pref `quick-messages`, so
  every agent on every machine the user signs into sees the same
  list. Cluster sits flush against the left of the running-status
  text, no internal gap (segmented control).
- **Drag-and-drop into the xterm host** — drag a file from your
  file manager onto any agent's terminal. The dashboard reads
  `text/uri-list` from the drop, decodes `file:///…` to an
  absolute path, and types `@<path> ` into the pty as a
  bracketed-paste. Claude's `@`-references expand the file inline
  (images, PDFs, text — anything it can read). No bytes are
  copied; the agent reads from the file's original location.
  When the source is a browser tab (where the path is hidden by
  the sandbox), the dashboard falls back to **POST
  `/api/agent/upload`** to write the bytes under
  `<agent-cwd>/.claude-uploads/<YYYYMMDD-HHMMSS>-<name>`, capped at
  50 MB. The `@path` insertion does NOT auto-press Enter — the
  user composes their actual prompt around the reference.
- **Disconnect / Reconnect** — a button between Start and Stop
  lets you detach the WebSocket without killing the pty. The
  agent keeps running on the server; reattach later (or from
  another machine) by clicking Reconnect or re-opening the
  dashboard tab. Manual Reconnect skips the scrollback replay
  (`?no_replay=1`) and sends Ctrl-L so claude redraws fresh at
  the current xterm dimensions — avoids the "wide pane wrap
  garble" that pasting old narrow-pty bytes into a fullscreen
  xterm would otherwise cause.

## Stash inspection (cross-repo)

Git stashes live in the underlying repo's `.git/refs/stash`, so they
follow the **primary** rather than any one worktree. The General
Agent's panel has a **💾 Stashes** sub-tab that walks every primary
under `--primaries` and lists stashes from all of them; each issue
tab gets the same sub-tab but pre-filtered to that issue's branch
(matches `<issue>` exactly or with a `_v2` / `+x` suffix).

| Action | What it does |
|---|---|
| **+ / −** toggle on each row | Inline-expand to show the stash's file list (numstat — path · +added · −removed; binary files labelled `binary`). Cached the first time, so re-expanding is instant. |
| **✕** drop button | Hard-deletes the stash via `git stash drop <ref>` after a `confirm()`. No undo. |
| Repo `<select>` + search box | Per-pane filters that AND-combine. Search is a substring match over repo, ref, branch, and message. Persists across the 5-second auto-poll. |

Adding stashes is intentionally left to the agent (`git stash push`
inside whichever worktree); the dashboard is inspect / drop only.

## Dashboard auto-update

The dashboard checks `origin/<branch>` for new commits every 10
minutes (toggle in **Profile → Server → Dashboard auto-update
check**, default ON). When `HEAD` is behind, a banner appears at
the top of the dashboard:

> 🔔 Dashboard update available — N commits behind on master · `<commit subject>` · **[Update now]** **[Later]**

Clicking **Update now**:

1. Lists the live agent terminals that will be stopped (graceful
   `session.close()` — same path as the Stop button, with a 2-second
   flush window so claude writes its session JSONL).
2. Runs `git pull --ff-only` in the dashboard repo.
3. Spawns `bin/agent-worktrees-restart` detached so the helper
   SIGTERMs the running server and respawns a fresh one.
4. The browser shows a "Restarting…" overlay and polls
   `/api/status` until the new server answers, then reloads.

Non-FF divergence (uncommitted local changes, origin diverged)
short-circuits with the git error in a toast — nothing restarts.
**Later** dismisses the banner for the current remote sha; it
re-appears the next time origin advances.

The running dashboard's version is shown at the top of
**Profile → Server → Diagnostics**: e.g. `1.0.0 · b04eb20`. The
human-readable tag comes from the committed `VERSION` file at the
repo root; the short sha is `git rev-parse --short HEAD` at server
start. Quote the full string in bug reports.

## Companion scripts

| Script | Purpose |
|---|---|
| `bin/agent-worktrees-server` | Start the dashboard server. Writes its PID to `~/.cache/agent-workspace/server.<port>.pid` on startup. |
| `bin/agent-worktrees-restart` | Stop the running server (via the per-port pidfile) and start a fresh one detached. Accepts `--port N`; other flags forwarded. Logs to `~/.cache/agent-workspace/server.<port>.log`. |
| `bin/agent-worktrees-stop` | Stop a running server. Reads the per-port pidfile, sends SIGTERM, escalates to SIGKILL on timeout. Accepts `--port N` (default 8765). |
| `bin/agent-worktrees` | Open one terminal tab per `~/github/worktrees/<issue>` with `claude --continue` already running. The system prompt is pre-loaded with workspace / branch context so the session knows what it's working on. Exports `AGENT_WORKSPACE_LAUNCHED=1` so workspace-spawned agents send notifications only to the dashboard (not GNOME notify-send). |
| `bin/agent-workspace-sync` | One-shot of the auto-sync tick (export SQLite → `data/<user>/`, `git add` + commit if changed, push, fetch, ff-only pull). |
| `bin/agent-event-notify` | Hook script invoked by Claude Code (see above). Skips `notify-send` when `AGENT_WORKSPACE_LAUNCHED=1`. |
| `bin/agent-mailbox-inject` | UserPromptSubmit hook — prepends "📬 You have N unread message(s)…" to the agent's next turn when its agent-workspace MCP mailbox has anything. Fail-open: any error / missing dashboard exits 0 with no output so the prompt always goes through. |

## Routes

All HTTP routes are listed in the **API** tab of the help overlay
(press `?` in the dashboard, then click **API**).

## Scheduled backups

Open the **💾 Backup** tab in the profile popover. Configure:
- **Enabled** — toggle the scheduled-backup thread (defaults ON).
- **Every N days** — interval between automatic backups (default 7).
- **Keep last N** — retention; older backup dirs are pruned automatically
  (default 8 ≈ two months of weekly backups).
- **Directory** — where the timestamped backup dirs land. Default
  `${XDG_DATA_HOME:-~/.local/share}/agent-workspace/backups/`.

Each backup produces a timestamped directory containing:

```
<dir>/20260513-091500/
├── activity.sqlite        ← SQLite cache via the Online Backup API
├── manifest.json          ← per-worktree summary
└── worktrees/
    ├── <issue>-<repo>.bundle    ← git bundle of un-pushed commits
    └── …
```

The git bundles capture **only the commits on the local branch that aren't
reachable from `origin/HEAD`** (`git bundle create … upstream..HEAD`), so
they stay tiny — typically a few KB to a few hundred KB per worktree —
and don't duplicate history that's already on the remote. Restore one with:

```bash
cd <worktree>
git fetch <bundle-path> HEAD:<branch-name>
```

**Run backup now** triggers a synchronous backup outside the schedule. The
**History** table records every attempt (including failures) with
timestamp, path, size, and per-worktree status. Failures don't block the
schedule — the next tick tries again.

The **Download DB snapshot** and **Restore from file…** buttons are the
quick one-shot equivalents (SQLite only, no bundles) — the same actions
that previously lived on the Server tab.

## Sync (multi-machine)

The server keeps a SQLite cache at `~/.cache/agent-workspace/activity.sqlite`.
On the auto-sync tick (default 3 h when ON, off by default) it exports the
cache to `data/<user-slug>/` in this repo, commits + pushes, fetches,
ff-only pulls, and re-imports `data/*/`. Each user writes only their own
subfolder, so multi-user shared dashboards don't conflict.

The sync controls in the toolbar are hidden by default — flip the
**Show sync controls** switch in the profile popover to expose `Sync now`
and the `Auto-sync ON/OFF` toggle. The end-of-day reminder + desktop
notification are gated on the same toggle.

## Layout

### Inside the repo

```
agent-workspace/
├── VERSION                ← committed release tag, shown in Profile → Server
├── agent_workspace.py    ← single-file stdlib server (Python 3.10+)
├── awlib/                 ← split-out helpers (notes, backup, agent runtime, …)
├── install.sh             ← one-line bootstrap: clone + setup.sh
├── setup.sh               ← per-machine installer (symlinks, hooks)
├── templates/
│   └── worktrees-AGENTS.md   ← installed by setup.sh into ~/github/worktrees/AGENTS.md,
│                                 read automatically by every dashboard-spawned agent
├── static/                ← dashboard CSS / JS / favicon / manifest / sw.js
├── bin/
│   ├── agent-worktrees-server
│   ├── agent-worktrees-restart
│   ├── agent-worktrees-stop
│   ├── agent-worktrees
│   ├── agent-workspace-sync
│   ├── agent-event-notify
│   └── agent-mailbox-inject
├── completions/           ← bash completions, installed by setup.sh
├── data/                  ← committed: each user's exported state
└── README.md / AGENTS.md
```

### Outside the repo (state the server reads / writes)

The server detects the OS at startup and routes state files to the XDG spec
(Linux / other), Apple's layout (macOS), or Microsoft's
`%LOCALAPPDATA%` / `%APPDATA%` (Windows). The Backup tab can override
`<data-dir>/backups/`.

**Platform-specific paths** (scroll right to see all three columns):

| Purpose | Linux / other | macOS | Windows |
|---|---|---|---|
| SQLite cache — worktree state, commits, agent events, week summaries, preferences, backup history. Per-port instances suffix the port (`activity.<port>.sqlite`). | `~/.cache/agent-workspace/activity.sqlite` | `~/Library/Caches/agent-workspace/activity.sqlite` | `%LOCALAPPDATA%\agent-workspace\activity.sqlite` |
| PID file written by `bin/agent-worktrees-server` for the per-port restart/stop helpers. | `~/.cache/agent-workspace/server.<port>.pid` | `~/Library/Caches/agent-workspace/server.<port>.pid` | `%LOCALAPPDATA%\agent-workspace\server.<port>.pid` |
| nohup log written by `bin/agent-worktrees-restart`. | `~/.cache/agent-workspace/server.<port>.log` | `~/Library/Caches/agent-workspace/server.<port>.log` | `%LOCALAPPDATA%\agent-workspace\server.<port>.log` |
| Scheduled-backup directory tree — one `YYYYMMDD-HHMMSS/` subdir per backup with `activity.sqlite` + `manifest.json` + `worktrees/<issue>-<repo>.bundle`. Configurable from the Backup tab. | `~/.local/share/agent-workspace/backups/` | `~/Library/Application Support/agent-workspace/backups/` | `%APPDATA%\agent-workspace\backups\` |
| Scripts installed by `setup.sh`. Override with `--target=…`. | `~/.local/bin/agent-worktrees*` | same | `~/bin/agent-worktrees*` (file copies, not symlinks) |
| Optional on-login autostart entry installed by `setup.sh --autostart`. | `~/.config/autostart/agent-workspace.desktop` | `~/Library/LaunchAgents/io.github.agent-workspace.plist` | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-workspace.vbs` |

**Common to all platforms** (same path on Linux, macOS, and Windows):

| Path | Purpose |
|---|---|
| `~/.config/agent-workspace/sync.conf` | One-line file containing the opt-in sync repo URL. Created by `setup.sh --sync-repo <url>`. |
| `~/.local/share/bash-completion/completions/` | Bash completion files installed by `setup.sh`. |
| `~/.config/systemd/user/agent-workspace.service` | Optional systemd user unit installed by `setup.sh --systemd` (Linux only; macOS uses launchd, Windows Task Scheduler). |
| `~/.claude/settings.json` | Claude Code config — `setup.sh --enable-claude-hooks` merges hook entries here. |
| `~/.claude/projects/<encoded>/*.jsonl` | Claude Code session transcripts — the dashboard reads these for agent activity / token rollups. Not modified. |
| `~/github/worktrees/<issue>/<repo>/` | The actual worktrees the dashboard reports on (`--worktrees PATH` to override). Read-only from the server. |
| `~/github/<repo>/` | The primary checkouts (`--primaries PATH` to override). Server may `git worktree add` here to materialize missing worktrees, but does not modify branches or commits. |

Notes:

- macOS — the `~/Library/...` paths are always used (the Python helper
  short-circuits on `sys.platform == 'darwin'` before consulting
  `XDG_*_HOME`).
- Windows — the same short-circuit on `sys.platform == 'win32'`
  always routes to `%LOCALAPPDATA%` / `%APPDATA%`; XDG env vars
  aren't consulted.
- Linux — set `XDG_CACHE_HOME` / `XDG_DATA_HOME` to relocate the
  cache and backup roots if you don't like the defaults.

## Run as a container (podman or docker)

The repo ships a `Dockerfile` + `compose.yaml`. The image is ~230 MB and
only needs Python + git + ssh client.

```bash
podman build -t agent-workspace:latest .
podman compose up -d
# → http://127.0.0.1:8765/
```

See `AGENTS.md` for mount semantics. The `🖥 Open in terminal tabs` button
and the `↗ Open in editor` buttons don't work inside the container (no
GUI binaries) — run `bin/agent-worktrees-server` on the host directly
when you want those.

## Security: pin agent CLI versions

`agent-workspace` itself ships **zero runtime dependencies** — the
server is single-file Python stdlib only. There's no `requirements.txt`,
no `package.json`, nothing for `pip` / `npm` to pull on first run.
That side of the supply chain is deliberately small.

The **agent CLIs** you install are a different story. Each one's
upstream releases freely (Claude Code multiple times a week, Codex
weekly, etc.) and several of them quietly self-update on launch.
Some teams want explicit control over when those move. Recommended
pattern: pin a known-good version + disable each tool's auto-updater.

### npm-installed CLIs (Claude Code, Codex, Gemini)

```bash
# Pin on first install (record the version you want)
npm install -g @anthropic-ai/claude-code@2.1.5
npm install -g @openai/codex@0.133.0
npm install -g @google/gemini-cli@0.4.2

# Lock npm itself to exact-version semantics for any global install
npm config set save-exact true
```

Disable per-CLI auto-update (where supported):

```bash
# Claude Code
claude config set -g autoUpdates false

# Codex CLI — no built-in updater, but if you've installed it via
# `npx` it'll pull `@latest` every launch. Switch to a pinned
# global install per the line above.

# Gemini CLI — auto-update flag is in ~/.gemini/settings.json:
#   { "autoUpdate": false, ... }
```

Upgrade is then a deliberate two-line action:

```bash
npm view @anthropic-ai/claude-code version           # see what's out
npm install -g @anthropic-ai/claude-code@<version>   # pin to the new one
```

### pipx-installed CLIs (Aider)

```bash
# Pin on first install
pipx install aider-chat==0.74.0

# pipx never auto-upgrades the binary it manages — you have to ask
pipx upgrade aider-chat                  # upgrades to the latest stable
pipx install --force aider-chat==<ver>   # pin to a specific version
```

### Other CLIs

- **Cursor Agent** — installed via the upstream shell script; that
  script always grabs the latest. Re-run it deliberately to upgrade.
- **Crush** — `go install …@<version>` pins by ref. Re-run the same
  command with a new tag to upgrade.

### Audit / inventory

Quick "what's currently installed" check:

```bash
npm ls -g --depth=0 2>/dev/null | grep -E 'claude-code|codex|gemini-cli'
pipx list 2>/dev/null | grep -i aider
cursor-agent --version 2>/dev/null
crush --version 2>/dev/null
```

The dashboard's **Profile → Agent CLI** tab surfaces the binary path
for each detected provider, so you can cross-check against your
recorded pins at a glance.

## Troubleshooting

- **No commits in heatmap.** The scan filters by the local-part of
  `git config user.email` and excludes commits already on `origin/master`
  or any `v[0-9]*` release branch (those are released, not work-in-progress).
- **Events not appearing.** Run `./setup.sh --enable-claude-hooks` once
  per machine. `bin/agent-event-notify` POSTs to
  `http://127.0.0.1:${AGENT_WORKSPACE_PORT:-8765}` — set the env var if
  you've moved the port. Failures are silent (best-effort) so the hook
  never blocks Claude.
- **`auto-sync disabled` on startup.** You launched with `--no-sync` /
  `--sync-interval=0`, or sync is just off in the profile toggle.
- **Sync errors in stderr.** Most are non-fatal: missing remote, push auth
  issues, or origin diverged so `pull --ff-only` declined.
- **Browser shows stale data.** The dashboard auto-refreshes every 5 min;
  use the `↻ Refresh now` button for an immediate refetch.
