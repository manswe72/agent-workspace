#!/usr/bin/env bash
# install.sh — one-line bootstrap for agent-workspace.
#
# Clones (or updates) the repo into ~/github/agent-workspace and runs
# setup.sh, which does the per-machine install (symlinks, completions,
# optional systemd unit, optional Claude Code hooks).
#
# Usage (interactive):
#   bash install.sh --repo https://github.com/<user>/agent-workspace.git
#
# Usage (one-line, after hosting this file on an HTTPS endpoint):
#   curl -fsSL https://<host>/install.sh | bash -s -- --repo <git-url>
#   curl -fsSL https://<host>/install.sh | bash -s -- --repo <git-url> --non-interactive
#
# Flags:
#   --repo URL        git remote to clone (REQUIRED — no default)
#   --dir PATH        where to clone (default: ~/github/agent-workspace)
#   --branch NAME     branch / tag / SHA to check out (default: origin HEAD)
#   --no-setup        skip the setup.sh step (just clone)
#   any other flags   forwarded to setup.sh
#
# Environment variables (equivalent to flags):
#   AGENT_WORKSPACE_REPO, AGENT_WORKSPACE_DIR, AGENT_WORKSPACE_BRANCH

set -euo pipefail

REPO_URL="${AGENT_WORKSPACE_REPO:-}"
TARGET_DIR="${AGENT_WORKSPACE_DIR:-$HOME/github/agent-workspace}"
BRANCH="${AGENT_WORKSPACE_BRANCH:-}"
RUN_SETUP=1
SETUP_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)   REPO_URL="${2:?--repo needs a URL}"; shift 2 ;;
    --repo=*) REPO_URL="${1#*=}"; shift ;;
    --dir)    TARGET_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --dir=*)  TARGET_DIR="${1#*=}"; shift ;;
    --branch) BRANCH="${2:?--branch needs a name}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --no-setup) RUN_SETUP=0; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) SETUP_ARGS+=("$1"); shift ;;
  esac
done

err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    err "missing dependency: $1"
    exit 1
  }
}

need git
need python3

# Python 3.10+ check — agent_workspace.py uses match/case and PEP-604 unions.
py_ver=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
py_major=${py_ver%%.*}
py_minor=${py_ver##*.}
if (( py_major < 3 || (py_major == 3 && py_minor < 10) )); then
  err "python 3.10+ required (found $py_ver)"
  exit 1
fi

if [[ -z "$REPO_URL" ]] && [[ ! -d "$TARGET_DIR/.git" ]]; then
  err "no --repo given and $TARGET_DIR is not an existing checkout"
  info "supply a git remote URL via --repo or AGENT_WORKSPACE_REPO"
  info "e.g. --repo https://github.com/<your-user>/agent-workspace.git"
  exit 1
fi

printf '\n\033[1magent-workspace installer\033[0m\n'
[[ -n "$REPO_URL" ]] && info "repo:   $REPO_URL"
info "target: $TARGET_DIR"
[[ -n "$BRANCH" ]] && info "branch: $BRANCH"

# Windows (Git Bash): one-time PowerShell module install for the
# agent-event-notify desktop popups. Notify the user up front so
# they can grant the prompt while setup.sh is still running.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    info ""
    info "Windows note — install the BurntToast PowerShell module once"
    info "for desktop notifications from Claude Code hooks:"
    info "  powershell -Command \"Install-Module -Name BurntToast -Scope CurrentUser\""
    ;;
esac
printf '\n'

if [[ -d "$TARGET_DIR/.git" ]]; then
  ok "target exists — updating"
  git -C "$TARGET_DIR" fetch --quiet origin
  if [[ -n "$BRANCH" ]]; then
    git -C "$TARGET_DIR" checkout --quiet "$BRANCH"
    git -C "$TARGET_DIR" pull --quiet --ff-only origin "$BRANCH" || true
  else
    git -C "$TARGET_DIR" pull --quiet --ff-only || true
  fi
elif [[ -e "$TARGET_DIR" ]]; then
  err "$TARGET_DIR exists and is not a git checkout — refusing to overwrite"
  exit 1
else
  ok "cloning $REPO_URL"
  mkdir -p "$(dirname "$TARGET_DIR")"
  if [[ -n "$BRANCH" ]]; then
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
  else
    git clone --quiet "$REPO_URL" "$TARGET_DIR"
  fi
fi

if [[ $RUN_SETUP -eq 1 ]]; then
  if [[ ! -x "$TARGET_DIR/setup.sh" ]]; then
    err "$TARGET_DIR/setup.sh missing or not executable"
    exit 1
  fi
  ok "running setup.sh"
  printf '\n'
  "$TARGET_DIR/setup.sh" "${SETUP_ARGS[@]}"
else
  ok "skipped setup.sh (--no-setup)"
  info "run it later: $TARGET_DIR/setup.sh"
fi

printf '\n'
ok "done"
info "start the dashboard: agent-worktrees-server"
info "                  or: $TARGET_DIR/bin/agent-worktrees-server"
