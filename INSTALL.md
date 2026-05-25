# Installing agent-workspace

A local HTTP dashboard for monitoring git worktrees with embedded
coding-agent terminals. Pure Python 3.10+ stdlib server, no `pip
install`, no `npm install`.

This document covers the **release install** — downloading a packaged
tarball and running it. For hacking on the source, see [Developer
install](#developer-install) at the bottom.

---

## Quick install

Linux, macOS, or Windows (Git Bash):

```bash
curl -fsSLO https://github.com/manswe72/agent-workspace/releases/latest/download/agent-workspace.tar.gz
tar xzf agent-workspace.tar.gz
cd agent-workspace-*/
./install.sh
```

That's it. `agent-worktrees-server` is now on your `PATH`:

```bash
agent-worktrees-server
# → http://127.0.0.1:8765/ opens in your browser
```

The installer:

- Validates Python ≥ 3.10 and `git` are present.
- Symlinks the launcher scripts from `./bin` into `~/.local/bin`
  (or copies to `~/bin` on Windows Git Bash).
- Installs bash completions to `${XDG_DATA_HOME:-~/.local/share}/bash-completion/completions/`.
- Drops an **Agent Workspace** app-launcher entry under
  `~/.local/share/applications/` on Linux.
- Offers (interactively) to register an autostart entry and to
  wire Claude Code hooks for desktop notifications. Skip with
  `--no-autostart` / `--no-claude-hooks`, accept with `--autostart`
  / `--enable-claude-hooks`.

## Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Python | **3.10+** | The dashboard uses `match`/`case` and PEP-604 unions. |
| git | any recent version | The dashboard shells out to `git` for status, fetch, push, worktree management. |
| A coding-agent CLI | optional | Any of: Claude Code, OpenAI Codex CLI, Cursor Agent, Gemini CLI, Aider, Crush. The dashboard auto-detects what's on `PATH` and shows only the installed providers. |

On macOS:

```bash
brew install python git
```

On Debian/Ubuntu:

```bash
sudo apt install python3 git
```

On Windows: install [Git for Windows](https://git-scm.com/download/win)
(provides Git Bash) and [Python](https://www.python.org/downloads/)
(tick "Add python.exe to PATH"). Optional desktop notifications:

```bash
powershell -Command "Install-Module -Name BurntToast -Scope CurrentUser"
pip install pywinpty
```

## Pinning a specific version

The stable URL above redirects to the latest release. To pin to a
specific version (e.g. for reproducible builds):

```bash
curl -fsSLO https://github.com/manswe72/agent-workspace/releases/download/v0.1.1/agent-workspace-0.1.1.tar.gz
tar xzf agent-workspace-0.1.1.tar.gz
cd agent-workspace-0.1.1
./install.sh
```

The list of releases lives at <https://github.com/manswe72/agent-workspace/releases>.

## Verifying the install

```bash
# Dashboard binary on PATH
command -v agent-worktrees-server
# → /home/<you>/.local/bin/agent-worktrees-server

# Start the server (foreground)
agent-worktrees-server --no-open

# Hit the API from another shell
curl -fsS http://127.0.0.1:8765/api/stats | python3 -m json.tool | head
```

If `command -v` finds nothing, `~/.local/bin` isn't on your `PATH`.
Add it to your shell rc:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc   # bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc    # zsh
exec $SHELL
```

## Upgrading

Re-run the quick-install command. The installer is idempotent — it
replaces the symlinks in `~/.local/bin` to point at the new extracted
directory.

```bash
# Stop the running server first (if any)
agent-worktrees-stop

# Re-download + reinstall
curl -fsSLO https://github.com/manswe72/agent-workspace/releases/latest/download/agent-workspace.tar.gz
tar xzf agent-workspace.tar.gz
cd agent-workspace-*/
./install.sh
```

The dashboard's in-app **Update** button is **disabled on release
installs** — it only works for source clones (see [Developer install](#developer-install)).

## Uninstalling

```bash
cd path/to/extracted/agent-workspace-*/
./install.sh --uninstall
```

That removes:

- The launcher symlinks from `~/.local/bin/` (or `~/bin/` on Windows).
- The app-launcher entry under `~/.local/share/applications/` (Linux).
- The autostart entry for whichever OS you're on.
- The bash completions.

Then delete the extracted source directory and your state if you want
a fully clean wipe:

```bash
rm -rf agent-workspace-*/
# State (SQLite + logs + backups + token). KEEP if you might reinstall.
rm -rf ~/.cache/agent-workspace ~/.local/share/agent-workspace
rm -rf ~/.config/agent-workspace
```

On macOS the state paths are `~/Library/Caches/agent-workspace` and
`~/Library/Application Support/agent-workspace`; on Windows they're
`%LOCALAPPDATA%\agent-workspace` and `%APPDATA%\agent-workspace`.

## Per-platform notes

### Linux

The autostart entry is an XDG `.desktop` file at
`~/.config/autostart/agent-workspace.desktop`. The app-launcher entry
under `~/.local/share/applications/` makes the dashboard show up in
your system menu / dock — clicking it starts the server if it isn't
running and opens the dashboard.

Desktop notifications use `notify-send` (part of `libnotify-bin` on
most distros; install with `sudo apt install libnotify-bin` if missing).

### macOS

The autostart entry is a LaunchAgent plist at
`~/Library/LaunchAgents/io.github.agent-workspace.plist`, bootstrapped
via `launchctl`. The dashboard's 💻 Console button opens Terminal.app
(or Ghostty if installed) via AppleScript; the editor open buttons
detect VS Code / Cursor / Sublime / Zed / Windsurf / IntelliJ / BBEdit
/ MacVim / TextMate / Nova.

Make sure `~/.local/bin` is on your zsh PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
exec zsh
```

### Windows (Git Bash)

The installer **copies** scripts into `~/bin` instead of symlinking
(MSYS symlinks need Developer Mode enabled). Re-run `./install.sh`
after a fresh download to refresh the copies.

The autostart mechanism is a silent `.vbs` launcher in
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` so the
server starts on login with no console window.

Cache lives at `%LOCALAPPDATA%\agent-workspace\`; backups at
`%APPDATA%\agent-workspace\`.

## Install as a PWA

Open the dashboard in Chrome, Edge, Brave, Arc, or Vivaldi — there's
an **Install Claude Workspace…** prompt in the address bar (or
three-dot menu → Apps → Install). Safari 17+ supports it via **File →
Add to Dock…**. On GNOME the Files app exposes the same as **Install
as App** when you're inside Chromium.

A PWA install gives you a standalone window without browser chrome,
a dock / launcher icon, ⌘-Tab / Alt-Tab entry, and the OS-level
launcher badge for the 🔔 unread-event count.

## GitHub token (optional)

The dashboard talks to GitHub for issues + PRs + the auto-link from
workspace folders (`<num>-<slug>` → issue `#<num>`). To enable it,
paste a Personal Access Token into **Profile → GitHub → API key**.

Required scopes:

- **Contents: Read** — list repos, fetch branches.
- **Pull requests: Read** — show open / closed / merged PRs.
- **Issues: Write** — claim unassigned issues from the modal.

Create one at <https://github.com/settings/personal-access-tokens>.
Tokens are stored at `~/.config/agent-workspace/github-token`
(chmod 600).

## Troubleshooting

### `command not found: agent-worktrees-server`

`~/.local/bin` (or `~/bin` on Windows) isn't on your `PATH`. See
[Verifying the install](#verifying-the-install) above for the fix.

### `python3: command not found` during install

Install Python 3.10+ (see [Prerequisites](#prerequisites)). On
older macOS the system python is too old — `brew install python`.

### Update button is greyed out

That's expected on a release install — it's the indicator that you're
on the tarball install path. Re-download the latest tarball to
upgrade. See [Upgrading](#upgrading).

### Port 8765 already in use

Pick a different port:

```bash
agent-worktrees-server --port 18765
```

### Dashboard's git operations fail with "could not read Username"

Set the GitHub token via Profile → GitHub → API key. The dashboard
exports `GIT_ASKPASS` + `GIT_USERNAME` + `GIT_PASSWORD` into every
git subprocess + every agent terminal it spawns, so once the token
is configured everything resolves automatically.

## Developer install

If you want to hack on the source — or want the in-app **Update**
button to keep working via `git pull` — clone the repo instead of
using the tarball:

```bash
git clone https://github.com/manswe72/agent-workspace.git ~/github/agent-workspace
cd ~/github/agent-workspace
./setup.sh
```

The developer install:

- Has a `.git/` directory, so the dashboard detects it as a developer
  install and enables the in-app Update mechanism.
- Installs the local pre-push hook (ruff + pytest before every push).
- Otherwise drops the same launcher symlinks, completions, autostart
  entry as the release install.

To cut a release from a developer install:

```bash
./bin/release.sh                       # release current VERSION
./bin/release.sh --version 0.2.0       # bump VERSION + release
./bin/release.sh --dry-run             # preview, no changes
```

See [bin/release.sh](bin/release.sh) header for all flags.
