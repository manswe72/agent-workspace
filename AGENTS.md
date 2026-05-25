# Setting up `agent-workspace`

A small local HTTP dashboard that shows the state of every
`~/github/worktrees/<issue>/<repo>` and surfaces a GitHub-style activity heatmap
of *your* commits. Status is collected on demand; activity is persisted to
SQLite and (optionally) synced across machines via this very repo.

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

## One-machine setup

```bash
git clone <agent-workspace-url> ~/github/agent-workspace
~/github/agent-workspace/bin/agent-worktrees-server
# or:
python3 ~/github/agent-workspace/agent_workspace.py
```

The server prints its URL (default `http://127.0.0.1:8765`) and opens your
default browser to it. CLI flags:

| Flag | Default | Purpose |
|---|---|---|
| `--worktrees PATH` | `~/github/worktrees` | Root that contains one dir per active issue |
| `--port N` | `8765` | HTTP port |
| `--behind N` | `50` | Warn when a branch is more than N commits behind upstream |
| `--no-open` | — | Don't pop a browser tab on startup |
| `--sync-interval N` | `300` | Auto-sync loop interval in seconds (export + commit + push + fetch + pull) |
| `--no-sync` | — | Disable auto-sync entirely |

## What the server does

| Endpoint | Purpose |
|---|---|
| `GET /` | The dashboard HTML. State data is inlined as JSON for the JS to consume. |
| `GET /api/status[?show_ghosts=1]` | JSON snapshot of every worktree currently on disk (and, optionally, "ghost" worktrees that have been removed). Re-fetched by the browser every 5 minutes. |
| `GET /api/heatmap` | Zero-filled commit-per-day series for the last 365 days, used to render the heatmap card. |
| `POST /api/open-agent-tab` | Body `{issue: "BSS-XXXX"}`. Spawns `bin/agent-worktrees --issue=<key>` to open a single new gnome-terminal tab attached to the user's existing window with `claude --continue` running in the right worktree. Triggered by the per-issue "💻 Console" button. |
| `GET /favicon.ico` | Redirects to the inline SVG favicon. |
| `GET /static/{dashboard.css,dashboard.js,favicon.svg}` | Static assets. |

## How sync works

The server keeps a small SQLite cache at
`~/.cache/agent-workspace/activity.sqlite` with two tables:

- `commits` — every commit *you* (matching `git config user.email`'s
  local-part) authored on a worktree's branch, used for the heatmap.
- `worktrees` — last-known status of every worktree the server has seen
  (so the dashboard can surface "ghost" worktrees that no longer exist
  on disk).

On every auto-sync tick (default every 5 min) the server:

1. Exports the SQLite cache to `data/<your-user-slug>/commits.jsonl` +
   `worktrees.json` (your-user-slug is the local-part of your
   `git config user.email`).
2. If those files changed, runs `git add → commit → push` on the
   `agent-workspace` repo so other machines can see the new state.
3. Runs `git fetch origin`. If origin has advanced, `git pull --ff-only`
   and replays every `data/*/` folder back into SQLite.

Manual one-shot sync (server doesn't have to be running):

```bash
~/github/agent-workspace/bin/agent-workspace-sync
```

## New machine

```bash
git clone <agent-workspace-url> ~/github/agent-workspace
python3 ~/github/agent-workspace/agent_workspace.py --worktrees /elsewhere/worktrees
```

On startup the server hydrates the local SQLite cache from every `data/*/`
subfolder it finds, so the new machine's dashboard is populated immediately.
The auto-sync loop then keeps it in step with the other machines.

## Multi-user

This repo is safe for multiple users to share. Each user writes only to their
own `data/<user-slug>/` subfolder, so `git pull` cannot conflict on
different users' state. Imports merge everything in, so on a shared dashboard
you'll see colleagues' worktrees as well as your own. The heatmap is filtered
by the local user, so it shows *your* commits only, regardless of how many
people are syncing into the repo.

## Run as a container (podman or docker)

The repo ships a `Dockerfile` + `compose.yaml`. The image is ~230 MB and only
needs Python + git + ssh client.

```bash
# build once
podman build -t agent-workspace:latest .

# run (compose handles the volume mounts described in compose.yaml)
podman compose up -d
# → http://127.0.0.1:8765/
```

Or one-shot without compose:

```bash
podman run -d --name agent-workspace \
  -p 127.0.0.1:8765:8765 \
  -v "$HOME/github/worktrees:/worktrees:rw" \
  -v "$HOME/git:/primaries:rw" \
  -v "$HOME/github/agent-workspace:/app:rw" \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  agent-workspace:latest
```

Mount semantics:

| Host path | Container path | Why |
|---|---|---|
| `~/github/worktrees` | `/worktrees` (`rw`) | What the dashboard reads. Read-write so the server can `git worktree add` to materialize missing entries. |
| `~/git` | `/primaries` (`rw`) | Where the primary repo checkouts live (`core`, `bssweb`, `doc`, …). `rw` because `git fetch` and `git worktree add` write inside `.git/`. |
| `~/github/agent-workspace` | `/app` (`rw`) | The repo whose `data/` is the sync mirror. Mounted so commits/pushes flow to the host's checkout. |
| `~/.ssh` | `/root/.ssh` (`ro`) | SSH keys for `ssh://` git remotes. |

Caveats:

- The **"🖥 Open in terminal tabs"** button does NOT work inside a container — it shells out to `gnome-terminal` and there isn't one. Run `bin/agent-worktrees` on the host directly when you want that.
- The server binds `0.0.0.0:8765` inside the container; the compose port mapping pins the host side to `127.0.0.1` so it isn't reachable from your network.

## Layout

```
agent-workspace/
├── agent_workspace.py    ← single-file stdlib server (Python 3.10+)
├── static/                ← dashboard CSS / JS / favicon
├── bin/
│   ├── agent-worktrees-server   ← thin Python wrapper
│   ├── agent-worktrees          ← opens one terminal tab per worktree
│   └── agent-workspace-sync     ← manual one-shot of the auto-sync tick
├── data/                  ← committed: each user's exported state
│   ├── README.md
│   ├── .gitattributes     (commits.jsonl uses union merge)
│   └── <user-slug>/...
├── README.md
└── AGENTS.md              ← this file
```

## Troubleshooting

- **No commits in heatmap.** The scan filters by the local-part of
  `git config user.email`. If you've changed that recently, your old commits
  (under a different domain) are still picked up because the match uses the
  local-part only.
- **`auto-sync disabled` on startup.** You launched with `--no-sync` or
  `--sync-interval=0`.
- **Sync errors in stderr.** Most are non-fatal: missing remote, push auth
  issues, or origin diverged so `pull --ff-only` declined. The loop logs the
  error and continues.
- **Ghost worktrees not appearing.** Make sure the "Show removed worktrees"
  toggle in the toolbar is on — they're hidden by default.
- **Browser shows stale data.** The dashboard auto-refreshes every 5 min; use
  the "↻ Refresh now" button for an immediate refetch.
