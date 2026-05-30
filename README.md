<p align="center">
  <img src="docs/screenshots/dashboard.png?v=2"
       alt="Agent Workspace dashboard — Agent Engineering tab with workspace stats, agent picker, and embedded terminal"
       width="900">
</p>

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
the [Claude Code provider doc](docs/providers/claude-code.md)).

## Agent CLI providers

Six providers ship out of the box. Pick one in **Profile → Agent
CLI**. The dashboard auto-detects which are on PATH; rows for
missing binaries are greyed out until you install the tool.

Each provider has its own doc with install, auth, MCP wiring, and
the details of what's surfaced in the dashboard. Click through:

[**Claude Code**](docs/providers/claude-code.md) ·
[**OpenAI Codex CLI**](docs/providers/codex.md) ·
[**Cursor Agent**](docs/providers/cursor.md) ·
[**Gemini CLI**](docs/providers/gemini.md) ·
[**Aider**](docs/providers/aider.md) ·
[**Crush**](docs/providers/crush.md)

Capability summary:

| Provider | Binary | Install | Resume in cwd | MCP auto | Hooks |
|---|---|---|---|---|---|
| [Claude Code (Anthropic)](docs/providers/claude-code.md) | `claude` | `npm install -g @anthropic-ai/claude-code` | `claude --continue` | ✓ | ✓ |
| [OpenAI Codex CLI](docs/providers/codex.md) (open source) | `codex` | `npm install -g @openai/codex` | `codex resume --last` | ✓ | — |
| [Cursor Agent](docs/providers/cursor.md) | `cursor-agent` | `curl https://cursor.com/install -fsS \| bash` | `cursor-agent resume` | ✓ | — |
| [Gemini CLI](docs/providers/gemini.md) (open source) | `gemini` | `npm install -g @google/gemini-cli` | `/chat resume <tag>` (interactive) | ✓ | — |
| [Aider](docs/providers/aider.md) (open source) | `aider` | `pipx install aider-chat` | auto (`.aider.chat.history.md`) | — | — |
| [Crush](docs/providers/crush.md) (Charm, open source) | `crush` | `go install github.com/charmbracelet/crush/cmd/crush@latest` | per-cwd, interactive | — | — |

The launcher gives every provider the same workspace context (cwd,
branch, system prompt). Session liveness for non-Claude providers
is tracked via a marker file the launcher touches every 30 s.
Lifecycle hooks (Stop / Notification / etc. → `/api/events`) only
fire on Claude Code — the other CLIs don't have an equivalent
mechanism. MCP is broader: Claude / Codex / Cursor / Gemini all
auto-register the dashboard's in-process mailbox server; Aider and
Crush have no MCP client.

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
- **🐙 GitHub modal** (toolbar button) — three tables:
  - **Issues assigned to you** — Repo / # / Title / State / Workspace
    / Model / Actions columns. **+ Add** opens a per-issue dialog
    with checkboxes for each configured repo (defaults to all) so
    multi-repo issues can clone just the relevant subset; an
    **Also create GitHub issue** checkbox optionally opens a GitHub
    issue at the same time (title + body, auto-assigned to you).
    **🗑 Remove** walks `/api/issue/remove` and surfaces partial
    failures.
  - **Open issues (no assignee)** — same column shape; **+ Add**
    prompts to claim (assign yourself) before creating the worktree.
  - **Open PRs** — Repo / # / Title / State / Workspace columns.
    Lists every open PR in the configured repos. A **My recent closed
    / merged PRs** sub-section shows your own merged and closed PRs
    (separate from the full open-PR list, which would grow unbounded).
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

  The Agent block has **sub-tabs** selectable from the bar above it:

  | Sub-tab | Per-issue workspace | General Agent |
  |---|---|---|
  | **Agent** | Inline terminal | Inline terminal |
  | **Branches** | Branches across the issue's worktrees | — |
  | **Messages** | — | Agent-to-agent inbox/outbox |
  | **Delegations 🎯** | Delegations assigned to this workspace | Hub delegation board |
  | **Stashes** | Stashes filtered to this issue | All stashes across primaries |

  In **fullscreen mode** (`⤢` button or `F` shortcut) the sub-tab row
  stays visible with pinned **Exit fullscreen** and **◀ ▶** navigation
  buttons so you can switch sub-tabs and move between workspaces without
  leaving fullscreen.

  Each workspace tab also has a **Create PR** button (when the workspace
  has a branch with unpushed or pushed commits) that opens a dialog
  pre-filled with the branch name, lets you choose base branch, write
  a title and body, and optionally force-push before opening the PR via
  the GitHub REST API.

