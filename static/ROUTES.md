# API Routes

All HTTP routes exposed by the `agent_workspace.py` server.

| Route | Purpose |
|---|---|
| `GET  /` | Dashboard HTML; initial state inlined as JSON. |
| `GET  /api/status[?show_ghosts=1]` | Full state of all worktrees + per-issue pending event counts. Polled every 5 min. |
| `GET  /api/heatmap[?days=N]` | Zero-filled commit count per day for the activity heatmap. |
| `GET  /api/heatmap/tokens[?days=N]` | Same shape, but per-day token totals. |
| `GET  /api/disk/<issue>/<repo>` | Lazy `du -sh` of a worktree (cached 5 min). |
| `GET  /api/editors` | Allowlisted editors annotated with `available` from `shutil.which()`. |
| `POST /api/open-file` | Spawn `<editor> <abs_path>` after sandboxing the path under `--worktrees`. |
| `GET  /api/logs` | In-memory log ring (info / warn / error). Polled by the diagnostics modal. |
| `GET  /api/stats` | Server uptime, request counters, log levels. |
| `GET\|POST /api/week-summary[?week=YYYY-Www]` | Get / regenerate a week summary. POST forces. |
| `DELETE /api/week-summary?week=…` | Drop a cached summary. |
| `GET  /api/week-summary/list` | Index of cached summaries with stats (newest first). |
| `GET\|POST /api/worklogs` | Fetch / add manual worklog entries. |
| `DELETE /api/worklogs/<id>` | Remove a manual or timer entry. |
| `DELETE /api/worklogs/agent?issue=&week=` | Hide a computed agent worklog row. |
| `GET\|POST /api/timer{,/start,/stop,/comment}` | Timer state. |
| `GET  /api/known-issues` | Distinct issue ids seen on disk + in worklogs. |
| `GET  /api/events[?issue=&limit=]` | List recent agent events. |
| `POST /api/events` | Hook ingest endpoint. |
| `POST /api/events/mark-read[?issue=]` | Clear pending-event count. |
| `GET\|POST /api/sync-now` · `GET\|POST /api/sync-toggle` | Sync control. |
| `POST /mcp?agent=<id>` | JSON-RPC 2.0 transport for the agent-workspace MCP server. Body is one `initialize` / `tools/list` / `tools/call` / `notifications/initialized` request. The `?agent=` query string identifies the caller. |
| `GET  /api/mcp/messages?agent=<id>&direction={thread\|inbox\|outbox}` | Read-only mailbox view for the dashboard's Messages pane. Never marks anything read — that only happens when the agent calls the `read_messages` tool. |
| `POST /api/mcp/delete` | Body `{id: <int>}`. Hard-deletes one row from `agent_messages`. Used by the ✕ button on each row. |
| `POST /api/mcp/delete-thread` | Body `{id: <int>}`. Walks the in_reply_to chain to the root, BFS-collects every descendant, deletes the whole subtree in one transaction. Powers the **Delete Conversation (N)** button. |
| `POST /api/agent/upload?issue=&name=` | Body is raw bytes. Saves under `<agent-cwd>/.claude-uploads/<ts>-<name>`. 50 MB cap (`413` on overflow). Used by the drag-drop fallback when the browser sandbox hides the source path. |
| `GET  /api/stashes` | List every `git stash list` row across all primary repos (`--primaries`), newest-first across repos. |
| `GET  /api/stashes/show?repo=&ref=` | Numstat of one stash — file paths + added / removed counts (or `binary`). |
| `POST /api/stashes/drop` | Body `{repo, ref}`. Hard `git stash drop`. Ref validated against `^stash@\{\d+\}$`. |
| `GET  /api/update/status` | Cached output of the auto-update background check: current sha + remote sha + behind count + branch + last check time. |
| `POST /api/update/check` | Forces a fresh `git fetch origin <branch>` + re-fills the cache. |
| `POST /api/update/apply` | Graceful-stop every live agent, run `git pull --ff-only`, spawn `bin/agent-worktrees-restart` detached. Returns 202 on success, 409 on a non-FF pull, 412 when already up-to-date. |
| `GET\|POST /api/backup/settings` | Read or update backup schedule + retention + directory. |
| `GET  /api/backup/history[?limit=N]` | Recent backup attempts (newest first), incl. per-worktree status. |
| `POST /api/backup/run-now` | Trigger a synchronous backup outside the schedule. |
| `GET  /api/backup/sqlite` | One-shot SQLite snapshot download (no bundles). |
| `POST /api/restore/sqlite` | Replace the SQLite cache from an uploaded backup file. |
| `GET  /api/docs?file={README.md,AGENTS.md,ROUTES.md}` | Raw markdown of a project doc file (allowlisted). |
| `GET  /static/{dashboard.css,dashboard.js,favicon.svg}` | Static assets. |
