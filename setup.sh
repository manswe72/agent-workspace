#!/usr/bin/env bash
# setup.sh — install agent-workspace on this machine.
#
# Default behaviour: symlinks the scripts in bin/ into ~/.local/bin
# and installs bash completions.
#
# Usage:
#   ./setup.sh                            # default install
#   ./setup.sh --target /usr/local/bin    # symlink elsewhere (must be on PATH)
#   ./setup.sh --systemd                  # + install & enable user unit
#   ./setup.sh --sync-repo <git-url>      # configure opt-in state sync repo
#   ./setup.sh --enable-claude-hooks      # write Claude Code hooks → dashboard
#   ./setup.sh --disable-claude-hooks     # remove the hooks we wrote
#   ./setup.sh --autostart                # also start the server on login
#                                         #   (Linux: XDG autostart;
#                                         #    macOS:  ~/Library/LaunchAgents plist;
#                                         #    Windows/Git Bash: Startup folder .vbs)
#   ./setup.sh --no-autostart             # skip the autostart prompt / remove existing
#   ./setup.sh --non-interactive          # never prompt (CI / unattended)
#   ./setup.sh --uninstall                # remove symlinks (+ unit if present)
#   ./setup.sh --uninstall-clear          # uninstall + wipe per-instance cache
#                                         #   (pidfiles, logs, sqlite DBs).
#                                         #   Keeps ~/.config and the
#                                         #   cloned repo.

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null && pwd)"
BIN_SRC="$REPO_DIR/bin"
COMPL_SRC="$REPO_DIR/completions"

# Git Bash on Windows reports MINGW64_NT-... / MSYS_NT-... from
# `uname -s`. Under MSYS, ln -s requires Developer Mode or
# MSYS=winsymlinks:nativestrict, so we copy the scripts instead.
# ~/bin is what Git Bash puts on PATH by default, not ~/.local/bin.
IS_GIT_BASH=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) IS_GIT_BASH=1 ;;
esac

if [[ $IS_GIT_BASH -eq 1 ]]; then
  TARGET="${HOME}/bin"
else
  TARGET="${HOME}/.local/bin"
fi
COMPL_TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
WANT_SYSTEMD=0
UNINSTALL=0
UNINSTALL_CLEAR=0
NON_INTERACTIVE=0
WANT_HOOKS=0
DISABLE_HOOKS=0
SYNC_REPO_URL="${AGENT_WORKSPACE_SYNC_REPO:-}"
# A non-tty stdin (e.g. piped, < /dev/null) is treated as non-interactive.
[[ -t 0 ]] || NON_INTERACTIVE=1
UNIT_NAME="agent-workspace.service"
UNIT_FILE="${HOME}/.config/systemd/user/${UNIT_NAME}"

# Freedesktop entries — visible app launcher and (optional) XDG autostart
# on login. Linux only; macOS and Git Bash use platform-native equivalents
# (LaunchAgent / Startup folder, configured further down).
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="${DESKTOP_DIR}/agent-workspace.desktop"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/agent-workspace.desktop"
WANT_AUTOSTART=-1     # -1 = unset (will prompt), 0 = no, 1 = yes

# macOS LaunchAgent — runs agent-worktrees-server on login as the user.
# `launchctl bootstrap gui/<uid>` registers it for this session too; the
# plist is what launchd reads on subsequent logins. The label is a
# reverse-DNS identifier; users distributing their own fork should
# override it via the AGENT_WORKSPACE_LAUNCH_LABEL env var to match
# their own domain.
LAUNCH_AGENT_LABEL="${AGENT_WORKSPACE_LAUNCH_LABEL:-io.github.agent-workspace}"
LAUNCH_AGENT_DIR="${HOME}/Library/LaunchAgents"
LAUNCH_AGENT_FILE="${LAUNCH_AGENT_DIR}/${LAUNCH_AGENT_LABEL}.plist"

# Windows (Git Bash) — drop a .vbs into the per-user Startup folder. The
# .vbs invokes bash.exe with WindowStyle=0 so the server starts silently
# (no flashing cmd window). schtasks ONLOGON is a more invisible alternative
# but the Startup folder is what users intuitively know how to inspect
# / remove, so we mirror the Linux ~/.config/autostart shape.
if [[ -n "${APPDATA:-}" ]]; then
  if command -v cygpath >/dev/null 2>&1; then
    WIN_STARTUP_DIR="$(cygpath -u "$APPDATA")/Microsoft/Windows/Start Menu/Programs/Startup"
  else
    WIN_STARTUP_DIR="${APPDATA}/Microsoft/Windows/Start Menu/Programs/Startup"
  fi
else
  WIN_STARTUP_DIR=""
fi
WIN_AUTOSTART_FILE="${WIN_STARTUP_DIR:+${WIN_STARTUP_DIR}/agent-workspace.vbs}"

