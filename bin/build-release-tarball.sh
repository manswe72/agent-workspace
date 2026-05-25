#!/usr/bin/env bash
# build-release-tarball.sh — package agent-workspace as a downloadable
# source-only release.
#
# Produces dist/agent-workspace-<VERSION>.tar.gz with just the files
# needed to run the dashboard:
#
#   agent_workspace.py, iip.py, awlib/, static/, templates/, bin/,
#   completions/, install.sh, VERSION, README.md, AGENTS.md, LICENSE
#
# Excludes everything related to source-tree development: .git/,
# tests/, packaging/, docs/, data/, .github/, __pycache__, *.pyc,
# editor scratch, etc.
#
# The tarball has no .git/, so a dashboard launched from it is in
# "release install" mode — the in-app Update button is disabled
# (see is_developer_install() in agent_workspace.py). Users
# upgrade by re-downloading the tarball.
#
# Usage:
#   ./bin/build-release-tarball.sh           # build dist/agent-workspace-<VERSION>.tar.gz
#   ./bin/build-release-tarball.sh --zip     # also build the .zip variant
set -euo pipefail

cd "$(dirname "$0")/.."          # repo root

VERSION="$(cat VERSION)"
if [[ -z "$VERSION" ]]; then
  echo "error: VERSION file is empty" >&2
  exit 1
fi

WANT_ZIP=0
for arg in "$@"; do
  case "$arg" in
    --zip) WANT_ZIP=1 ;;
    -h|--help)
      sed -n '2,/^set/p' "$0" | sed -e 's/^# \?//' -e 's/^set.*//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

PREFIX="agent-workspace-${VERSION}"
OUT_TGZ="dist/${PREFIX}.tar.gz"
OUT_ZIP="dist/${PREFIX}.zip"
mkdir -p dist

# Source list — kept in one place so adding a new top-level file is
# a one-line edit. Order doesn't matter (tar sorts internally).
FILES=(
  agent_workspace.py
  awlib
  static
  templates
  bin
  completions
  install.sh
  setup.sh
  VERSION
  README.md
  INSTALL.md
  AGENTS.md
  LICENSE
)

# Sanity-check every entry exists. Catches a typo before tar
# silently produces a half-empty archive.
for f in "${FILES[@]}"; do
  if [[ ! -e "$f" ]]; then
    echo "error: missing required path: $f" >&2
    exit 1
  fi
done

EXCLUDES=(
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='.DS_Store'
  --exclude='*.swp'
)

# Drop the build-tarball script itself from the bin payload — it's
# a developer tool, not something a release install needs.
EXCLUDES+=(--exclude='bin/build-release-tarball.sh')

echo "→ building ${OUT_TGZ}"
tar --transform "s,^,${PREFIX}/," "${EXCLUDES[@]}" \
    -czf "${OUT_TGZ}" "${FILES[@]}"
echo "  $(du -h "${OUT_TGZ}" | cut -f1)  ${OUT_TGZ}"

if (( WANT_ZIP == 1 )); then
  if ! command -v zip >/dev/null 2>&1; then
    echo "warn: zip not installed; skipping .zip" >&2
  else
    echo "→ building ${OUT_ZIP}"
    rm -rf "dist/${PREFIX}"
    mkdir -p "dist/${PREFIX}"
    cp -r "${FILES[@]}" "dist/${PREFIX}/"
    find "dist/${PREFIX}" \( -name __pycache__ -o -name '*.pyc' \
        -o -name '.DS_Store' -o -name '*.swp' \) \
        -exec rm -rf {} + 2>/dev/null || true
    rm -f "dist/${PREFIX}/bin/build-release-tarball.sh"
    ( cd dist && zip -qr "${PREFIX}.zip" "${PREFIX}" )
    rm -rf "dist/${PREFIX}"
    echo "  $(du -h "${OUT_ZIP}" | cut -f1)  ${OUT_ZIP}"
  fi
fi

echo
echo "✓ release ${VERSION} ready in dist/"
echo
echo "Verify contents:"
echo "  tar -tzf ${OUT_TGZ} | head -20"
echo
echo "Smoke-test the install (won't touch ~/.local/bin/agent-workspace if --dry-run):"
echo "  mkdir /tmp/aw-release-test && cd /tmp/aw-release-test"
echo "  tar xzf $PWD/${OUT_TGZ}"
echo "  cd ${PREFIX} && ./install.sh --help"
