# Setting up `agent-workspace`

A local HTTP dashboard for monitoring git worktrees across every
`~/github/worktrees/<issue>/<repo>`, agent-to-agent messaging, time
tracking, GitHub integration, and an embedded agent terminal. State
is persisted to SQLite and optionally synced across machines.

## ⛔ HARD STOP — agents must NEVER restart the agent-workspace server

If you are an AI agent running inside Claude Code, you are very likely
running **as a child process of the very `agent_workspace.py` server this
repo defines**. Restarting that server kills its agent terminal subprocesses
— including yourself — mid-turn. Your tool calls will be aborted, the user's
session will drop, and no follow-up can run.

**Never do any of the following on your own initiative:**

- `kill`/`pkill`/`killall` against `agent_workspace.py`, `agent-worktrees-server`, or anything bound to port `8765`
- `POST /api/restart`, `POST /api/update`, or any endpoint that respawns the server
- `bin/agent-worktrees-restart` or any wrapper that calls it
- `podman/docker compose restart`, `podman/docker restart agent-workspace`, `podman/docker kill`, `systemctl restart …`
- Editing files and then "applying changes" by restarting the server

If a code change you made needs the server to pick it up, **say so and stop**
— the user will restart it themselves. The only acceptable agent action is
*starting* the server when it is verifiably not running (no listener on
`127.0.0.1:8765`).

This is a hard rule, not a preference. There is no scenario in which an
agent should restart this server.

## Quick start

```bash
# Release install (end-user path)
curl -fsSLO https://github.com/manswe72/agent-workspace/releases/latest/download/agent-workspace.tar.gz
tar xzf agent-workspace.tar.gz
cd agent-workspace-*/
./install.sh
agent-worktrees-server

# Developer install (hacking on the source)
git clone <agent-workspace-url> ~/github/agent-workspace
cd ~/github/agent-workspace
./setup.sh
agent-worktrees-server
```

The server prints its URL (default `http://127.0.0.1:8765`) and opens
your default browser. CLI flags:

| Flag | Default | Purpose |
|---|---|---|
| `--worktrees PATH` | `~/github/worktrees` | Root containing one dir per active issue |
| `--port N` | `8765` | HTTP port |
| `--behind N` | `50` | Warn when a branch is more than N commits behind upstream |
| `--no-open` | — | Don't pop a browser tab on startup |
| `--sync-interval N` | `300` | Auto-sync loop interval in seconds |
| `--no-sync` | — | Disable auto-sync entirely |

## Key endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Dashboard HTML |
| `GET /api/status[?show_ghosts=1]` | JSON snapshot of every worktree on disk |
| `GET /api/heatmap` | Commit-per-day series (365 days) for the heatmap card |
| `GET /api/github/issues` | Open issues in configured repos |
| `GET /api/github/prs` | Open PRs in configured repos |
| `POST /api/github/issue/create` | Create a GitHub issue and optionally its local worktree |
| `POST /api/github/prs/my-closed` | Fetch the calling user's closed/merged PRs |
| `GET /api/mcp/delegations` | Delegation board (hub-and-spoke MCP) |
| `GET /mcp` | MCP JSON-RPC 2.0 endpoint for agent-to-agent messaging |
| `GET /static/{dashboard.css,dashboard.js,…}` | Static assets |

All routes are listed in the **API** tab of the dashboard's help overlay
(press `?` in the dashboard).

## How sync works

The server keeps a SQLite cache at
`~/.cache/agent-workspace/activity.sqlite`. On every auto-sync tick the
server:

1. Exports the SQLite cache to `data/<your-user-slug>/` in this repo.
2. If those files changed, runs `git add → commit → push`.
3. Runs `git fetch origin`. If origin has advanced, `git pull --ff-only`
   and replays every `data/*/` folder back into SQLite.