SCRIPTS=(
  agent-worktrees-server
  agent-worktrees
  agent-worktrees-restart
  agent-worktrees-stop
  agent-workspace-sync
  agent-workspace-launch
  agent-workspace-restart
  agent-event-notify
)
# Completion files installed: SCRIPTS plus setup.sh (run from repo root,
# not symlinked into bin/).
COMPLETIONS=( "${SCRIPTS[@]}" setup.sh )

err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)            TARGET="${2:?--target needs a path}"; shift 2 ;;
    --target=*)          TARGET="${1#*=}"; shift ;;
    --systemd)           WANT_SYSTEMD=1; shift ;;
    --sync-repo)         SYNC_REPO_URL="${2:?--sync-repo needs a URL}"; shift 2 ;;
    --sync-repo=*)       SYNC_REPO_URL="${1#*=}"; shift ;;
    --non-interactive|--yes) NON_INTERACTIVE=1; shift ;;
    --enable-claude-hooks)  WANT_HOOKS=1; shift ;;
    --disable-claude-hooks) DISABLE_HOOKS=1; shift ;;
    --autostart)         WANT_AUTOSTART=1; shift ;;
    --no-autostart)      WANT_AUTOSTART=0; shift ;;
    --uninstall)         UNINSTALL=1; shift ;;
    --uninstall-clear)   UNINSTALL=1; UNINSTALL_CLEAR=1; shift ;;
    -h|--help)           usage 0 ;;
    *)                   err "unknown option: $1"; usage 2 ;;
  esac
done

prompt_yn() {
  # prompt_yn "question" default(y|n) → returns 0 for yes, 1 for no
  local q="$1" def="${2:-y}" reply
  local hint="[Y/n]"
  [[ "$def" == "n" ]] && hint="[y/N]"
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    [[ "$def" == "y" ]] && return 0 || return 1
  fi
  read -r -p "$q $hint " reply
  # tr instead of ${var,,} (bash 4+ only) so this works on macOS's
  # default bash 3.2.
  reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
  [[ -z "$reply" ]] && reply="$def"
  [[ "$reply" == "y" || "$reply" == "yes" ]]
}

prompt_value() {
  # prompt_value VAR "question" "default"  → echoes the answer
  local q="$1" def="${2:-}" reply
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    printf '%s' "$def"
    return 0
  fi
  if [[ -n "$def" ]]; then
    read -r -p "$q [$def] " reply
    reply="${reply:-$def}"
  else
    read -r -p "$q " reply
  fi
  printf '%s' "$reply"
}

prompt_secret() {
  # prompt_secret "question"  → echoes the answer (no terminal echo)
  local q="$1" reply
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    return 0
  fi
  read -r -s -p "$q " reply
  printf '\n' >&2
  printf '%s' "$reply"
}

# ── Uninstall path ─────────────────────────────────────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  # On Windows (Git Bash) we install copies instead of symlinks, so
  # remove plain files there. On POSIX we still only remove symlinks
  # to avoid clobbering anything the user wrote by hand.
  for s in "${SCRIPTS[@]}"; do
    link="$TARGET/$s"
    if [[ -L "$link" ]]; then
      rm -f "$link" && ok "removed $link"
    elif [[ $IS_GIT_BASH -eq 1 && -f "$link" ]]; then
      rm -f "$link" && ok "removed $link"
    elif [[ -e "$link" ]]; then
      warn "$link exists but is not a symlink — leaving it alone"
    fi
  done
  for s in "${COMPLETIONS[@]}"; do
    link="$COMPL_TARGET/$s"
    if [[ -L "$link" ]]; then
      rm -f "$link" && ok "removed $link"
    elif [[ $IS_GIT_BASH -eq 1 && -f "$link" ]]; then
      rm -f "$link" && ok "removed $link"
    elif [[ -e "$link" ]]; then
      warn "$link exists but is not a symlink — leaving it alone"
    fi
  done
  if [[ -f "$UNIT_FILE" ]]; then
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload 2>/dev/null || true
    ok "removed $UNIT_FILE"
  fi
  # Freedesktop launcher + autostart entry (Linux). Safe to attempt
  # on any host — files just won't exist on macOS / Git Bash.
  for f in "$DESKTOP_FILE" "$AUTOSTART_FILE"; do
    if [[ -f "$f" ]]; then
      rm -f "$f" && ok "removed $f"
    fi
  done
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi

  # macOS LaunchAgent. `launchctl bootout` is the modern verb;
  # `launchctl unload` is the legacy fallback. Either is fine — the
  # plist removal is what makes the change permanent.
  if [[ -f "$LAUNCH_AGENT_FILE" ]]; then
    if command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" 2>/dev/null \
        || launchctl unload "$LAUNCH_AGENT_FILE" 2>/dev/null || true
    fi
    rm -f "$LAUNCH_AGENT_FILE" && ok "removed $LAUNCH_AGENT_FILE"
  fi

  # Windows Startup folder entry.
  if [[ -n "$WIN_AUTOSTART_FILE" && -f "$WIN_AUTOSTART_FILE" ]]; then
    rm -f "$WIN_AUTOSTART_FILE" && ok "removed $WIN_AUTOSTART_FILE"
  fi
  # Strip the dashboard hook entries from ~/.claude/settings.json if present.
  if [[ -f "$HOME/.claude/settings.json" ]] \
     && grep -q "agent-event-notify" "$HOME/.claude/settings.json" 2>/dev/null; then
    HOOK_SCRIPT="$REPO_DIR/bin/agent-event-notify"
    CLAUDE_SETTINGS="$HOME/.claude/settings.json"
    python3 - "$CLAUDE_SETTINGS" "$HOOK_SCRIPT" <<'PY' || true
