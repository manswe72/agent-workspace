#!/usr/bin/env bash
# release.sh — one-command GitHub release.
#
# Wraps:
#   1. clean-tree check (must be on main with no uncommitted changes)
#   2. version selection (defaults to ./VERSION, override with --version X.Y.Z)
#   3. git tag v<VERSION> + push
#   4. ./bin/build-release-tarball.sh
#   5. gh release create v<VERSION> dist/...tar.gz
#
# Release notes default to the git log between the previous tag and
# HEAD. Override with --notes "..." or --notes-file path.
#
# Usage:
#   ./bin/release.sh                              # use ./VERSION as the version
#   ./bin/release.sh --version 0.2.0              # bump VERSION + release
#   ./bin/release.sh --notes "..."                # custom notes
#   ./bin/release.sh --notes-file CHANGELOG.md    # notes from a file
#   ./bin/release.sh --draft                      # draft release (not public)
#   ./bin/release.sh --prerelease                 # mark as pre-release
#   ./bin/release.sh --dry-run                    # print what would happen, do nothing
#
# Required: git, gh (https://cli.github.com/), GitHub auth via
# `gh auth login`, or feed the dashboard's PAT on stdin:
#   gh auth login --with-token < ~/.config/agent-workspace/github-token
# Or skip `gh auth login` entirely and just export GH_TOKEN — gh picks
# it up automatically:
#   export GH_TOKEN=$(cat ~/.config/agent-workspace/github-token)
set -euo pipefail

cd "$(dirname "$0")/.."          # repo root

# ── flags ────────────────────────────────────────────────────────────────
VERSION_OVERRIDE=""
NOTES=""
NOTES_FILE=""
DRAFT=0
PRERELEASE=0
DRY_RUN=0
SKIP_PUSH_TAG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)      VERSION_OVERRIDE="${2:?--version needs a value}"; shift 2 ;;
    --version=*)    VERSION_OVERRIDE="${1#*=}"; shift ;;
    --notes)        NOTES="${2:?--notes needs a value}"; shift 2 ;;
    --notes=*)      NOTES="${1#*=}"; shift ;;
    --notes-file)   NOTES_FILE="${2:?--notes-file needs a path}"; shift 2 ;;
    --notes-file=*) NOTES_FILE="${1#*=}"; shift ;;
    --draft)        DRAFT=1; shift ;;
    --prerelease)   PRERELEASE=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --skip-push-tag) SKIP_PUSH_TAG=1; shift ;;
    -h|--help)
      sed -n '2,/^set/p' "$0" | sed -e 's/^# \?//' -e 's/^set.*//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m→\033[0m %s\n' "$*"; }

run() {
  # When --dry-run is set, print what we'd run and don't execute.
  if (( DRY_RUN )); then
    printf '    \033[36m[dry-run]\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}

# ── prerequisites ────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || { err "git not on PATH"; exit 1; }
command -v gh  >/dev/null 2>&1 || {
  err "gh CLI not on PATH — install from https://cli.github.com/"
  exit 1
}

# gh auth — fail with the right hint instead of cryptic gh errors later.
if ! gh auth status >/dev/null 2>&1; then
  err "gh is not authenticated — run one of:"
  echo "    gh auth login"
  echo "    gh auth login --with-token < ~/.config/agent-workspace/github-token"
  echo "    export GH_TOKEN=\$(cat ~/.config/agent-workspace/github-token)"
  exit 1
fi

# ── repo state checks ────────────────────────────────────────────────────
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != "main" ]]; then
  err "must release from main (currently on '$branch')"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  err "working tree is dirty — commit or stash before releasing"
  git status --short >&2
  exit 1
fi

# Make sure the remote tip matches HEAD. A release tag on an
# unpushed commit makes the GitHub release link to a SHA the
# remote doesn't have yet, which is a confusing failure mode.
git fetch --quiet origin main 2>/dev/null || true
local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main 2>/dev/null || echo "")
if [[ -n "$remote_sha" && "$local_sha" != "$remote_sha" ]]; then
  err "local main ($local_sha) differs from origin/main ($remote_sha)"
  err "push or pull first, then re-run"
  exit 1
fi

# ── version + tag ────────────────────────────────────────────────────────
if [[ -n "$VERSION_OVERRIDE" ]]; then
  VERSION="$VERSION_OVERRIDE"
  # Bump VERSION file when explicitly overridden so subsequent
  # builds use the new number. Commit the bump as its own commit
  # so the release tag points at the version it claims to be.
  current=$(cat VERSION 2>/dev/null || echo "")
  if [[ "$VERSION" != "$current" ]]; then
    step "bumping VERSION: $current → $VERSION"
    if (( DRY_RUN )); then
      printf '    \033[36m[dry-run]\033[0m would write %s to VERSION + commit\n' "$VERSION"
    else
      printf '%s\n' "$VERSION" > VERSION
      git add VERSION
      git commit -m "Release v$VERSION"
      git push origin main
    fi
  fi
