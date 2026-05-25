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
_UNASSIGNED_LIST_CACHE: dict[str, dict] = {}  # repo → {issues, ts, err}
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
        _UNASSIGNED_LIST_CACHE.clear()
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
    # Open PRs only — merged + closed accumulate forever and aren't
    # actionable from the dashboard. Use `--search is:open` rather
    # than `--state open` so drafts are included (drafts are still
    # "open" to GitHub, but the literal flag would exclude them).
    fields = "number,title,state,url,headRefName,isDraft,updatedAt,author"
    try:
        r = subprocess.run(
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
    """Every OPEN PR in the repo. Merged + closed PRs accumulate
    forever on a long-lived project and aren't actionable from the
    dashboard, so we restrict to state=open here. Drafts are
    included (GitHub treats drafts as state=open with draft=true)
    and rendered with their own pill."""
    token = _resolve_token()
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/pulls"
        f"?state=open&sort=updated&direction=desc&per_page=100",
        token)
    if data is None:
        return None, err
    if not isinstance(data, list):
        return None, "unexpected response shape"
    out: list[dict] = []
    for pr in data:
        login = ((pr.get("user") or {}).get("login")) or ""
        # Distinguish "merged" from "closed without merging" — the
        # REST API exposes this via merged_at (null = closed, set
        # = merged). The state pill in the UI uses this to render
        # merged PRs differently (purple) from cancelled ones (grey).
        out.append({
            "repo": repo,
            "number": pr.get("number"),
            "title": pr.get("title") or "",
            "state": pr.get("state") or "",
            "url": pr.get("html_url") or "",
            "headRefName": ((pr.get("head") or {}).get("ref")) or "",
            "isDraft": bool(pr.get("draft")),
            "updatedAt": pr.get("updated_at") or "",
            "mergedAt": pr.get("merged_at") or "",
            "closedAt": pr.get("closed_at") or "",
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
    """Every OPEN PR across the configured repos. Sorted by
    updatedAt desc so the freshest activity is at the top. No cap
    — open PR lists are bounded by ongoing work, unlike merged/
    closed which would grow forever."""
    if not _REPOS:
        return [], "GitHub not configured"
    all_prs: list[dict] = []
    errs: list[str] = []
    for repo in _REPOS:
        prs, err = _fetch_repo_prs(repo, force)
        all_prs.extend(prs)
        if err:
            errs.append(f"{repo}: {err}")
    all_prs.sort(key=lambda pr: pr.get("updatedAt") or "", reverse=True)
    return all_prs, ("; ".join(errs) if errs else None)


# Per-repo closed-PRs cache, shaped the same way as _PR_CACHE.
# Kept separate so a fresh "my open PRs" fetch doesn't pay the cost
# of also paginating through every closed PR (which can be large
# on long-lived repos).
_MY_CLOSED_PR_CACHE: dict = {}
_MY_CLOSED_CAP_PER_REPO = 20   # plenty for "what did I recently land"


def _rest_list_my_closed_prs(repo: str, login: str
                              ) -> tuple[list[dict] | None, str | None]:
    """Recent merged + closed-without-merging PRs authored by `login`
    in `repo`. Sorted by updatedAt desc and capped at the per-repo
    cap so the modal stays responsive even on repos with thousands
    of historical PRs.

    REST returns 'closed' for both merged-and-not — disambiguated
    downstream via mergedAt."""
    token = _resolve_token()
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/pulls"
        f"?state=closed&sort=updated&direction=desc&per_page=100",
        token)
    if data is None:
        return None, err
    if not isinstance(data, list):
        return None, "unexpected response shape"
    out: list[dict] = []
    for pr in data:
        user_login = ((pr.get("user") or {}).get("login")) or ""
        if user_login.lower() != login.lower():
            continue
        out.append({
            "repo": repo,
            "number": pr.get("number"),
            "title": pr.get("title") or "",
            "state": pr.get("state") or "",
            "url": pr.get("html_url") or "",
            "headRefName": ((pr.get("head") or {}).get("ref")) or "",
            "isDraft": bool(pr.get("draft")),
            "updatedAt": pr.get("updated_at") or "",
            "mergedAt": pr.get("merged_at") or "",
            "closedAt": pr.get("closed_at") or "",
            "author": {"login": user_login},
        })
        if len(out) >= _MY_CLOSED_CAP_PER_REPO:
            break
    return out, None


def _fetch_repo_my_closed_prs(repo: str, login: str, force: bool
                               ) -> tuple[list[dict], str | None]:
    now = time.time()
    entry = _MY_CLOSED_PR_CACHE.get(repo)
    if not force and entry and (now - entry["ts"]) < _CACHE_TTL:
        return entry["prs"], entry["err"]
    prs, err = _rest_list_my_closed_prs(repo, login)
    if prs is None:
        _MY_CLOSED_PR_CACHE[repo] = {"prs": [], "err": err or "unreachable",
                                       "ts": now}
        return [], err
    _MY_CLOSED_PR_CACHE[repo] = {"prs": prs, "err": None, "ts": now}
    return prs, None


def fetch_my_closed_prs(force: bool = False
                         ) -> tuple[list[dict], str | None]:
    """PRs I authored that are merged or closed-without-merging.
    Bounded by my own activity (not everyone else's), so safe to
    keep visible in the dashboard even on long-lived repos.

    Sorted by updatedAt desc, capped at the per-repo cap so the
    modal stays responsive. Returns ([], None) when no token /
    can't resolve /user."""
    if not _REPOS:
        return [], "GitHub not configured"
    token = _resolve_token()
    if not token:
        return [], "no GITHUB_TOKEN — can't resolve current user"
    login = _whoami(token)
    if not login:
        return [], "couldn't resolve /user — check token validity"
    all_prs: list[dict] = []
    errs: list[str] = []
    for repo in _REPOS:
        prs, err = _fetch_repo_my_closed_prs(repo, login, force)
        all_prs.extend(prs)
        if err:
            errs.append(f"{repo}: {err}")
    all_prs.sort(key=lambda pr: pr.get("updatedAt") or "", reverse=True)
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


def _fetch_repo_unassigned_issues(repo: str, force: bool) -> tuple[list[dict], str | None]:
    """All open issues in `repo` with no assignee. Used by the
    Unassigned section in the GitHub modal so users can claim a
    ticket directly from the dashboard."""
    now = time.time()
    entry = _UNASSIGNED_LIST_CACHE.get(repo)
    if not force and entry and (now - entry["ts"]) < _CACHE_TTL:
        return entry["issues"], entry["err"]
    token = _resolve_token()
    # `assignee=none` is GitHub's filter for unassigned issues.
    data, err = _request(
        f"{_API_BASE}/repos/{repo}/issues?state=open&assignee=none&per_page=100",
        token)
    if err:
        _UNASSIGNED_LIST_CACHE[repo] = {"issues": [], "err": err, "ts": now}
        return [], err
    if not isinstance(data, list):
        _UNASSIGNED_LIST_CACHE[repo] = {
            "issues": [], "err": "unexpected response shape", "ts": now}
        return [], _UNASSIGNED_LIST_CACHE[repo]["err"]
    issues = [_shape_issue(repo, r) for r in data
              if isinstance(r, dict) and not r.get("pull_request")]
    _UNASSIGNED_LIST_CACHE[repo] = {"issues": issues, "err": None, "ts": now}
    return issues, None


def fetch_unassigned_issues(force: bool = False) -> tuple[list[dict], str | None]:
    """Aggregate every configured repo's unassigned-issue list."""
    if not _REPOS:
        return [], "GitHub not configured"
    out: list[dict] = []
    errs: list[str] = []
    for repo in _REPOS:
        issues, err = _fetch_repo_unassigned_issues(repo, force)
        out.extend(issues)
        if err:
            errs.append(f"{repo}: {err}")
    return out, ("; ".join(errs) if errs else None)


def assign_issue_to_me(repo: str, number: int) -> tuple[str | None, str | None]:
    """Add the authenticated user to the issue's assignees list.
    Returns (login_assigned, err). Requires a token with
    'Issues: Write' scope (fine-grained PAT) or `repo` scope (classic
    PAT). 403 typically means the token is missing the right scope —
    surface that to the caller as-is."""
    token = _resolve_token()
    if not token:
        return None, "no GITHUB_TOKEN — assignment needs auth"
    login = _whoami(token)
    if not login:
        return None, "couldn't resolve /user — check token validity"
    url = f"{_API_BASE}/repos/{repo}/issues/{number}/assignees"
    body = json.dumps({"assignees": [login]}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    for k, v in _COMMON_HEADERS.items():
        req.add_header(k, v)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            # 201 Created — read but don't need the body
            resp.read()
        # Invalidate the unassigned cache for this repo so the dashboard
        # doesn't re-show the just-claimed issue on next poll.
        _UNASSIGNED_LIST_CACHE.pop(repo, None)
        _ISSUE_LIST_CACHE.pop(repo, None)
        return login, None
    except urllib.error.HTTPError as ex:
        # Surface the GitHub error message — usually says "Resource
        # not accessible by personal access token" when the scope is
        # wrong.
        try:
            payload = json.loads(ex.read().decode("utf-8", "replace"))
            msg = payload.get("message") or str(ex)
        except Exception:  # noqa: BLE001
            msg = str(ex)
        return None, f"HTTP {ex.code}: {msg}"
    except (urllib.error.URLError, OSError, TimeoutError) as ex:
        return None, f"network: {ex}"


def create_pr(repo: str, head: str, base: str, title: str,
              body: str = "", draft: bool = False
              ) -> tuple[dict | None, str | None]:
    """Open a pull request from `head` → `base` in `repo`. Returns
    ({number, url}, None) on success or (None, err_message) on
    failure. The caller is responsible for ensuring the head branch
    is already pushed to origin — GitHub rejects the request with a
    422 otherwise. Token needs `pull_requests:write` (fine-grained
    PAT) or `repo` (classic PAT)."""
    token = _resolve_token()
    if not token:
        return None, "no GITHUB_TOKEN — create_pr needs auth"
    url = f"{_API_BASE}/repos/{repo}/pulls"
    payload = json.dumps({
        "title": title, "body": body or "",
        "head": head, "base": base,
        "draft": bool(draft),
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    for k, v in _COMMON_HEADERS.items():
        req.add_header(k, v)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as ex:
        try:
            payload = json.loads(ex.read().decode("utf-8", "replace"))
            # GitHub returns a structured error list — surface the
            # first message so users see "A pull request already
            # exists for X:branch" instead of just "HTTP 422".
            errs = payload.get("errors") or []
            if errs and isinstance(errs[0], dict):
                msg = errs[0].get("message") or payload.get("message")
            else:
                msg = payload.get("message") or str(ex)
        except Exception:  # noqa: BLE001
            msg = str(ex)
        return None, f"HTTP {ex.code}: {msg}"
    except (urllib.error.URLError, OSError, TimeoutError) as ex:
        return None, f"network: {ex}"
    # Invalidate the per-repo PR list cache so the GitHub modal picks
    # up the new PR on next render without a manual force-refresh.
    _PR_CACHE.pop(repo, None)
    return {
        "number": data.get("number"),
        "url": data.get("html_url"),
        "state": data.get("state"),
        "draft": bool(data.get("draft")),
    }, None


def create_issue(repo: str, title: str, body: str = "",
                  assign_self: bool = False
                  ) -> tuple[dict | None, str | None]:
    """Open a GitHub issue. Returns ({number, url, title}, None) on
    success or (None, err) on failure. When `assign_self` is True,
    also adds the authenticated user as the issue's assignee — saves
    a round-trip when the user is creating a workspace for an issue
    they intend to claim immediately."""
    token = _resolve_token()
    if not token:
        return None, "no GITHUB_TOKEN — create_issue needs auth"
    if not title.strip():
        return None, "title is required"
    payload: dict = {"title": title.strip()}
    if body:
        payload["body"] = body
    if assign_self:
        login = _whoami(token)
        if login:
            payload["assignees"] = [login]
    url = f"{_API_BASE}/repos/{repo}/issues"
    req_body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=req_body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    for k, v in _COMMON_HEADERS.items():
        req.add_header(k, v)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as ex:
        try:
            payload = json.loads(ex.read().decode("utf-8", "replace"))
            msg = payload.get("message") or str(ex)
            errs = payload.get("errors") or []
            if errs and isinstance(errs[0], dict):
                more = errs[0].get("message") or errs[0].get("code")
                if more:
                    msg = f"{msg}: {more}"
        except Exception:  # noqa: BLE001
            msg = str(ex)
        return None, f"HTTP {ex.code}: {msg}"
    except (urllib.error.URLError, OSError, TimeoutError) as ex:
        return None, f"network: {ex}"
    # Invalidate the assigned/unassigned caches for this repo so the
    # new issue surfaces in the GitHub modal without --force.
    _ISSUE_LIST_CACHE.pop(repo, None)
    _UNASSIGNED_LIST_CACHE.pop(repo, None)
    return {
        "number": data.get("number"),
        "url":    data.get("html_url"),
        "title":  data.get("title") or title.strip(),
    }, None


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