import json, sys
from pathlib import Path
p = Path(sys.argv[1]); hook = sys.argv[2]
try:    cfg = json.loads(p.read_text() or "{}")
except: sys.exit(0)
hooks = cfg.get("hooks") or {}
for ev in list(hooks):
    if not isinstance(hooks[ev], list): continue
    hooks[ev] = [
        ({**e, "hooks": [h for h in e.get("hooks", []) if h.get("command") != hook]}
         if isinstance(e, dict) else e)
        for e in hooks[ev]
    ]
    hooks[ev] = [e for e in hooks[ev]
                 if not (isinstance(e, dict) and not e.get("hooks"))]
    if not hooks[ev]: del hooks[ev]
if not hooks: cfg.pop("hooks", None)
p.write_text(json.dumps(cfg, indent=2) + "\n")
PY
    ok "removed agent-workspace hook entries from $HOME/.claude/settings.json"
  fi

  # ── Optional: clear per-instance cache (--uninstall-clear) ──────────────
  # Mirrors the cache-dir computation in agent_workspace.py's
  # _default_cache_dir() and bin/agent-worktrees-restart. Stops any
  # running server first via its pidfile (so the cache delete doesn't
  # race the running process), then rm -rf the whole cache dir.
  # ~/.config/agent-workspace is intentionally left alone — those
  # are user config files, not auto-generated state.
  if [[ $UNINSTALL_CLEAR -eq 1 ]]; then
    case "$(uname -s)" in
      Darwin)
        CACHE_DIR="$HOME/Library/Caches/agent-workspace" ;;
      MINGW*|MSYS*|CYGWIN*)
        CACHE_DIR="${LOCALAPPDATA:-$HOME/AppData/Local}/agent-workspace" ;;
      *)
        CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/agent-workspace" ;;
    esac
    if [[ -d "$CACHE_DIR" ]]; then
      # Confirm before wiping — this is destructive and lists every
      # dashboard instance's sqlite + logs. --non-interactive
      # bypasses the prompt for CI / scripted use.
      echo
      warn "About to wipe cache dir: $CACHE_DIR"
      info "Contents:"
      ls -la "$CACHE_DIR" 2>/dev/null | sed 's/^/    /' >&2 || true
      if ! prompt_yn "Continue? This deletes every dashboard sqlite + pidfile + log." n; then
        info "skipped cache-dir wipe — re-run --uninstall-clear to retry"
      else
        # Stop every running dashboard via the canonical stop script
        # rather than an ad-hoc inline kill — the script does
        # SIGTERM → wait → SIGKILL fallback and clears the pidfile.
        # We invoke it from the repo's bin/ directly so the prior
        # --uninstall step (which has already removed the $TARGET
        # symlink) doesn't break this. Port is parsed from the
        # pidfile basename (server.<port>.pid).
        STOP_SCRIPT="$BIN_SRC/agent-worktrees-stop"
        for pidfile in "$CACHE_DIR"/server.*.pid; do
          [[ -f "$pidfile" ]] || continue
          base="${pidfile##*/}"; port="${base#server.}"; port="${port%.pid}"
          [[ "$port" =~ ^[0-9]+$ ]] || continue
          "$STOP_SCRIPT" --port "$port" >&2 || true
        done
        rm -rf "$CACHE_DIR"
        ok "removed cache dir $CACHE_DIR"
      fi
    else
      info "no cache dir at $CACHE_DIR — nothing to clear"
    fi
  fi

  exit 0
fi

# ── Prerequisite checks ────────────────────────────────────────────────────
echo "Checking prerequisites…"
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found on PATH"
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then
  err "python3 ≥ 3.10 required (have $(python3 --version))"
  exit 1
fi
ok "python3 $(python3 --version | awk '{print $2}')"