Manual one-shot sync (server doesn't have to be running):

```bash
~/github/agent-workspace/bin/agent-workspace-sync
```

## MCP — agent-to-agent messaging

The dashboard runs an in-process MCP server at `/mcp`. Claude Code,
Codex CLI, Cursor Agent, and Gemini CLI sessions auto-register it at
launch. Eight tools are exposed:

### Standard tools (all agents)

| Tool | What it does |
|---|---|
| `read_messages(unread_only?, limit?)` | Check inbox. Call at the start of every turn. |
| `send_message(to, text, in_reply_to?)` | Send to a workspace id, display name, or `__agent__`. |
| `request_review(target, ref, context?)` | Drop a `review_request` into another agent's inbox. |
| `list_agents(live_only?)` | List every agent id + display name + state. |
| `broadcast_message(text)` | Fan one message to every live workspace agent. |

### Hub-and-spoke tools (General Agent only)

| Tool | What it does |
|---|---|
| `delegate(to, task, context?, deadline?)` | Hand work to a spoke and track completion. Use instead of `send_message` when you need a reply. |
| `route(pattern, text, exclude_self?)` | Fan to every agent whose id/name matches a substring or `/regex/`. |
| `list_delegations(status?, mine_only?, to_me?)` | Delegation status board — open / resolved, sender, recipient, reply text. |

Workspace agents that call `delegate` receive an error (they're spokes,
not hubs). The **🎯 Delegations** sub-tab in the dashboard renders the
board live, auto-refreshed every 5 seconds.

## Developer tooling

```bash
# Run tests
pytest tests/

# Lint
ruff check .

# Build a release tarball
./bin/build-release-tarball.sh
# → dist/agent-workspace-<VERSION>.tar.gz

# Cut a full GitHub release (tag + tarball + release notes)
./bin/release.sh
./bin/release.sh --version 0.2.0
./bin/release.sh --dry-run
```

The pre-push hook (installed by `setup.sh`) runs `ruff` + `pytest`
automatically before every `git push`.

## New machine / multi-user

Each user writes only to their own `data/<user-slug>/` subfolder. The
heatmap is filtered by the local `git config user.email` so it always
shows *your* commits only, regardless of how many people are syncing.

## Run as a container (podman or docker)

```bash
podman build -t agent-workspace:latest .
podman compose up -d
# → http://127.0.0.1:8765/
```

Mount semantics are in `compose.yaml`. The agent terminal, editor open
buttons, and console buttons don't work inside the container — run the
server on the host when you want those.

## Layout

```
agent-workspace/
├── VERSION                ← committed release tag
├── agent_workspace.py    ← single-file stdlib server (Python 3.10+)
├── awlib/                 ← split-out helpers: backup, agent runtime, MCP, GitHub
│   ├── agent_mcp.py       ← MCP JSON-RPC server + hub-and-spoke tools
│   └── github.py          ← GitHub REST helpers (issues, PRs, create)
├── install.sh             ← tarball-aware end-user installer
├── setup.sh               ← per-machine developer installer (symlinks, hooks)
├── templates/
│   └── worktrees-AGENTS.md   ← installed to ~/github/worktrees/AGENTS.md
├── static/                ← dashboard CSS / JS / manifest / sw.js
├── bin/
│   ├── agent-worktrees-server
│   ├── agent-worktrees-restart
│   ├── agent-worktrees-stop
│   ├── agent-worktrees
│   ├── agent-workspace-launch   ← desktop launcher (--app= PWA style)
│   ├── agent-workspace-sync
│   ├── agent-event-notify
│   ├── agent-mailbox-inject
│   ├── build-release-tarball.sh
│   └── release.sh
├── completions/           ← bash completions
├── packaging/
│   └── gnome-shell/
│       └── agentic-workspace@manswe72.github.io/   ← GNOME Shell extension
├── tests/                 ← pytest suite
├── data/                  ← committed: each user's exported state
└── README.md / AGENTS.md / INSTALL.md
```

## Troubleshooting

- **No commits in heatmap.** The scan filters by the local-part of
  `git config user.email`. If you've changed that recently, old commits
  under a different domain are still picked up (local-part match only).
- **Events not appearing.** Run `./setup.sh --enable-claude-hooks` once
  per machine.
- **`auto-sync disabled` on startup.** You launched with `--no-sync` /
  `--sync-interval=0`.
- **Sync errors in stderr.** Most are non-fatal: missing remote, push auth
  issues, or origin diverged so `pull --ff-only` declined.
- **Ghost worktrees not appearing.** Toggle "Show removed worktrees" in
  the toolbar filters row.
- **Browser shows stale data.** Use the `↻ Refresh now` button.
- **Update button greyed out.** This is a release install (no `.git/`
  directory). Re-run the `curl` quick-start to upgrade, or switch to a
  developer install with `git clone` + `./setup.sh`.
