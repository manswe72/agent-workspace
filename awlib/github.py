"""GitHub Issues + PRs client.

Maps each workspace folder name onto the matching GitHub issue and/or
PR across a user-configured set of repositories so the dashboard can
render the same status pill / link the old Jira integration used to.

Configuration model — **no `.conf` file is read or written here**.
The repo list lives in the dashboard's own preferences (SQLite), edited
from the Profile UI. The token is fetched from one of two
non-preference sources so it stays out of plaintext DB state:

  - `GITHUB_TOKEN` env var (preferred)
  - one-line file at `~/.config/agent-workspace/github-token`
    (chmod 600 — single-purpose, no other content)

The dashboard calls `configure(repos=[...])` at startup with the
current repo list, then calls the fetch_* helpers. Anonymous calls
work for public repos at 60 req/h; authenticated at 5000 req/h.

Two backends auto-selected per call:

  1. **`gh` CLI** if installed + authenticated (uses your `gh auth`).
  2. **GitHub REST API** otherwise (uses the token resolved above).

All fetches are cached for 5 minutes.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

HOME = Path.home()
_TOKEN_FILE = HOME / ".config" / "agent-workspace" / "github-token"

_PR_CACHE: dict[str, dict] = {}        # repo → {prs, ts, err}
_ISSUE_LIST_CACHE: dict[str, dict] = {} # repo → {issues, ts, err}
_ISSUE_DETAIL_CACHE: dict[tuple[str, int], tuple[float, dict | None]] = {}
_CACHE_TTL = 5 * 60

_log: Callable[..., None] = lambda *a, **k: None

_API_BASE = "https://api.github.com"
_COMMON_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "agent-workspace",
    "X-GitHub-Api-Version": "2022-11-28",
}

# Configured repo list (e.g. ["owner/foo", "owner/bar"]). Empty means
# the integration is off — fetch_* helpers return ([], "not configured").
_REPOS: list[str] = []


def configure(repos: list[str] | None) -> None:
    """Set the active repo list. Pass [] or None to disable the
    integration. Idempotent; safe to call on every preferences change."""
    global _REPOS
    new = [r.strip() for r in (repos or []) if r and "/" in r]
    if new != _REPOS:
        # Repo list changed — invalidate caches so stale data from the
        # previous repos doesn't leak through.
        _PR_CACHE.clear()
        _ISSUE_LIST_CACHE.clear()
        _ISSUE_DETAIL_CACHE.clear()
    _REPOS = new


def configure_logger(log_fn: Callable[..., None]) -> None:
    global _log
    _log = log_fn


def configured_repos() -> list[str]:
    return list(_REPOS)


def _resolve_token() -> str | None:
    """Token from env or the one-line file. Returns None when unset."""
    env = os.environ.get("GITHUB_TOKEN")
    if env:
        return env.strip()
    try:
        if _TOKEN_FILE.is_file():
            return _TOKEN_FILE.read_text().strip() or None
    except OSError:
        pass
    return None


def _request(url: str, token: str | None) -> tuple[object | None, str | None]:
    """Thin GET helper returning (parsed_json, err)."""
    headers = dict(_COMMON_HEADERS)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8", "replace")), None
    except urllib.error.HTTPError as ex:
        return None, f"HTTP {ex.code}: {ex.reason}"
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as ex:
        return None, f"network: {ex}"


def _whoami(token: str) -> str | None:
    data, _ = _request(f"{_API_BASE}/user", token)
    return (data or {}).get("login") if isinstance(data, dict) else None


# ── gh CLI path ─────────────────────────────────────────────────────────

def _gh_cli_list_prs(repo: str) -> list[dict] | None:
    if not shutil.which("gh"):
        return None
    fields = "number,title,state,url,headRefName,isDraft,updatedAt,author"
    try:
        r = subprocess.run(
            # No author filter — list every open PR in the repo so the
            # dashboard surface matches the "My GitHub issues" modal's
            # broader scope. Users care about PRs they need to review
            # or are watching, not just ones they opened themselves.
            ["gh", "pr", "list", "--repo", repo,
             "--search", "is:open",
             "--json", fields, "--limit", "100"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        _log("warn", "github", "gh pr list non-zero",
             repo=repo, stderr=r.stderr.strip())
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


# ── REST PR list ────────────────────────────────────────────────────────

def _rest_list_prs(repo: str) -> tuple[list[dict] | None, str | None]:
    """Every open PR in the repo. Used to be filtered to author=me;
    matches the "My GitHub issues" modal's broader view now (which
    includes PRs you may want to review even if you didn't open them)."""
    token = _resolve_token()
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/pulls?state=open&per_page=100", token)
    if data is None:
        return None, err
    if not isinstance(data, list):
        return None, "unexpected response shape"
    out: list[dict] = []
    for pr in data:
        login = ((pr.get("user") or {}).get("login")) or ""
        out.append({
            "repo": repo,
            "number": pr.get("number"),
            "title": pr.get("title") or "",
            "state": pr.get("state") or "",
            "url": pr.get("html_url") or "",
            "headRefName": ((pr.get("head") or {}).get("ref")) or "",
            "isDraft": bool(pr.get("draft")),
            "updatedAt": pr.get("updated_at") or "",
            "author": {"login": login},
        })
    return out, None