# On Windows the inline agent terminal uses ConPTY via pywinpty instead
# of the POSIX pty module.  Install it silently if missing.
if [[ $IS_GIT_BASH -eq 1 ]]; then
  if python3 -c 'import winpty' 2>/dev/null; then
    ok "pywinpty (already installed)"
  else
    info "installing pywinpty for Windows ConPTY support…"
    if python3 -m pip install --quiet pywinpty; then
      ok "pywinpty installed"
    else
      warn "pywinpty install failed — the inline agent terminal will not work on Windows"
    fi
  fi
fi

if ! command -v git >/dev/null 2>&1; then
  err "git not found on PATH"
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

# ── xterm.js addon bundles ──────────────────────────────────────────────────
# These UMD bundles are downloaded from npm and committed to static/xterm/.
# setup.sh re-downloads any that are missing (e.g. after a fresh clone that
# predates a new addon being added). Versions must stay in sync with
# xterm.js 5.5.0.
echo
echo "Checking xterm.js addon bundles…"
XTERM_DIR="$REPO_DIR/static/xterm"
mkdir -p "$XTERM_DIR"
_xterm_addon() {
  local pkg="$1" ver="$2" file="$3"
  local dest="$XTERM_DIR/$file"
  if [[ -f "$dest" ]]; then
    ok "$pkg (already present)"
    return
  fi
  info "downloading $pkg@$ver…"
  if curl -fsSL "https://registry.npmjs.org/$pkg/-/${pkg##*/}-${ver}.tgz" \
       | tar -xzO package/lib/"${file#xterm-}" > "$dest" 2>/dev/null; then
    ok "$pkg downloaded"
  else
    warn "$pkg download failed — inline terminal features may be limited"
    rm -f "$dest"
  fi
}
_xterm_addon "@xterm/addon-search"    "0.16.0" "xterm-addon-search.js"
_xterm_addon "@xterm/addon-unicode11" "0.8.0"  "xterm-addon-unicode11.js"
_xterm_addon "@xterm/addon-image"     "0.8.0"  "xterm-addon-image.js"

# ── Install scripts (symlink on POSIX, copy on Git Bash) ───────────────────
mkdir -p "$TARGET"
echo
if [[ $IS_GIT_BASH -eq 1 ]]; then
  echo "Installing scripts → $TARGET (copies — re-run setup.sh after pulling new changes)"
else
  echo "Installing scripts → $TARGET"
fi
for s in "${SCRIPTS[@]}"; do
  src="$BIN_SRC/$s"
  dest="$TARGET/$s"
  if [[ ! -x "$src" ]]; then
    err "$src is missing or not executable"
    exit 1
  fi
  if [[ $IS_GIT_BASH -eq 1 ]]; then
    # MSYS ln -s falls back to a non-functional Windows-junction
    # unless Developer Mode is on. A plain copy is friction-free; the
    # README documents that the user has to re-run setup.sh after a
    # git pull to refresh.
    cp -f "$src" "$dest"
    ok "$s (copied)"
  elif [[ -L "$dest" ]]; then
    ln -sfn "$src" "$dest"
    ok "$s (relinked)"
  elif [[ -e "$dest" ]]; then
    warn "$dest exists and is not a symlink — skipping"
  else
    ln -s "$src" "$dest"
    ok "$s"
  fi
done

# Friendly warning if $TARGET isn't on PATH (most likely on a fresh user).
case ":$PATH:" in
  *":$TARGET:"*) ;;
  *) warn "$TARGET is not on \$PATH — add this to your shell rc:"
     info "export PATH=\"$TARGET:\$PATH\"" ;;
esac

# Worktrees root: not required but worth flagging.
if [[ ! -d "${HOME}/github/worktrees" ]]; then
  warn "${HOME}/github/worktrees does not exist yet — the dashboard will be empty until you create a worktree under it (or pass --worktrees PATH)."
fi

# Shared AGENTS.md for every dashboard-spawned agent. Lives at the
# worktrees root so it gets read by every claude session whose cwd
# is under ~/github/worktrees/ (per-issue agents + Agent 007). We
# copy from templates/worktrees-AGENTS.md only when the destination
# is missing — never overwrite a customised file, never touch one
# the user has edited.
WT_CLAUDE_SRC="$REPO_DIR/templates/worktrees-AGENTS.md"
WT_CLAUDE_DST="${HOME}/github/worktrees/AGENTS.md"
if [[ -f "$WT_CLAUDE_SRC" ]]; then
  if [[ ! -d "${HOME}/github/worktrees" ]]; then
    info "skipping shared AGENTS.md install — ${HOME}/github/worktrees doesn't exist yet"
  elif [[ -f "$WT_CLAUDE_DST" ]]; then
    info "shared AGENTS.md already exists at $WT_CLAUDE_DST (not overwriting)"
  else
    cp "$WT_CLAUDE_SRC" "$WT_CLAUDE_DST"
    ok "Installed shared AGENTS.md → $WT_CLAUDE_DST"
  fi
fi

