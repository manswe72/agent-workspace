#!/usr/bin/env bash
# install.sh — release-install entry point for agent-workspace.
#
# This script is shipped INSIDE the release tarball. After the user
# extracts `agent-workspace-<version>.tar.gz`, they run:
#
#   cd agent-workspace-<version>
#   ./install.sh
#
# install.sh delegates to setup.sh, which does the per-machine work:
# symlinks the binaries from ./bin into ~/.local/bin, installs bash
# completions, optionally drops an autostart entry, optionally wires
# Claude Code hooks.
#
# The release tarball has no .git/, so the in-app Update button is
# disabled (see is_developer_install() in agent_workspace.py). Users
# upgrade by re-downloading the tarball.
#
# Developers cloning the source repo should run setup.sh directly —
# that path is unchanged and keeps the in-app Update button working.
#
# Flags (all forwarded to setup.sh):
#   --non-interactive         skip the autostart / hooks prompts
#   --autostart / --no-autostart
#   --enable-claude-hooks / --no-claude-hooks
#   --uninstall               remove symlinks + autostart entry
#   --sync-repo <git-url>     opt-in state-sync repo
#   ...                       see ./setup.sh --help for the full list

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sanity check: the tarball should have unpacked agent_workspace.py
# and setup.sh into the same directory as this script. If we can't
# find them we're probably running via `curl | bash` against an old
# bootstrap URL — point the user at the new tarball download.
need_files=(agent_workspace.py setup.sh bin/agent-worktrees-server)
missing=()
for f in "${need_files[@]}"; do
  [[ -e "${SCRIPT_DIR}/${f}" ]] || missing+=("$f")
done
if (( ${#missing[@]} > 0 )); then
  cat >&2 <<EOF
error: this install.sh expects to be run from inside an extracted
release tarball. Missing next to the script:

  $(printf '%s\n  ' "${missing[@]}")

Download the latest release, extract it, and run install.sh from
inside the extracted directory:

  tar xzf agent-workspace-<version>.tar.gz
  cd agent-workspace-<version>
  ./install.sh

(If you want a developer install with the in-app Update button
wired up, clone the source repo and run ./setup.sh directly.)
EOF
  exit 1
fi

# Python 3.10+ check (also done by setup.sh, but a hard-fail before
# any symlinks land gives the user a cleaner error message).
if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found on PATH" >&2
  exit 1
fi
py_ver=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
py_major=${py_ver%%.*}
py_minor=${py_ver##*.}
if (( py_major < 3 || (py_major == 3 && py_minor < 10) )); then
  echo "error: python 3.10+ required (found $py_ver)" >&2
  exit 1
fi

# Hand off to setup.sh — it handles the per-OS symlink / autostart
# / completion work and runs identically for release installs and
# developer source clones (the only difference is the pre-push git
# hook, which setup.sh installs only when .git/ exists).
exec "${SCRIPT_DIR}/setup.sh" "$@"
