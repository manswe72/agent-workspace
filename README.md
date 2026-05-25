# Agent Workspace · Status Board

A local HTTP dashboard for `~/git/worktrees/<issue>/<repo>` — your
**Agent Workspace · Status Board**. Shows git status across every
active issue branch, time tracking, week summaries, agent
events from Claude Code hooks, and a server diagnostics console. Light /
dark theme via system preference, auto-refresh every 5 minutes.

Single-file Python stdlib server (no deps), SQLite cache, vanilla JS
frontend. The server is read-only against your worktrees — it never runs
git mutations on your behalf — but it does ingest events that Claude Code
posts via hooks (see *Agent events* below).

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
- **🤖 Claude agent**: per-issue rollup of session activity (token totals,
  cost, top tools, last prompt, …). Two inner tabs: *Activity* and
  *Messages*. Messages shows recent agent events with read/unread
  styling — auto-marked read when the pane is opened.

## Quick start

```bash
git clone <agent-workspace-url> ~/git/agent-workspace
cd ~/git/agent-workspace
./setup.sh
```

`setup.sh` checks prerequisites (Python ≥ 3.10, git), symlinks the binaries
into `~/.local/bin`, installs bash completions
credentials, and offers to wire Claude Code hooks. On Linux it also drops a
**Claude Workspace** app-launcher entry under
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
git clone <agent-workspace-url> ~/git/agent-workspace
cd ~/git/agent-workspace
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
git clone <agent-workspace-url> ~/git/agent-workspace
cd ~/git/agent-workspace
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

## Agent events (Claude Code hooks)

Claude Code can post events to the dashboard via hooks. Run
`./setup.sh --enable-claude-hooks` (idempotent) to merge entries into
`~/.claude/settings.json` for `Stop`, `Notification`, `UserPromptSubmit`,
`SessionStart`, and `SessionEnd`. The hook script
`bin/agent-event-notify`:
- POSTs `{kind, issue, session_id, message, cwd}` to `/api/events`
- fires `notify-send` for `Notification` + `Stop` events on Linux

The dashboard surfaces unread events as a `🔔N` pill on the issue tab and
in the per-issue agent block's *Messages* pane. Marking events read
clears the badge. Disable any time with `./setup.sh --disable-claude-hooks`.

## Agent-to-agent messaging (agent-workspace MCP)

Every agent the dashboard launches (per-issue Inline Agent + the pinned
General Agent) gets an in-process MCP server registered automatically so
agents can talk to each other. The server's slug is
`agentic-engineering`; tools appear in `/mcp` inside any claude session
spawned through the dashboard:

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
| `bin/agent-worktrees` | Open one terminal tab per `~/git/worktrees/<issue>` with `claude --continue` already running. The system prompt is pre-loaded with workspace / branch context so the session knows what it's working on. Exports `AGENT_WORKSPACE_LAUNCHED=1` so workspace-spawned agents send notifications only to the dashboard (not GNOME notify-send). |
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
│   └── worktrees-AGENTS.md   ← installed by setup.sh into ~/git/worktrees/AGENTS.md,
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
| `~/git/worktrees/<issue>/<repo>/` | The actual worktrees the dashboard reports on (`--worktrees PATH` to override). Read-only from the server. |
| `~/git/<repo>/` | The primary checkouts (`--primaries PATH` to override). Server may `git worktree add` here to materialize missing worktrees, but does not modify branches or commits. |

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