def _fetch_repo_prs(repo: str, force: bool) -> tuple[list[dict], str | None]:
    now = time.time()
    entry = _PR_CACHE.get(repo)
    if not force and entry and (now - entry["ts"]) < _CACHE_TTL:
        return entry["prs"], entry["err"]
    prs = _gh_cli_list_prs(repo)
    err: str | None = None
    if prs is None:
        prs, err = _rest_list_prs(repo)
    if prs is None:
        _PR_CACHE[repo] = {"prs": [], "err": err or "unreachable", "ts": now}
        return [], err
    # gh CLI doesn't include the repo field — stamp it in for symmetry.
    for pr in prs:
        pr.setdefault("repo", repo)
    _PR_CACHE[repo] = {"prs": prs, "err": None, "ts": now}
    return prs, None


def fetch_my_prs(force: bool = False) -> tuple[list[dict], str | None]:
    """All open PRs you authored across every configured repo."""
    if not _REPOS:
        return [], "GitHub not configured"
    all_prs: list[dict] = []
    errs: list[str] = []
    for repo in _REPOS:
        prs, err = _fetch_repo_prs(repo, force)
        all_prs.extend(prs)
        if err:
            errs.append(f"{repo}: {err}")
    return all_prs, ("; ".join(errs) if errs else None)


def pr_for_workspace(workspace: str) -> dict | None:
    """First PR whose head branch matches the workspace folder name."""
    if not workspace:
        return None
    prs, _ = fetch_my_prs()
    for pr in prs:
        head = pr.get("headRefName") or ""
        if head == workspace or head.startswith(f"{workspace}/"):
            return pr
    return None


# ── Issues ──────────────────────────────────────────────────────────────

_LEADING_NUM_RE = re.compile(r"^(\d+)(?:-|$)")


def issue_number_from_workspace(workspace: str) -> int | None:
    """Parse the leading <num>-<slug> pattern. Returns None when the
    folder name doesn't start with digits."""
    if not workspace:
        return None
    m = _LEADING_NUM_RE.match(workspace)
    return int(m.group(1)) if m else None


def _shape_issue(repo: str, raw: dict) -> dict:
    labels = []
    for lab in raw.get("labels") or []:
        if isinstance(lab, dict):
            labels.append({"name": lab.get("name") or "",
                            "color": lab.get("color") or ""})
        elif isinstance(lab, str):
            labels.append({"name": lab, "color": ""})
    return {
        "repo": repo,
        "number": raw.get("number"),
        "title": raw.get("title") or "",
        "state": raw.get("state") or "",
        "state_reason": raw.get("state_reason") or "",
        "url": raw.get("html_url") or "",
        "updated_at": raw.get("updated_at") or "",
        "labels": labels,
        "assignee": ((raw.get("assignee") or {}).get("login")) or "",
        "is_pr": bool(raw.get("pull_request")),
    }


