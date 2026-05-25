# `data/` — sync state (one subfolder per user)

Plain-text mirror of every user's local SQLite cache (`~/.cache/agent-workspace/activity.sqlite`).
Commit and push these files to share worktree history + commit activity
between machines and (if you want) between team-mates.

## Layout

```
data/
├── <user>/                     ← one folder per user — the slug is the
│   ├── commits.jsonl           ←   local-part of `git config user.email`
│   ├── worktrees.json
│   └── meta.json
└── README.md / .gitattributes
```

Multi-user safe: each user only writes to their own subfolder, so masters can
contain everyone's data without merge conflicts.

## Files

| File | Format | Mutability |
|---|---|---|
| `<user>/commits.jsonl` | one JSON object per line, sorted alphabetically by `sha` | append-only-ish — new commits insert in sort order; `*/commits.jsonl merge=union` makes git auto-merge concurrent additions |
| `<user>/worktrees.json` | single JSON object keyed by `<issue>/<repo>` | overwritten on every export (last write wins for that one user) |
| `<user>/meta.json` | small JSON: exported_at, hostname, user | overwritten on every export |

## Path independence

No absolute paths are stored. Each entry is keyed by `(issue, repo)`. On any
machine the server resolves the live path as `<--worktrees>/<issue>/<repo>`
where `--worktrees` is a CLI flag (default `~/git/worktrees`).

## Workflow

```
# any machine — let the server's auto-sync loop handle it
python3 agent_workspace.py
# (every --sync-interval seconds it exports → commits → pushes → fetches → pulls)

# one-shot manual sync without a running server
bin/agent-workspace-sync
```

The receiving side picks up the new commit on its next sync tick and re-imports
automatically — no manual action needed once the server is running.

## Multi-user

When teammate Alice adds her own `data/alice/` subfolder, your dashboard's
heatmap remains *yours* (filtered by the local `git config user.email`'s
local-part), but the worktree list will show her active issues too — useful
for "is anyone else working on this?" visibility.