else
  VERSION=$(cat VERSION)
fi

if [[ -z "$VERSION" || ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$ ]]; then
  err "VERSION '$VERSION' doesn't look like semver (X.Y.Z or X.Y.Z-suffix)"
  exit 1
fi

TAG="v$VERSION"

# Refuse to re-tag an already-released version. `gh release view`
# returns non-zero when the release doesn't exist yet — exactly
# what we want.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  err "tag $TAG already exists locally"
  err "delete with: git tag -d $TAG && git push origin :refs/tags/$TAG"
  exit 1
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  err "release $TAG already exists on GitHub"
  err "delete with: gh release delete $TAG"
  exit 1
fi

# ── release notes ────────────────────────────────────────────────────────
if [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -r "$NOTES_FILE" ]]; then
    err "notes file not readable: $NOTES_FILE"
    exit 1
  fi
  NOTES=$(< "$NOTES_FILE")
elif [[ -z "$NOTES" ]]; then
  # Auto-generate: commit subjects since the previous tag (or
  # since the repo's first commit when there are no tags yet).
  prev_tag=$(git tag --list 'v*' --sort=-v:refname | head -1)
  if [[ -n "$prev_tag" ]]; then
    NOTES=$(git log --pretty=format:'- %s' "$prev_tag"..HEAD)
    NOTES="Changes since $prev_tag:"$'\n\n'"$NOTES"
  else
    NOTES=$(git log --pretty=format:'- %s' HEAD | head -50)
    NOTES="First release."$'\n\n'"Recent commits:"$'\n\n'"$NOTES"
  fi
fi

# ── confirm ──────────────────────────────────────────────────────────────
printf '\n\033[1magent-workspace release\033[0m\n'
printf '  version : %s\n' "$VERSION"
printf '  tag     : %s\n' "$TAG"
printf '  branch  : %s\n' "$branch"
printf '  HEAD    : %s\n' "$(git log -1 --pretty='%h %s')"
[[ "$DRAFT" -eq 1 ]] && printf '  type    : draft\n'
[[ "$PRERELEASE" -eq 1 ]] && printf '  type    : prerelease\n'
printf '  notes   :\n'
printf '%s\n' "$NOTES" | sed 's/^/    /'

if (( DRY_RUN )); then
  printf '\n\033[36m[dry-run]\033[0m no changes made.\n'
fi

# ── build tarball ────────────────────────────────────────────────────────
step "building release tarball"
run ./bin/build-release-tarball.sh
TARBALL="dist/agent-workspace-${VERSION}.tar.gz"
STABLE_TARBALL="dist/agent-workspace.tar.gz"
if (( ! DRY_RUN )) && [[ ! -f "$TARBALL" ]]; then
  err "tarball not found at $TARBALL"
  exit 1
fi
# Stable-named copy uploaded alongside the versioned one. Lets
# install docs link to a permanent URL:
#   /releases/latest/download/agent-workspace.tar.gz
# that always points at the newest release without doc edits per
# version bump.
if (( ! DRY_RUN )); then
  cp "$TARBALL" "$STABLE_TARBALL"
fi

# ── tag + push ───────────────────────────────────────────────────────────
step "tagging $TAG and pushing to origin"
run git tag -a "$TAG" -m "Release $TAG"
if (( SKIP_PUSH_TAG )); then
  ok "skipped tag push (--skip-push-tag)"
else
  run git push origin "$TAG"
fi

# ── gh release create ────────────────────────────────────────────────────
step "creating GitHub release"
gh_args=("release" "create" "$TAG"
  "$TARBALL"
  "$STABLE_TARBALL"
  "--title" "$TAG"
  "--notes" "$NOTES")
[[ "$DRAFT"      -eq 1 ]] && gh_args+=("--draft")
[[ "$PRERELEASE" -eq 1 ]] && gh_args+=("--prerelease")
run gh "${gh_args[@]}"

printf '\n'
if (( DRY_RUN )); then
  ok "dry-run complete — nothing changed"
else
  ok "released $TAG"
  REPO_SLUG=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "<owner>/<repo>")
  printf '   url:      https://github.com/%s/releases/tag/%s\n' "$REPO_SLUG" "$TAG"
  printf '   tarball:  https://github.com/%s/releases/download/%s/agent-workspace-%s.tar.gz\n' \
    "$REPO_SLUG" "$TAG" "$VERSION"
  printf '   stable:   https://github.com/%s/releases/latest/download/agent-workspace.tar.gz\n' \
    "$REPO_SLUG"
fi