def fetch_issue(repo: str, number: int) -> dict | None:
    """Single issue. 5-min cache keyed by (repo, number)."""
    now = time.time()
    cached = _ISSUE_DETAIL_CACHE.get((repo, number))
    if cached and (now - cached[0]) < _CACHE_TTL:
        return cached[1]
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/issues/{number}", _resolve_token())
    if err:
        _log("warn", "github", "fetch_issue failed",
             repo=repo, number=number, error=err)
        _ISSUE_DETAIL_CACHE[(repo, number)] = (now, None)
        return None
    issue = _shape_issue(repo, data) if isinstance(data, dict) else None
    _ISSUE_DETAIL_CACHE[(repo, number)] = (now, issue)
    return issue


def _fetch_repo_issues(repo: str, force: bool) -> tuple[list[dict], str | None]:
    now = time.time()
    entry = _ISSUE_LIST_CACHE.get(repo)
    if not force and entry and (now - entry["ts"]) < _CACHE_TTL:
        return entry["issues"], entry["err"]
    token = _resolve_token()
    me = _whoami(token) if token else None
    q = "state=open&per_page=100"
    if me:
        q += f"&assignee={urllib.parse.quote(me)}"
    data, err = _request(f"{_API_BASE}/repos/{repo}/issues?{q}", token)
    if err:
        _ISSUE_LIST_CACHE[repo] = {"issues": [], "err": err, "ts": now}
        return [], err
    if not isinstance(data, list):
        _ISSUE_LIST_CACHE[repo] = {
            "issues": [], "err": "unexpected response shape", "ts": now}
        return [], _ISSUE_LIST_CACHE[repo]["err"]
    issues = [_shape_issue(repo, r) for r in data
              if isinstance(r, dict) and not r.get("pull_request")]
    _ISSUE_LIST_CACHE[repo] = {"issues": issues, "err": None, "ts": now}
    return issues, None


def fetch_my_issues(force: bool = False) -> tuple[list[dict], str | None]:
    """All open issues assigned to you across every configured repo."""
    if not _REPOS:
        return [], "GitHub not configured"
    out: list[dict] = []
    errs: list[str] = []
    for repo in _REPOS:
        issues, err = _fetch_repo_issues(repo, force)
        out.extend(issues)
        if err:
            errs.append(f"{repo}: {err}")
    return out, ("; ".join(errs) if errs else None)


def issue_for_workspace(workspace: str) -> dict | None:
    """The GitHub issue a workspace maps to. Tries every configured repo
    in order, returning the first hit. None when the workspace name
    doesn't start with digits or no repo has that issue number."""
    num = issue_number_from_workspace(workspace)
    if num is None:
        return None
    for repo in _REPOS:
        found = fetch_issue(repo, num)
        if found is not None:
            return found
    return None


# ── PR event polling ────────────────────────────────────────────────────
#
# We don't have webhooks (no public URL), so the dashboard polls each
# tracked PR for the four event surfaces the user cares about:
#   - issue events  (review_requested, closed, merged, ready_for_review)
#   - PR reviews    (approved, changes_requested, commented)
#   - PR comments   (issue-level comments on the PR thread)
# A single poll cycle issues 3 GET calls per PR. With the default 5 min
# interval that's well under the 5000 req/hr authenticated quota.

_PR_EVENT_ACTIONABLE_KINDS = {
    "review_requested",
    "review_request_removed",
    "closed",
    "reopened",
    "merged",
    "ready_for_review",
}