# ── Opt-in sync repo configuration ───────────────────────────────────────
# The dashboard can mirror its synced state (commits.jsonl, worktrees.json)
# into a git repo of the user's choice so multiple machines see the same
# activity. By default sync is disabled — pass --sync-repo <git-url> or
# set AGENT_WORKSPACE_SYNC_REPO to enable. The URL is written to
# ~/.config/agent-workspace/sync.conf and read at server start.
SYNC_CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-workspace"
SYNC_CFG="${SYNC_CFG_DIR}/sync.conf"
if [[ -n "$SYNC_REPO_URL" ]]; then
  mkdir -p "$SYNC_CFG_DIR"
  printf '%s\n' "$SYNC_REPO_URL" > "$SYNC_CFG"
  chmod 600 "$SYNC_CFG"
  ok "Wrote sync repo URL → $SYNC_CFG"
elif [[ -f "$SYNC_CFG" ]]; then
  ok "Existing sync repo config kept → $SYNC_CFG"
else
  info "Sync repo not configured — dashboard runs offline."
  info "  Enable later with: $0 --sync-repo <git-url>"
fi

# ── Claude Code hooks (interactive, optional) ─────────────────────────────
# Wires bin/agent-event-notify into ~/.claude/settings.json on the
# Stop / Notification / UserPromptSubmit / SessionStart / SessionEnd
# events so Claude posts to the dashboard's /api/events. Idempotent —
# never duplicates an entry. The Python merge runs in the user's
# settings.json; pre-existing hooks are preserved.
HOOK_SCRIPT="$BIN_SRC/agent-event-notify"
MAILBOX_HOOK_SCRIPT="$BIN_SRC/agent-mailbox-inject"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
HOOK_EVENTS=( Stop Notification UserPromptSubmit SessionStart SessionEnd )
MAILBOX_HOOK_EVENTS=( UserPromptSubmit )

do_install_hooks() {
  python3 - "$CLAUDE_SETTINGS" "$HOOK_SCRIPT" "${HOOK_EVENTS[@]}" <<'PY'
import json, os, sys
from pathlib import Path
settings_path = Path(sys.argv[1])
hook_path = sys.argv[2]
events = sys.argv[3:]
cfg = {}
if settings_path.exists():
    try:
        cfg = json.loads(settings_path.read_text() or "{}")
    except ValueError:
        print(f"warn: {settings_path} is not valid JSON — skipping merge",
              file=sys.stderr)
        sys.exit(2)
hooks = cfg.setdefault("hooks", {})
added = []
for ev in events:
    entries = hooks.setdefault(ev, [])
    has_ours = any(
        any(h.get("command") == hook_path for h in entry.get("hooks", []))
        for entry in entries if isinstance(entry, dict)
    )
    if not has_ours:
        entries.append({
            "matcher": "*",
            "hooks": [{"type": "command", "command": hook_path}],
        })
        added.append(ev)
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"added: {','.join(added) if added else '(none — already present)'}")
PY
}

do_install_mailbox_hook() {
  # Register bin/agent-mailbox-inject as a UserPromptSubmit hook so
  # claude prepends "📬 You have N unread message(s)…" context to the
  # agent's next turn whenever there's mail. Uses the same idempotent
  # merge as do_install_hooks but only for the UserPromptSubmit event.
  python3 - "$CLAUDE_SETTINGS" "$MAILBOX_HOOK_SCRIPT" \
    "${MAILBOX_HOOK_EVENTS[@]}" <<'PY'
import json, sys
from pathlib import Path
settings_path = Path(sys.argv[1])
hook_path = sys.argv[2]
events = sys.argv[3:]
cfg = {}
if settings_path.exists():
    try:
        cfg = json.loads(settings_path.read_text() or "{}")
    except ValueError:
        print(f"warn: {settings_path} is not valid JSON — skipping merge",
              file=sys.stderr)
        sys.exit(2)
hooks = cfg.setdefault("hooks", {})
added = []
for ev in events:
    entries = hooks.setdefault(ev, [])
    has_ours = any(
        any(h.get("command") == hook_path for h in entry.get("hooks", []))
        for entry in entries if isinstance(entry, dict)
    )
    if not has_ours:
        entries.append({
            "matcher": "*",
            "hooks": [{"type": "command", "command": hook_path}],
        })
        added.append(ev)
settings_path.parent.mkdir(parents=True, exist_ok=True)
settings_path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"mailbox: {','.join(added) if added else '(none — already present)'}")
PY
}