## Quick start

```bash
curl -fsSLO https://github.com/manswe72/agent-workspace/releases/latest/download/agent-workspace.tar.gz
tar xzf agent-workspace.tar.gz
cd agent-workspace-*/
./install.sh
agent-worktrees-server
```

Full details — prerequisites, per-platform notes, upgrade, uninstall,
troubleshooting, developer install — live in **[INSTALL.md](INSTALL.md)**.

`install.sh` is a thin wrapper around `setup.sh` (the real per-machine
installer). A release install ships **just the source files needed to
run the server** — no `.git/`, no tests, no packaging scaffolding. The
in-app **Update server** button is greyed out in this mode; upgrade
by re-running the curl above.

On Linux the installer also drops an **Agent Workspace** app-launcher
entry under `~/.local/share/applications/` (so the dashboard shows up
in your system menu / dock — clicking it starts the server if needed
and opens the dashboard) and offers to register an autostart entry so
the server starts on login. The per-platform mechanism is auto-detected:

| Platform | Autostart mechanism |
|---|---|
| Linux | XDG autostart — `~/.config/autostart/agent-workspace.desktop` |
| macOS | LaunchAgent — `~/Library/LaunchAgents/io.github.agent-workspace.plist` (bootstrapped via `launchctl`) |
| Windows / Git Bash | Startup folder — `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-workspace.vbs` (silent .vbs launcher, no console window) |

The autostart prompt can be skipped with `--no-autostart` or pre-answered
yes with `--autostart`. `./install.sh --uninstall` removes whichever entry
matches the current OS.

### GNOME Shell extension (Linux)

`setup.sh` also installs a GNOME Shell extension
(`packaging/gnome-shell/agentic-workspace@manswe72.github.io/`) that puts
the dashboard status directly in the GNOME Shell:

- **Quick Settings tile** (default) — a toggle in the same panel as Wi-Fi /
  Bluetooth / Dark Mode. Green = running, grey = stopped; click to
  start/stop. Expand the tile for "Open dashboard" and "Copy URL".
- **Top-bar status icon** — a classic top-bar indicator with a popup menu
  (Running / Stopped, Start / Stop / Open / Copy URL). Switch modes in the
  extension preferences.

The extension detects the server via `/proc/net/tcp` (authoritative even
when the pidfile is stale) and polls every 5 seconds. "Open dashboard"
launches the PWA window if installed, otherwise falls back to `xdg-open`.

Install / update manually:

```bash
cd ~/github/agent-workspace
./setup.sh          # installs or updates the extension in place
# then restart GNOME Shell: Alt+F2 → r → Enter  (or log out/in on Wayland)
```