def fetch_pr_events(repo: str, pr_number: int) -> tuple[list[dict], str | None]:
    """Return (events, err). Each event is a normalised dict with:
       event_id   — GitHub's numeric id (PK across all 3 endpoints below)
       kind       — short tag like 'github_pr_review_requested',
                    'github_pr_review_approved', 'github_pr_comment'
       actor      — login of who triggered it
       created_at — ISO-8601 timestamp
       message    — short human-readable summary
       pr_number  — int
       repo       — "owner/repo"
    Best-effort: a network blip yields ([], err). The caller decides
    whether to back off.
    """
    out: list[dict] = []
    errs: list[str] = []
    token = _resolve_token()

    def _actor(d):
        u = d.get("user") or d.get("actor") or {}
        return u.get("login") or ""

    # 1. Issue events — review_requested, closed, merged, etc.
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/issues/{pr_number}/events", token)
    if err:
        errs.append(f"events: {err}")
    elif isinstance(data, list):
        for e in data:
            kind = (e.get("event") or "").lower()
            if kind not in _PR_EVENT_ACTIONABLE_KINDS:
                continue
            eid = e.get("id")
            if eid is None:
                continue
            actor = _actor(e)
            msg = f"PR #{pr_number}: {kind.replace('_', ' ')}"
            if actor:
                msg += f" by @{actor}"
            out.append({
                "event_id": int(eid),
                "repo": repo, "pr_number": pr_number,
                "kind": f"github_pr_{kind}",
                "actor": actor,
                "created_at": e.get("created_at") or "",
                "message": msg,
            })

    # 2. PR reviews — approved / changes_requested / commented
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/pulls/{pr_number}/reviews", token)
    if err:
        errs.append(f"reviews: {err}")
    elif isinstance(data, list):
        for r in data:
            state = (r.get("state") or "").lower()
            if state not in ("approved", "changes_requested", "commented"):
                continue
            rid = r.get("id")
            if rid is None:
                continue
            actor = _actor(r)
            human = state.replace("_", " ")
            msg = f"PR #{pr_number}: review {human}"
            if actor:
                msg += f" by @{actor}"
            out.append({
                "event_id": int(rid),
                "repo": repo, "pr_number": pr_number,
                "kind": f"github_pr_review_{state}",
                "actor": actor,
                "created_at": r.get("submitted_at") or r.get("created_at") or "",
                "message": msg,
            })

    # 3. PR comments (issue-level comments thread)
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/issues/{pr_number}/comments", token)
    if err:
        errs.append(f"comments: {err}")
    elif isinstance(data, list):
        for c in data:
            cid = c.get("id")
            if cid is None:
                continue
            actor = _actor(c)
            body = (c.get("body") or "").strip().splitlines()
            preview = (body[0][:140] + "…") if body and len(body[0]) > 140 else (body[0] if body else "")
            msg = f"PR #{pr_number}: new comment"
            if actor:
                msg += f" by @{actor}"
            if preview:
                msg += f" — {preview}"
            out.append({
                "event_id": int(cid),
                "repo": repo, "pr_number": pr_number,
                "kind": "github_pr_comment",
                "actor": actor,
                "created_at": c.get("created_at") or "",
                "message": msg,
            })

    return out, ("; ".join(errs) if errs else None)


def is_configured() -> bool:
    return bool(_REPOS)


def has_token() -> bool:
    return bool(_resolve_token())


# ── Repo picker (Profile → GitHub repos editor) ────────────────────────
_AVAILABLE_REPOS_CACHE: dict = {"repos": [], "ts": 0.0, "err": None}


def fetch_available_repos(force: bool = False) -> tuple[list[dict], str | None]:
    """Every repo the authenticated user can access — owned, org-member,
    or collaborator — for the Profile picker. Sorted by recent push so
    the most-likely candidates float to the top. 5-minute cache. Needs
    a token (anonymous `/user/repos` returns 401)."""
    now = time.time()
    if not force and _AVAILABLE_REPOS_CACHE["repos"] and \
            (now - _AVAILABLE_REPOS_CACHE["ts"]) < _CACHE_TTL:
        return _AVAILABLE_REPOS_CACHE["repos"], _AVAILABLE_REPOS_CACHE["err"]
    token = _resolve_token()
    if not token:
        _AVAILABLE_REPOS_CACHE.update(
            repos=[], err="GITHUB_TOKEN required to list repos", ts=now)
        return [], _AVAILABLE_REPOS_CACHE["err"]
    out: list[dict] = []
    err: str | None = None
    # Page through up to 5 pages (500 repos) — anything beyond that is
    # very rare for a single user and the picker should not be a
    # comprehensive directory browser.
    for page in range(1, 6):
        data, e = _request(
            f"{_API_BASE}/user/repos?per_page=100&sort=pushed&page={page}",
            token)
        if e:
            err = e
            break
        if not isinstance(data, list) or not data:
            break
        for r in data:
            out.append({
                "slug": r.get("full_name") or "",
                "private": bool(r.get("private")),
                "fork": bool(r.get("fork")),
                "archived": bool(r.get("archived")),
                "description": r.get("description") or "",
                "pushed_at": r.get("pushed_at") or "",
            })
        if len(data) < 100:
            break
    _AVAILABLE_REPOS_CACHE.update(repos=out, err=err, ts=now)
    return out, err