do_uninstall_hooks() {
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    info "no $CLAUDE_SETTINGS to clean"
    return 0
  fi
  python3 - "$CLAUDE_SETTINGS" "$HOOK_SCRIPT" <<'PY'
import json, sys
from pathlib import Path
settings_path = Path(sys.argv[1])
hook_path = sys.argv[2]
try:
    cfg = json.loads(settings_path.read_text() or "{}")
except (ValueError, FileNotFoundError):
    sys.exit(0)
hooks = cfg.get("hooks") or {}
removed = 0
for ev, entries in list(hooks.items()):
    if not isinstance(entries, list): continue
    new_entries = []
    for entry in entries:
        if not isinstance(entry, dict):
            new_entries.append(entry); continue
        new_inner = [h for h in entry.get("hooks", [])
                     if h.get("command") != hook_path]
        if len(new_inner) == len(entry.get("hooks", [])):
            new_entries.append(entry)
        else:
            removed += 1
            if new_inner:
                copy = dict(entry); copy["hooks"] = new_inner
                new_entries.append(copy)
    if new_entries:
        hooks[ev] = new_entries
    else:
        del hooks[ev]
if not hooks: cfg.pop("hooks", None)
settings_path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"removed: {removed} hook entr{'ies' if removed != 1 else 'y'}")
PY
}

do_uninstall_mailbox_hook() {
  # Mirror of do_uninstall_hooks targeting the mailbox-inject script.
  [[ -f "$CLAUDE_SETTINGS" ]] || return 0
  python3 - "$CLAUDE_SETTINGS" "$MAILBOX_HOOK_SCRIPT" <<'PY'
import json, sys
from pathlib import Path
settings_path = Path(sys.argv[1])
hook_path = sys.argv[2]
try:
    cfg = json.loads(settings_path.read_text() or "{}")
except (ValueError, FileNotFoundError):
    sys.exit(0)
hooks = cfg.get("hooks") or {}
removed = 0
for ev, entries in list(hooks.items()):
    if not isinstance(entries, list): continue
    new_entries = []
    for entry in entries:
        if not isinstance(entry, dict):
            new_entries.append(entry); continue
        new_inner = [h for h in entry.get("hooks", [])
                     if h.get("command") != hook_path]
        if len(new_inner) == len(entry.get("hooks", [])):
            new_entries.append(entry)
        else:
            removed += 1
            if new_inner:
                copy = dict(entry); copy["hooks"] = new_inner
                new_entries.append(copy)
    if new_entries:
        hooks[ev] = new_entries
    else:
        del hooks[ev]
if not hooks: cfg.pop("hooks", None)
settings_path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"mailbox removed: {removed} hook entr{'ies' if removed != 1 else 'y'}")
PY
}

echo
echo "Claude Code hook integration → $CLAUDE_SETTINGS"
hooks_already_configured=0
if [[ -f "$CLAUDE_SETTINGS" ]] \
   && grep -q "agent-event-notify" "$CLAUDE_SETTINGS" 2>/dev/null; then
  hooks_already_configured=1
fi

if [[ $DISABLE_HOOKS -eq 1 ]]; then
  do_uninstall_hooks
  do_uninstall_mailbox_hook
elif [[ $WANT_HOOKS -eq 1 ]]; then
  do_install_hooks
  do_install_mailbox_hook
elif [[ $hooks_already_configured -eq 1 ]]; then
  # event-notify is wired — top up the mailbox hook in case it's
  # missing (older installs won't have it yet).
  do_install_mailbox_hook
  ok "Claude Code hooks already configured (re-run with --disable-claude-hooks to remove)"
elif [[ $NON_INTERACTIVE -eq 1 ]]; then
  info "skipping (--non-interactive) — pass --enable-claude-hooks to wire them up"
else
  if prompt_yn "Wire Claude Code hooks (Stop / Notification / SessionStart…) into the dashboard? (lets the agent post events to /api/events; desktop notifications via notify-send when available)" n; then
    do_install_hooks
    do_install_mailbox_hook
    info "  edit later with --enable-claude-hooks / --disable-claude-hooks"
  else
    info "skipped — pass --enable-claude-hooks any time to wire them up"
  fi
fi

# ── Bash completion ────────────────────────────────────────────────────────
echo
echo "Installing bash completions → $COMPL_TARGET"
mkdir -p "$COMPL_TARGET"
for s in "${COMPLETIONS[@]}"; do
  src="$COMPL_SRC/$s"
  dest="$COMPL_TARGET/$s"
  if [[ ! -f "$src" ]]; then
    warn "$src missing — skipping completion for $s"
    continue
  fi
  if [[ $IS_GIT_BASH -eq 1 ]]; then
    cp -f "$src" "$dest"
    ok "completion for $s (copied)"
  elif [[ -L "$dest" ]]; then
    ln -sfn "$src" "$dest"
    ok "completion for $s (relinked)"
  elif [[ -e "$dest" ]]; then
    warn "$dest exists and is not a symlink — skipping"
  else
    ln -s "$src" "$dest"
    ok "completion for $s"
  fi
done
info "active in new bash shells; for the current shell run:"
info "  source $COMPL_SRC/agent-worktrees-server  (and the other two)"