Enable via the [GNOME Extensions](https://extensions.gnome.org/) app or:

```bash
gnome-extensions enable agentic-workspace@manswe72.github.io
```

Set the port or UI mode in **GNOME Extensions → Agentic Engineering
Workspace → Preferences** (or via `gnome-extensions prefs
agentic-workspace@manswe72.github.io`). The `AGENT_WORKSPACE_PORT`
environment variable overrides the preference if set in the session.

Then:

```bash
agent-worktrees-server         # start the dashboard
# → opens http://127.0.0.1:8765/ in your browser
```

Tested on Linux, macOS, and Windows (via Git Bash). The per-platform
notes below cover the small differences.

### Developer install

Hacking on the source? Clone the repo instead of using the tarball
so the in-app **Update server** button stays wired up to `git pull`:

```bash
git clone <agent-workspace-url> ~/github/agent-workspace
cd ~/github/agent-workspace
./setup.sh
```

Same prerequisites, same `~/.local/bin` symlinks, same autostart
prompts. The only differences are:

- `setup.sh` installs the local pre-push hook (ruff + pytest before
  every `git push`).
- The dashboard detects the `.git/` directory and enables the
  Update server button + auto-update-check toggle in
  Profile → Server.

Build a release tarball for distribution with:

```bash
./bin/build-release-tarball.sh
# → dist/agent-workspace-<VERSION>.tar.gz
```

Cut a full GitHub release (tag + tarball upload + release notes) in
one command. Requires the [`gh` CLI](https://cli.github.com/) and a
prior `gh auth login`:

```bash
./bin/release.sh                       # release current VERSION
./bin/release.sh --version 0.2.0       # bump VERSION + release
./bin/release.sh --dry-run             # print plan, no changes
```

Release notes default to commit subjects since the previous tag.
Override with `--notes "..."` or `--notes-file CHANGELOG.md`. Pass
`--draft` to stage a release without publishing it, `--prerelease`
to mark a non-stable version.

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
tar xzf agent-workspace-*.tar.gz
cd agent-workspace-*/
./install.sh
agent-worktrees-server
```

`~/bin` is on Git Bash's PATH by default, so `agent-worktrees-server`,
`agent-worktrees-restart`, and `agent-worktrees-stop` are
immediately available in any new shell. (Or `git clone` + `./setup.sh`
for a developer install — see [Developer install](#developer-install).)

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
| 💻 Console button (opens a terminal tab with the active Agent CLI) | ✅ Terminal.app via AppleScript (auto-detected); Ghostty also supported if installed |
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
tar xzf agent-workspace-*.tar.gz
cd agent-workspace-*/
./install.sh
agent-worktrees-server
```

Grant the dashboard tab Web Notification permission from the toolbar so
agent events still surface on your desktop. The in-page toast pop-up
works on macOS regardless. (Or `git clone` + `./setup.sh` for a
developer install — see [Developer install](#developer-install).)

### Install as a PWA (recommended on every platform)

The dashboard ships a `manifest.json` + service worker, so Chromium-based
browsers (Chrome, Edge, Brave, Arc, Vivaldi) expose an **Install Claude
Workspace…** prompt in the address bar (or three-dot menu → Apps →
Install). Safari 17+ supports it via **File → Add to Dock…**. On GNOME
the Files app exposes the same as **Install as App** when you're in
Chromium.

There's also a **📥 Install app** button in the dashboard toolbar — it
triggers the browser's native install prompt directly, so you don't have
to hunt through browser menus. The button only appears when the browser
has signalled that the PWA is installable (i.e., the `beforeinstallprompt`
event has fired — Chromium-based browsers only; Firefox does not support
PWA install).

When the server is launched via the `agent-workspace-launch` helper (the
desktop entry installed by `setup.sh`) it uses `--app=<URL>` on
Chromium-family browsers to open a standalone chromeless window, skipping
the install step entirely for a native-app look. Falls back to
`xdg-open` / `open` for Firefox / Safari users.

Installing gives you:

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

## Per-provider docs

Each provider's deep section moved to its own file under
`docs/providers/`. The list below summarises what's where:

| File | Covers |
|---|---|
| [`docs/providers/claude-code.md`](docs/providers/claude-code.md) | Anthropic CLI. Session-log token / cost tracking, lifecycle hooks (Stop / Notification / SessionStart / etc.), MCP mailbox auto-wiring, hand-curated model picker. |
| [`docs/providers/codex.md`](docs/providers/codex.md) | OpenAI Codex CLI. Install + `OPENAI_API_KEY`, MCP auto-wiring (`~/.codex/config.toml`), `codex mcp get` verification. |
| [`docs/providers/cursor.md`](docs/providers/cursor.md) | Cursor Agent. Install via cursor.com script, MCP auto-wiring (`~/.cursor/mcp.json`). |
| [`docs/providers/gemini.md`](docs/providers/gemini.md) | Gemini CLI. Install + auth, MCP auto-wiring (`~/.gemini/settings.json`). |
| [`docs/providers/aider.md`](docs/providers/aider.md) | Aider. No MCP / no hooks; pass-through launcher only. |
| [`docs/providers/crush.md`](docs/providers/crush.md) | Crush by Charmbracelet. No MCP / no hooks; pass-through launcher only. |

### MCP — agent-to-agent messaging

All four MCP-capable providers expose the same five tools — they
hit the dashboard's in-process MCP server at
`http://127.0.0.1:<port>/mcp`. Agent identity flows through either
the `?agent=<id>` query (Claude Code) or the `X-Agent-Id` header
(Codex / Cursor / Gemini), so cross-provider messaging just works:

| Tool | What it does |
|---|---|
| `send_message(to, text, in_reply_to?)` | Send a message to another agent. Recipient is a workspace id (`1-fix-auth`), a display name (set in the GitHub modal's ✏ rename, e.g. `Alice`), or `__agent__` (`Agent 007`). |
| `read_messages(unread_only?, limit?)` | Fetch this agent's inbox. Marks each row read. |
| `request_review(target, ref, context?)` | Convenience wrapper that drops a structured `review_request` (with a git sha / branch / path in `ref`) into the target's mailbox. |
| `list_agents(live_only?)` | Returns every agent id + display name + state. Use before `send_message` to pick a recipient that's actually online. |
| `broadcast_message(text)` | Fan one message out to every live workspace agent (the General Agent + the caller are excluded). |

Three additional **hub-and-spoke tools** are available to the General Agent only
(workspace agents that try to call `delegate` get an error — they're spokes,
not hubs):

| Tool | What it does |
|---|---|
| `delegate(to, task, context?, deadline?)` | Hand a piece of work to a specific workspace agent and track its completion. The recipient sees a `📋 Delegation` message. Their `send_message` reply (with `in_reply_to=<delegation_id>`) marks it resolved. Use this instead of `send_message` when you need an answer back. |
| `route(pattern, text, exclude_self?)` | Fan a message to every agent whose id or display name matches a substring (e.g. `'docs'`) or regex (e.g. `'/^[0-9]+-/'`). Caps regex length at 128 chars. |
| `list_delegations(status?, mine_only?, to_me?)` | Status board — every delegation with its state (`open` / `resolved`), sender, recipient, and resolver reply. The Delegations sub-tab in the dashboard calls this automatically; agents can also call it directly with `to_me=true` to see what's been delegated to them. |

The **🎯 Delegations** sub-tab on both the General Agent panel and each workspace
panel shows this board live, auto-refreshed every 5 seconds. Status chips
(`open` / `resolved`) are click-to-filter.

How agents pick up new mail:

1. **Auto-poll** — when **Profile → Dashboard → Agents → Mailbox
   auto-poll** is on (default ON), the dashboard scans live pty
   sessions every 20 s. If an attached agent has unread mail AND the
   user has been idle in its terminal for ≥15 s, the dashboard types
   a bracketed-paste nudge prompt + Enter so the TUI auto-submits.
   Per-agent throttle (≥60 s between nudges).
2. **Tab badge** — a `📬N` chip on the General Agent tab and on each
   workspace tab counts unread mail.

Per-provider extras layer on top — see each provider's doc for the
extras (e.g. Claude Code's `UserPromptSubmit` hook that prepends the
unread-mail summary to the next turn).

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
MCP wiring and the `📬` badge is hidden.

State lives in the dashboard's SQLite `agent_messages` table and
never leaves this machine.

### Per-workspace overrides

The 🐙 GitHub modal has an **Agent** column and a **Model** column
per issue row. Setting them stores
`workspace-provider-<id>` / `workspace-model-<id>` preferences;
those override the per-provider defaults (set in
**Profile → Agent CLI** and **Profile → Model**) when the workspace
launches.

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
| `bin/agent-worktrees-restart` | Stop the running server (via the per-port pidfile) and start a fresh one detached. Accepts `--port N`; other flags forwarded. Logs to `~/.cache/agent-workspace/server.<port>.log`. `bin/agent-workspace-restart` is a legacy-alias symlink to the same script. |
| `bin/agent-worktrees-stop` | Stop a running server. Reads the per-port pidfile, sends SIGTERM, escalates to SIGKILL on timeout. Accepts `--port N` (default 8765). |
| `bin/agent-worktrees` | Open one terminal tab per `~/github/worktrees/<issue>` with `claude --continue` already running. The system prompt is pre-loaded with workspace / branch context so the session knows what it's working on. Exports `AGENT_WORKSPACE_LAUNCHED=1` so workspace-spawned agents send notifications only to the dashboard (not GNOME notify-send). |
| `bin/agent-workspace-launch` | Used by the freedesktop `.desktop` entry installed under `~/.local/share/applications/`. Starts the server if it isn't already running (silent no-op if it is), then opens the dashboard — `--app=<URL>` to a Chromium-family browser for a standalone window, falling back to `xdg-open` / `open`. |
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
├── bin/                   ← launcher + helper scripts (see Companion scripts)
├── completions/           ← bash completions, installed by setup.sh
├── data/                  ← committed: each user's exported state
└── README.md              ← this file (user-facing)
    AGENTS.md              ← agent-facing companion (symlinked from CLAUDE.md)
    INSTALL.md             ← release-install + per-platform notes
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

Mount semantics are defined in `compose.yaml`. The `🖥 Open in terminal
tabs` button and the `↗ Open in editor` buttons don't work inside the
container (no GUI binaries) — run `bin/agent-worktrees-server` on the
host directly when you want those.

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
