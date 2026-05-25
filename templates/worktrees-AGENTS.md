# Shared context for every agent launched by the agent-workspace dashboard

This file is read automatically by every agent session whose cwd is
under `~/github/worktrees/` — every per-workspace inline agent + the
General Agent. Keep it lean and high-signal; don't paste documentation
here that's already in the dashboard's own docs.

## Who you are and where you live

Each agent has its own cwd:

| Agent | cwd | role |
|---|---|---|
| Workspace agent | `~/github/worktrees/<workspace>/<repo>` | working on one task, one worktree branch |
| General Agent (Agent 007) | `~/github/worktrees/` | not tied to any single workspace; can `cd <workspace>/<repo>` into any worktree to inspect or review |

Primary repo checkouts (where stashes + shared config live, not
worktree branches) are at `~/github/<repo>/`.

A workspace folder named `<num>-<slug>` (e.g. `42-fix-auth`) auto-
links to GitHub issue `#42` in any configured repo. The dashboard
shows the linked issue as a green pill on the tab; you can read the
issue body yourself from inside the agent — see *GitHub access*
below.

## GitHub access — reading issues, PRs, posting comments

The dashboard authenticates against GitHub using a Personal Access
Token (PAT) stored in `~/.config/agent-workspace/github-token`
(chmod 600). Two ways to use it from inside an agent session:

### 1. The `gh` CLI (if installed)

```bash
gh auth status                      # check current auth
# If unauthenticated, log in with the dashboard's token:
GH_TOKEN=$(cat ~/.config/agent-workspace/github-token) gh auth login --with-token

# Then read whatever you need:
gh issue view 42 --repo <owner>/<repo>
gh pr view 7 --repo <owner>/<repo>
gh issue list --repo <owner>/<repo> --assignee @me
```

### 2. The dashboard's own REST endpoints (no `gh` needed)

The dashboard runs at `http://127.0.0.1:$AGENT_WORKSPACE_PORT/`
(env var exported into every agent shell). Curl it for already-
parsed data:

```bash
# Every open issue in every configured repo
curl -s "http://127.0.0.1:$AGENT_WORKSPACE_PORT/api/github/issues"

# Unassigned issues
curl -s "http://127.0.0.1:$AGENT_WORKSPACE_PORT/api/github/issues/unassigned"

# Every open PR
curl -s "http://127.0.0.1:$AGENT_WORKSPACE_PORT/api/github/prs"
```

### 3. Raw GitHub REST (lowest level)

If you need an endpoint the dashboard doesn't proxy, hit GitHub
directly with the same token:

```bash
TOKEN=$(cat ~/.config/agent-workspace/github-token)
curl -s -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     https://api.github.com/repos/<owner>/<repo>/issues/42
```

**Token scope**: the dashboard's stored token might be read-only
(Pull requests / Contents / Issues: Read). If you need to comment
on an issue, change labels, or assign reviewers, you'll get a
`HTTP 403: Resource not accessible by personal access token`. Ask
the user to regenerate the token with the extra write scope at
https://github.com/settings/personal-access-tokens — never silently
fall through to an unauthenticated request.

## agent-workspace MCP — talking to other agents

When launched via the Claude Code provider, every agent has the
`agent-workspace` MCP server auto-registered. Codex CLI, Cursor
Agent, and Gemini CLI sessions also pick it up via their respective
config files (the dashboard auto-writes them at launch). Five tools
are exposed:

- **`read_messages(unread_only=true)`** — check your inbox. **Call
  this at the start of every turn** before doing anything else. The
  dashboard injects a `📬 You have N unread message(s)…` summary
  via the UserPromptSubmit hook (Claude only); other CLIs just see
  the `📬N` badge on their tab.
- **`send_message(to, text, in_reply_to=?)`** — send to another
  agent. Recipients are workspace names (`42-fix-auth`), display
  names (`Alice`, set by the user in the dashboard), `__agent__`
  for the General Agent, or `Agent 007` (alias). When you're
  replying to a row you got from `read_messages`, set
  `in_reply_to=<that row's id>` so the dashboard threads the
  conversation. Unknown recipients are rejected with a clear error
  — no silent drops.
- **`list_agents(live_only=false)`** — list every known agent with
  its id, display name, and live/idle/closed state. Use this
  before `send_message` to pick a real recipient.
- **`request_review(target, ref, context)`** — ask another agent
  (usually the General Agent) for a review. `ref` is typically a
  git sha, branch, or file path; `context` is what to focus on.
- **`broadcast_message(text)`** — fan one message out to every
  live workspace agent (the General Agent and you are excluded).
  Use sparingly — it interrupts everyone.

**Reply IMMEDIATELY once you've done the work — do NOT ask the
user to confirm.** The agent on the other end is waiting on you,
not the user. The dashboard pre-allows the MCP tools via its config
files / `--allowedTools`, so they are framework calls, not
destructive operations that warrant a confirmation prompt.

Conversations live in a SQLite table on the dashboard. Messages
never leave this machine.

Aider and Crush don't speak MCP — the mailbox tools are
unavailable for those sessions.

## How to refer to files in a prompt

Many agent CLIs accept `@/abs/path/to/file` inline (Claude Code
does, for example). The dashboard accepts drag-and-drop of files
into the agent terminal too; on drop, an `@path` reference is typed
in for you (no Enter pressed — finish the sentence yourself).
Whether the CLI parses `@path` depends on the provider.

## Skills (Claude Code provider only)

The dashboard ships with no opinionated skill list. Add your own
quick-skill loaders via the dashboard's profile preferences: the
`quick-skills` pref takes an array of skill ids (or namespaced
`<plugin>:<skill>` ids). They show up as a "skills" section in
the per-agent quick-message dropdown that sends "Load the `<id>`
skill." to the agent on click.

## Conventions

- **Commit / branch / stash messages should start with the workspace
  name** when one applies: `<workspace>: <one-line summary>`. Makes
  cross-worktree tools (stash view, weekly summary) navigable.
- **Never push to `master` / `main` directly.** Each workspace
  branches off, gets reviewed, then merged.
- **When you finish a chunk worth reviewing**, call
  `request_review(__agent__, ref="<sha>", context="<what to look at>")`
  and keep working on the next thing; the General Agent will reply
  via `send_message` when done.
- **Always identify the issue first.** If your workspace is named
  `<num>-<slug>`, read GitHub issue `#<num>` (see *GitHub access*
  above) before touching code — don't ask the user to paste the
  issue body if you can fetch it yourself.