# ── Local pre-push git hook ────────────────────────────────────────────────
# Runs ruff + pytest before every git push so we don't ship broken code.
# Installer is idempotent — re-running just refreshes the hook content.
if [[ -d "$REPO_DIR/.git" ]]; then
  echo
  echo "Installing git pre-push hook → $REPO_DIR/.git/hooks/pre-push"
  if "$REPO_DIR/bin/install-hooks"; then
    info "bypass with: git push --no-verify"
  else
    warn "pre-push hook install failed — non-fatal, continuing"
  fi
fi

# ── Optional systemd --user unit ───────────────────────────────────────────
if [[ $WANT_SYSTEMD -eq 1 ]]; then
  echo
  if [[ $IS_GIT_BASH -eq 1 ]]; then
    warn "--systemd is Linux-only; on Windows configure auto-start via "
    info "Task Scheduler — e.g. 'schtasks /Create /SC ONLOGON /TN agent-workspace "
    info "/TR \"%USERPROFILE%/bin/agent-worktrees-server --no-open\"'."
    WANT_SYSTEMD=0
  fi
fi
if [[ $WANT_SYSTEMD -eq 1 ]]; then
  echo "Installing systemd --user unit → $UNIT_FILE"
  if ! command -v systemctl >/dev/null 2>&1; then
    err "systemctl not found — cannot install --systemd unit"
    exit 1
  fi
  mkdir -p "$(dirname "$UNIT_FILE")"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=agent-workspace dashboard
After=default.target

[Service]
Type=simple
ExecStart=$BIN_SRC/agent-worktrees-server --no-open
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
  ok "$UNIT_NAME enabled and started"
  info "logs:    journalctl --user -u $UNIT_NAME -f"
  info "stop:    systemctl --user stop $UNIT_NAME"
  info "disable: systemctl --user disable --now $UNIT_NAME"
fi

# ── Optional autostart on login (all three platforms) ────────────────────
# Linux: freedesktop launcher entry + XDG autostart (no systemd needed).
# macOS: ~/Library/LaunchAgents plist registered via launchctl.
# Windows (Git Bash): per-user Startup folder .vbs.
#
# All three share the same `--autostart` / `--no-autostart` / interactive
# prompt path. Resolve the choice once up front so each platform branch
# only carries the platform-specific write/remove logic.
if [[ $WANT_AUTOSTART -eq -1 ]]; then
  if [[ $NON_INTERACTIVE -eq 1 ]]; then
    WANT_AUTOSTART=0
  else
    echo
    if prompt_yn "Start the dashboard automatically when you log in?" y; then
      WANT_AUTOSTART=1
    else
      WANT_AUTOSTART=0
    fi
  fi
fi

case "$(uname -s)" in
  Linux)
    echo
    echo "Freedesktop launcher → $DESKTOP_FILE"
    # Distinct from static/favicon.svg so the launcher doesn't look
    # identical to the dashboard's PWA install (which inherits the
    # favicon via manifest.json).
    ICON_SRC="$REPO_DIR/static/server-icon.svg"
    LAUNCH_BIN="$BIN_SRC/agent-workspace-launch"
    SERVER_BIN="$BIN_SRC/agent-worktrees-server"

    mkdir -p "$DESKTOP_DIR"
    cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Agentic Engineering Workspace - Server
GenericName=Dashboard server
Comment=Start the Agentic Engineering Workspace dashboard server and open it in a chromeless window (Chrome/Edge/Brave) or your default browser
Exec=$LAUNCH_BIN
Icon=$ICON_SRC
Terminal=false
Categories=Development;
Keywords=claude;worktree;git;dashboard;server;
StartupNotify=true
EOF
    chmod 644 "$DESKTOP_FILE"
    ok "wrote $DESKTOP_FILE"
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
    fi
    info "shows up under 'Agent Workspace' in your app launcher"
    info "drag it to your desktop / pin to dock from there"

    # XDG autostart (no systemd). The WANT_AUTOSTART choice was
    # already resolved above so all three platforms share the prompt.
    echo
    echo "Autostart on login (no systemd) → $AUTOSTART_FILE"
    if [[ $WANT_AUTOSTART -eq 1 ]]; then
      mkdir -p "$AUTOSTART_DIR"
      cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Agentic Engineering Workspace - Server (autostart)
