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

## agent-workspace MCP — talking to other agents (Claude Code provider only)

When launched via the Claude Code provider, every agent has the
`agent-workspace` MCP server registered, with four tools:

- **`read_messages(unread_only=true)`** — check your inbox. **Call
  this at the start of every turn** before doing anything else. The
  dashboard injects a `📬 You have N unread message(s)…` summary
  via the UserPromptSubmit hook, but you still need to actually
  fetch + ack each message.
- **`send_message(to, text, in_reply_to=?)`** — send to another
  agent. Recipients are workspace names or `__agent__` for the
  General Agent. When you're replying to a row you got from
  `read_messages`, set `in_reply_to=<that row's id>` so the
  dashboard threads the conversation. Unknown recipients are
  rejected with a clear error — no silent drops.
- **Reply IMMEDIATELY once you've done the work — do NOT ask the
  user to confirm.** The agent on the other end is waiting on
  you, not the user. The dashboard pre-allows the MCP tools via
  `--allowedTools`, so they are framework calls, not destructive
  operations that warrant a confirmation prompt.
- **`request_review(target, ref, context)`** — ask another agent
  (usually the General Agent) for a review. `ref` is typically a
  git sha, branch, or file path; `context` is what to focus on.
- **`broadcast_message(text)`** — fan one message out to every
  live workspace agent (the General Agent and you are excluded). Use
  sparingly — it interrupts everyone.

Conversations live in a SQLite table on the dashboard. Messages
never leave this machine.

Providers other than Claude Code (Codex CLI, Aider, Gemini CLI,
Cursor Agent, Crush) do not speak MCP — the mailbox tools are
unavailable for those sessions.

## How to refer to files in a prompt

Many agent CLIs accept `@/abs/path/to/file` inline (Claude Code does,
for example). The dashboard accepts drag-and-drop of files into the
agent terminal too; on drop, an `@path` reference is typed in for you
(no Enter pressed — finish the sentence yourself). Whether the CLI
parses `@path` depends on the provider.

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
  (Claude Code provider only) and keep working on the next thing;
  the General Agent will reply via `send_message` when done.
