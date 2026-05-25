# Demo plan — clean dashboard instance

A repeatable recipe for spinning up an empty demo of agent-workspace
on a second port (`:9001`), without disturbing your primary
instance on `:8765`. The audience walks through "+ Add workspace" live.

## Prerequisites

- `~/git/<repo>/` — primary checkouts (any repos you want to demo
  worktrees against). The demo needs these so the server can
  `git worktree add` from them into the empty demo worktrees root.

## Start the demo

```bash
# Clear any leftover state from a previous demo. The demo's
# worktrees + primaries roots mirror the production layout
# (~/git/worktrees alongside ~/git/<repo>/) but under
# ~/.cache/agent-workspace/demo/ so nothing collides with your real
# checkouts and the (often small) /tmp tmpfs can't fill up under a
# multi-GB shallow clone.
~/git/agent-workspace/bin/agent-worktrees-stop --port 9001
rm -rf ~/.cache/agent-workspace/demo
rm -f  ~/.cache/agent-workspace/activity.9001.sqlite \
       ~/.cache/agent-workspace/server.9001.*
mkdir -p ~/.cache/agent-workspace/demo/worktrees

# Start the demo instance.
~/git/agent-workspace/bin/agent-worktrees-restart --port 9001 \
  --no-sync --no-backup --no-hydrate --no-materialize \
  --worktrees ~/.cache/agent-workspace/demo/worktrees \
  --primaries ~/.cache/agent-workspace/demo

# Open the empty dashboard in your default browser.
xdg-open http://127.0.0.1:9001/    # Linux
# open  http://127.0.0.1:9001/      # macOS
```

What each flag does:

| Flag | Why for the demo |
|---|---|
| `--port 9001` | Separate port → separate per-port SQLite cache (`activity.9001.sqlite`), pidfile, log file. Your primary :8765 is untouched. |
| `--no-sync` | The demo's empty `data/` export won't push and clobber the shared state on other machines. |
| `--no-backup` | The scheduled-backup thread won't write any backup files during the demo. |
| `--no-hydrate` | Skips importing `data/*/commits.jsonl` + `worktrees.json`, so the heatmap starts empty (you populate it live as you demo). |
| `--no-materialize` | Don't auto-`git worktree add` from `data/<user>/worktrees.json` on startup. |
| `--worktrees ~/.cache/agent-workspace/demo/worktrees` | Fresh empty worktrees root. |
| `--primaries ~/.cache/agent-workspace/demo` | Fresh empty primaries root → the dashboard surfaces a "Missing primary repos" banner on first load with one-click clone buttons. The clone-URL template is per-user (empty by default; configurable via the `primaries-clone-url-template` preference). |

## Suggested walkthrough

1. **Open the empty dashboard** — `http://127.0.0.1:9001/`. The page
   loads with a yellow **"⚠ Missing primary repos"** banner across
   the top plus zero workspace tabs and an empty heatmap. Point out
   the profile avatar (top-right), the empty-state hint, and the
   toolbar.

2. **Clone the primaries** — click **Clone all** (or the per-repo
   buttons). Each runs `git clone --depth 1000` in the background;
   the buttons turn into live progress bars (`Recv core 23%` etc.)
   and advance as the server streams the clone output.

3. **+ Add workspace** — pick a workspace name. The dialog lists the
   user's configured primary repos by default. Click **Create**. The
   server `git worktree add`s from each primary into
   `~/.cache/agent-workspace/demo/worktrees/<workspace>/<repo>/` and
   a new tab appears.

4. **Click the new tab** — show the per-repo cards: branch / dirty /
   ahead / behind / last commit pills + the foldable details panes.

5. **Profile → Backup** — open the Backup tab, click **Run backup
   now** to demonstrate `activity.sqlite` + per-worktree git bundles.
   The history table shows the entry. (The scheduled thread itself
   stays off — that's by design for the demo.)

6. **🔔 Agent events** — walk through the agent-events modal. The
   Messages pane inside each workspace tab is the per-workspace view.

7. **Theme / Language tabs** — quick highlight of cross-machine
   sync of UI prefs.

## Cleanup

```bash
~/git/agent-workspace/bin/agent-worktrees-stop --port 9001
rm -rf ~/.cache/agent-workspace/demo
```