Comment=Start the Agentic Engineering Workspace dashboard server on login
Exec=$SERVER_BIN --no-open
Icon=$ICON_SRC
Terminal=false
Categories=Development;
X-GNOME-Autostart-enabled=true
StartupNotify=false
EOF
      chmod 644 "$AUTOSTART_FILE"
      ok "wrote $AUTOSTART_FILE — server starts on next login"
      info "disable later: rm $AUTOSTART_FILE   (or: $0 --no-autostart)"
    elif [[ -f "$AUTOSTART_FILE" ]]; then
      # Explicit --no-autostart removes an existing entry. The interactive
      # "no" answer also lands here.
      rm -f "$AUTOSTART_FILE"
      ok "removed $AUTOSTART_FILE"
    else
      info "skipped — re-run with --autostart any time to enable"
    fi
    ;;

  Darwin)
    # macOS LaunchAgent. The plist tells launchd to run the dashboard
    # server as the logged-in user at every login. RunAtLoad=true means
    # it also starts immediately when bootstrapped this session.
    # No KeepAlive — matches the Linux XDG autostart shape (one-shot
    # on login, not auto-restarted on crash).
    echo
    echo "macOS autostart (LaunchAgent) → $LAUNCH_AGENT_FILE"
    SERVER_BIN="$BIN_SRC/agent-worktrees-server"
    LOG_DIR="${HOME}/Library/Logs/agent-workspace"
    if [[ $WANT_AUTOSTART -eq 1 ]]; then
      mkdir -p "$LAUNCH_AGENT_DIR" "$LOG_DIR"
      cat > "$LAUNCH_AGENT_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${SERVER_BIN}</string>
        <string>--no-open</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/launchd.out</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/launchd.err</string>
</dict>
</plist>
EOF
      chmod 644 "$LAUNCH_AGENT_FILE"
      ok "wrote $LAUNCH_AGENT_FILE"
      if command -v launchctl >/dev/null 2>&1; then
        # bootstrap is the modern verb (macOS 10.10+); fall back to
        # load -w if bootstrap rejects (e.g. agent already registered).
        if launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_FILE" 2>/dev/null; then
          ok "launchctl bootstrap — server started for this session"
        elif launchctl load -w "$LAUNCH_AGENT_FILE" 2>/dev/null; then
          ok "launchctl load -w — server started for this session"
        else
          info "couldn't bootstrap now — will start on next login"
        fi
      else
        warn "launchctl not on PATH — plist written but not loaded"
      fi
      info "logs:    tail -F $LOG_DIR/launchd.{out,err}"
      info "disable: $0 --no-autostart"
    elif [[ -f "$LAUNCH_AGENT_FILE" ]]; then
      if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)/${LAUNCH_AGENT_LABEL}" 2>/dev/null \
          || launchctl unload "$LAUNCH_AGENT_FILE" 2>/dev/null || true
      fi
      rm -f "$LAUNCH_AGENT_FILE"
      ok "removed $LAUNCH_AGENT_FILE"
    else
      info "skipped — re-run with --autostart any time to enable"
    fi
    ;;

  MINGW*|MSYS*|CYGWIN*)
    # Windows (Git Bash) — drop a .vbs into the per-user Startup folder.
    # WScript.Run with WindowStyle=0 launches bash.exe silently (no
    # flashing cmd window). The wrapper enters a login shell so ~/bin
    # (where setup.sh just copied agent-worktrees-server) is on PATH.
    echo
    if [[ -z "$WIN_STARTUP_DIR" ]]; then
      warn "APPDATA not set — can't locate the Startup folder; skipping autostart"
    else
      echo "Windows autostart → $WIN_AUTOSTART_FILE"
      if [[ $WANT_AUTOSTART -eq 1 ]]; then
        BASH_UNIX="$(command -v bash || true)"
        if [[ -z "$BASH_UNIX" ]]; then
          warn "bash not on PATH — cannot write Windows autostart entry"
        else
          if command -v cygpath >/dev/null 2>&1; then
            BASH_WIN="$(cygpath -w "$BASH_UNIX")"
          else
            BASH_WIN="$BASH_UNIX"
          fi
          mkdir -p "$WIN_STARTUP_DIR"
          # VBScript escaping: a literal double-quote in a string is
          # written as "". The .vbs invokes bash.exe with --login -c
          # so ~/bin (Git Bash's per-user PATH entry) is in scope.
          # Single-quoted heredoc + manual substitution keeps the
          # ${BASH_WIN} placeholder readable.
          cat > "$WIN_AUTOSTART_FILE" <<EOF
' agent-workspace autostart — generated by setup.sh
' Launches the dashboard server silently on login (WindowStyle=0).
' Remove this file (or run \`setup.sh --no-autostart\`) to disable.
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${BASH_WIN}"" --login -c ""agent-worktrees-server --no-open""", 0, False
EOF
          ok "wrote $WIN_AUTOSTART_FILE"
          info "starts the server on next login (no console window)"
          info "disable: $0 --no-autostart"
        fi
      elif [[ -f "$WIN_AUTOSTART_FILE" ]]; then
        rm -f "$WIN_AUTOSTART_FILE"
        ok "removed $WIN_AUTOSTART_FILE"
      else
        info "skipped — re-run with --autostart any time to enable"
      fi
    fi
    ;;
esac

echo
ok "Setup complete."
echo
echo "Start the server:    agent-worktrees-server"
echo "Open the dashboard:  http://127.0.0.1:8765/"
