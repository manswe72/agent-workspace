"""Provider ABC + helper utilities."""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path

from awlib.logbuf import log_event


class ProviderNotFoundError(KeyError):
    """Raised by providers.get() for an unknown id."""


HOME = Path.home()
MARKER_DIR = HOME / ".cache" / "agent-workspace" / "markers"
AIDER_SKILL_DIR = HOME / ".cache" / "agent-workspace" / "aider-skills"

# Serialises every skill-reconcile filesystem mutation. Modelled on
# _SYNC_LOCK in agent_workspace.py:721 — two WebSocket attaches racing
# to symlink/replace into ~/.claude/skills/ otherwise produces
# FileExistsError / FileNotFoundError / IsADirectoryError surfacing
# at the worst time.
_RECONCILE_LOCK = threading.Lock()

# Sidecar marker that distinguishes dashboard-managed skill entries
# from anything the user installed by hand. Sibling-style (not inside
# the source folder) keeps the user's skill repo clean.
SKILLS_MANAGED_MARKER_SUFFIX = ".managed-by-agent-workspace"

# Per-skill maximum body size — anything past this is truncated with
# a visible marker. Keeps a runaway 50 MB SKILL.md out of every
# non-Claude system prompt on every turn.
SKILL_BODY_MAX_BYTES = 64 * 1024
SKILL_TRUNC_MARKER = "\n\n[…truncated by agent-workspace at 64 KiB…]\n"

# Gemini managed-block delimiters. HTML comments render cleanly inside
# the Markdown view that Gemini reads GEMINI.md as.
GEMINI_BLOCK_BEGIN = "<!-- BEGIN agent-workspace skills -->"
GEMINI_BLOCK_END = "<!-- END agent-workspace skills -->"
GEMINI_CONFIG_PATH = HOME / ".gemini" / "GEMINI.md"

_SAFE_PATH_RE = re.compile(r"[^A-Za-z0-9_.-]")


def _safe_token(s: str) -> str:
    return _SAFE_PATH_RE.sub("-", s)


def marker_file(cwd: Path, provider_id: str) -> Path:
    """The marker file a provider's launcher touches to signal liveness.

    Path-encodes the cwd into a single filename so every provider/cwd
    pair has its own marker. The launcher arranges for the inner bash
    to `touch` this file at start + every 30 s in a background loop.
    """
    return MARKER_DIR / f"{_safe_token(str(cwd))}.{provider_id}.alive"


def marker_state(cwd: Path, provider_id: str) -> str:
    """Compute active/idle/closed from a marker file's mtime."""
    try:
        age = time.time() - marker_file(cwd, provider_id).stat().st_mtime
    except OSError:
        return "closed"
    if age <= 5 * 60:
        return "active"
    if age <= 24 * 60 * 60:
        return "idle"
    return "closed"


def dashboard_mcp_url() -> str:
    """The URL non-Claude providers point their MCP config at.

    Includes the port the dashboard is listening on (read from the
    `AGENT_WORKSPACE_PORT` env var the launcher exports). Path is
    plain `/mcp` — agent identity flows through the `X-Agent-Id`
    header, populated from the `AGENT_WORKSPACE_AGENT_ID` env var
    that the launcher also sets per-shell."""
    import os
    port = os.environ.get("AGENT_WORKSPACE_PORT", "8765")
    return f"http://127.0.0.1:{port}/mcp"


def mcp_server_name() -> str:
    """Slug the dashboard registers under in each provider's config."""
    return "agent-workspace"


def ensure_cursor_mcp_config() -> Path:
    """Idempotently merge the dashboard's MCP server into
    `~/.cursor/mcp.json`. Returns the path. Leaves any other
    pre-existing entries the user added themselves intact."""
    cfg_path = Path.home() / ".cursor" / "mcp.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    name = mcp_server_name()
    entry = {
        "url": dashboard_mcp_url(),
        "headers": {"X-Agent-Id": "${AGENT_WORKSPACE_AGENT_ID}"},
    }
    cfg: dict = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text() or "{}")
            if not isinstance(cfg, dict):
                cfg = {}
        except (OSError, ValueError):
            cfg = {}
    servers = cfg.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        servers = {}
        cfg["mcpServers"] = servers
    # Only rewrite our own entry — preserve anything else.
    if servers.get(name) != entry:
        servers[name] = entry
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
        cfg_path.chmod(0o600)
    return cfg_path


def ensure_codex_mcp_config() -> Path:
    """Idempotently merge the dashboard's MCP server into
    `~/.codex/config.toml` under `[mcp_servers.agent-workspace]`.

    Uses a tiny TOML reader/writer (no toml dep — stdlib stays the
    rule). Edits only the one section; preserves the rest of the
    file byte-for-byte."""
    cfg_path = Path.home() / ".codex" / "config.toml"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    name = mcp_server_name()
    block_header = f"[mcp_servers.{name}]"
    # Codex CLI key names (verified against `codex mcp get` output):
    #   - http_headers       — literal header values (TOML doesn't
    #                           interpolate env vars here, so we
    #                           write a placeholder the user can
    #                           replace OR fall back to
    #                           env_http_headers below)
    #   - env_http_headers   — map of HEADER_NAME → ENV_VAR_NAME;
    #                           Codex reads the value from the env at
    #                           launch. This is what we want — agent
    #                           identity is set per-launch via the
    #                           dashboard's pty env.
    new_block = (
        f"{block_header}\n"
        f'url = "{dashboard_mcp_url()}"\n'
        f'env_http_headers = {{ "X-Agent-Id" = "AGENT_WORKSPACE_AGENT_ID" }}\n'
        f'approval_policy = "never"\n'
    )
    existing = cfg_path.read_text() if cfg_path.is_file() else ""
    if block_header in existing:
        # Replace the existing block (header → next header-or-EOF).
        lines = existing.splitlines(keepends=True)
        out_lines: list[str] = []
        i = 0
        while i < len(lines):
            if lines[i].rstrip() == block_header:
                # Skip until the next section header or EOF.
                out_lines.append(new_block)
                if not out_lines[-1].endswith("\n"):
                    out_lines[-1] += "\n"
                i += 1
                while i < len(lines) and not lines[i].lstrip().startswith("["):
                    i += 1
            else:
                out_lines.append(lines[i])
                i += 1
        new_text = "".join(out_lines)
    else:
        sep = "" if existing.endswith("\n") or not existing else "\n"
        new_text = existing + sep + ("\n" if existing else "") + new_block
    if new_text != existing:
        cfg_path.write_text(new_text)
        cfg_path.chmod(0o600)
    return cfg_path


def ensure_gemini_mcp_config() -> Path:
    """Idempotently merge the dashboard's MCP server into
    `~/.gemini/settings.json` under `mcpServers.<name>`.

    Gemini CLI uses the `httpUrl` key for streamable-HTTP MCP servers
    (Cursor uses `url`; Claude Code uses the same shape via
    `--mcp-config`). Headers support `${VAR}` env-var interpolation
    so the launcher's per-shell AGENT_WORKSPACE_AGENT_ID flows
    through cleanly."""
    cfg_path = Path.home() / ".gemini" / "settings.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    name = mcp_server_name()
    entry = {
        "httpUrl": dashboard_mcp_url(),
        "headers": {"X-Agent-Id": "${AGENT_WORKSPACE_AGENT_ID}"},
    }
    cfg: dict = {}
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text() or "{}")
            if not isinstance(cfg, dict):
                cfg = {}
        except (OSError, ValueError):
            cfg = {}
    servers = cfg.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        servers = {}
        cfg["mcpServers"] = servers
    if servers.get(name) != entry:
        servers[name] = entry
        cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")
        cfg_path.chmod(0o600)
    return cfg_path


def liveness_bash_block(marker_path: Path) -> str:
    """Build a small bash snippet that:
      - mkdir -p the marker dir
      - touches the marker file on launch
      - spawns a background loop that re-touches it every 30 s
        for as long as this shell lives.

    Used by providers that don't have their own session-file mechanism.
    """
    q = shlex.quote(str(marker_path))
    return (
        f"mkdir -p {shlex.quote(str(marker_path.parent))}; "
        f"touch {q}; "
        f"( while [ -e /proc/$$ ] 2>/dev/null || kill -0 $$ 2>/dev/null; "
        f"do touch {q}; sleep 30; done ) >/dev/null 2>&1 & "
    )


class AgentProvider(ABC):
    """Abstract base for an agent CLI provider.

    Implementations:
      - ``id``: short stable string ("claude", "codex", "aider", …).
      - ``display_name``: human label for the dashboard UI.
      - ``binary``: the CLI's executable name; used for is_installed().

    The optional methods (``session_log_path``, ``parse_log_events``,
    ``supports_mcp``, ``supports_hooks``) default to "no" — Claude Code
    overrides them. Other providers can opt in as their CLIs grow
    support.
    """

    id: str = ""
    display_name: str = ""
    binary: str = ""

    def is_installed(self) -> bool:
        return bool(self.binary) and shutil.which(self.binary) is not None

    @abstractmethod
    def build_shell_command(
        self,
        *,
        tab_title: str,
        sys_prompt: str,
        model: str | None,
        mcp_config_path: Path | None,
        aider_skill_path: Path | None = None,
    ) -> str:
        """Return the inner-shell command string the dashboard's pty
        wrapper will exec. The wrapper adds `exec bash` after this so
        the user lands at a prompt when the agent exits.

        `aider_skill_path` is set only when the dispatcher wrote an
        Aider skills tmpfile (`~/.cache/agent-workspace/aider-skills-
        <agent>.txt`). The Aider provider splices it into the launch
        line via `--read`; every other provider ignores it.
        """

    def session_state(self, cwd: Path) -> str:
        """Return 'active' / 'idle' / 'closed'. Default uses the marker
        file the launcher touches; providers that store per-cwd session
        logs (Claude Code) override this to read the log's mtime."""
        return marker_state(cwd, self.id)

    def default_model(self) -> str | None:
        return None

    def model_pricing(self) -> dict[str, dict[str, float]]:
        """Per-Mtok USD pricing keyed by model name. May be empty for
        providers running against local models."""
        return {}

    # ── Optional, default no-op ────────────────────────────────────────
    def session_log_path(self, cwd: Path) -> Path | None:
        return None

    def parse_log_events(self, path: Path) -> list[dict]:
        return []

    def supports_mcp(self) -> bool:
        """The CLI itself speaks MCP as a client. Used by the dashboard
        UI to decide whether to surface MCP-related affordances for
        this provider."""
        return False

    def auto_registers_mcp(self) -> bool:
        """The dashboard auto-injects its in-process MCP server into
        this CLI's launch line. Only Claude Code today, because
        every CLI accepts MCP config differently (flag vs. TOML vs.
        JSON in its own dotdir). Users of other MCP-capable providers
        can wire it themselves — see README."""
        return False

    def supports_hooks(self) -> bool:
        return False


# ── Skill injection ──────────────────────────────────────────────────────

def _strip_skill_frontmatter(text: str) -> str:
    """Drop a leading YAML frontmatter block from a SKILL.md body.

    Strict-but-forgiving: BOM-tolerant, CRLF-tolerant, strips only the
    *first* `---`-delimited block so `---`-separated multi-doc YAML in
    code examples later in the body stays verbatim.
    """
    if text.startswith("﻿"):
        text = text[1:]
    norm = text.replace("\r\n", "\n").replace("\r", "\n")
    if not norm.startswith("---\n"):
        return norm
    end = norm.find("\n---\n", 4)
    if end == -1:
        return norm
    return norm[end + len("\n---\n"):]


def _skill_body(path: Path) -> str:
    """Read SKILL.md from a skill folder; strip frontmatter; size-cap.

    Best-effort: an unreadable file returns "". Caller decides whether
    to skip (no body) or proceed.
    """
    skill_md = path / "SKILL.md"
    try:
        raw = skill_md.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    body = _strip_skill_frontmatter(raw)
    encoded = body.encode("utf-8")
    if len(encoded) > SKILL_BODY_MAX_BYTES:
        cut = encoded[:SKILL_BODY_MAX_BYTES].decode("utf-8", errors="ignore")
        return cut + SKILL_TRUNC_MARKER
    return body


_FRONTMATTER_NAME_RE = re.compile(r"^name:\s*(.+?)\s*$", re.MULTILINE)


def parse_skill_name(path: Path) -> str | None:
    """Read SKILL.md's frontmatter `name:` field, best-effort.

    Returns the parsed name (whitespace-stripped, surrounding quotes
    removed) or None if frontmatter is absent / unreadable / has no
    name key.
    """
    try:
        raw = (path / "SKILL.md").read_text(
            encoding="utf-8", errors="replace")
    except OSError:
        return None
    if raw.startswith("﻿"):
        raw = raw[1:]
    norm = raw.replace("\r\n", "\n").replace("\r", "\n")
    if not norm.startswith("---\n"):
        return None
    end = norm.find("\n---\n", 4)
    if end == -1:
        return None
    fm = norm[4:end]
    m = _FRONTMATTER_NAME_RE.search(fm)
    if not m:
        return None
    val = m.group(1).strip().strip('"').strip("'")
    return val or None


def _short_hex(n_bytes: int = 6) -> str:
    return secrets.token_hex(n_bytes)


def _canary_comment(tag: str) -> str:
    return f"<!-- agent-workspace-inject: {tag} -->"


def _sha256_12(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _emit_skill_event(*, agent_id: str, provider: str, skill_path: str,
                      skill_name: str, injection_path: str,
                      body_sha256: str, result: str, inject_tag: str,
                      reason: str = "") -> None:
    """Single point where a skill_injection audit event is logged.

    All callers go through here so the field schema stays uniform —
    the /api/logs consumer relies on the keys being consistent.
    """
    log_event(
        "info" if result in ("linked", "rule-written",
                              "managed-block-written",
                              "read-file-attached",
                              "sys-prompt-appended", "consumed") else
        ("warn" if result in ("skipped", "consume-timeout",
                              "consume-check-unavailable") else "error"),
        "skills",
        f"{provider} injection: {skill_name} -> {result}",
        agent_id=agent_id,
        provider=provider,
        skill_path=skill_path,
        skill_name=skill_name,
        injection_path=injection_path,
        body_sha256=body_sha256,
        result=result,
        inject_tag=inject_tag,
        reason=reason,
        launch_ts=int(time.time()),
    )


def _atomic_symlink(target: Path, source: Path) -> None:
    """Replace `target` with a symlink to `source` atomically.

    `os.symlink` itself isn't atomic vs. an existing target — we write
    a uniquely-named temp symlink in the same directory then rename it
    over the target via `os.replace`.
    """
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    try:
        os.symlink(source, tmp)
        os.replace(tmp, target)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _atomic_write_text(target: Path, text: str) -> None:
    """Write `text` to `target` atomically. Same temp-file rename dance."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{secrets.token_hex(4)}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, target)
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _verify_symlink_target(link: Path, expected: Path) -> bool:
    try:
        return Path(os.readlink(link)) == expected
    except OSError:
        return False


def _verify_file_hash(target: Path, expected_sha12: str) -> bool:
    try:
        actual = _sha256_12(target.read_text(encoding="utf-8"))
        return actual == expected_sha12
    except OSError:
        return False


def ensure_claude_code_skills(injected: list[dict],
                              agent_id: str) -> None:
    """Reconcile ~/.claude/skills/ against the user's injected-skills
    pref. Idempotent; best-effort; never raises.

    Each managed entry is a `<basename>` symlink to the source folder
    plus a sibling `<basename>.managed-by-agent-workspace` marker and
    a `<basename>.inject-tag` file carrying the per-launch canary so
    the deeper consumption check can spot it in the session log.
    Hand-installed directories (no marker) are never touched.
    """
    skills_dir = HOME / ".claude" / "skills"
    try:
        skills_dir.mkdir(parents=True, exist_ok=True)
    except OSError as ex:
        log_event("error", "skills",
                  "cannot create claude skills dir",
                  agent_id=agent_id, error=str(ex))
        return

    enabled_names: set[str] = set()
    for entry in injected:
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        name = src.name
        skill_md = src / "SKILL.md"
        link = skills_dir / name
        marker = skills_dir / f"{name}{SKILLS_MANAGED_MARKER_SUFFIX}"
        tag_file = skills_dir / f"{name}.inject-tag"
        tag = _short_hex()

        if not skill_md.is_file():
            # Source went missing — reap any link we previously owned.
            if marker.exists() and link.is_symlink():
                try:
                    link.unlink()
                    marker.unlink()
                    tag_file.unlink(missing_ok=True)
                except OSError:
                    pass
            _emit_skill_event(
                agent_id=agent_id, provider="claude",
                skill_path=str(src), skill_name=name,
                injection_path="", body_sha256="",
                result="skipped", inject_tag=tag,
                reason="source SKILL.md missing")
            continue

        if link.exists() and not link.is_symlink():
            # Foreign directory with the same name — never touched.
            _emit_skill_event(
                agent_id=agent_id, provider="claude",
                skill_path=str(src), skill_name=name,
                injection_path=str(link), body_sha256="",
                result="skipped", inject_tag=tag,
                reason="name collision with hand-installed skill")
            continue

        try:
            if not link.is_symlink() or not _verify_symlink_target(link, src):
                _atomic_symlink(link, src)
            marker.touch()
            _atomic_write_text(tag_file, tag + "\n")
        except OSError as ex:
            _emit_skill_event(
                agent_id=agent_id, provider="claude",
                skill_path=str(src), skill_name=name,
                injection_path=str(link), body_sha256="",
                result="failed", inject_tag=tag,
                reason=str(ex))
            continue

        # Post-write verification: the symlink we just created should
        # still resolve to `src`. Catches a concurrent overwrite.
        if not _verify_symlink_target(link, src):
            _emit_skill_event(
                agent_id=agent_id, provider="claude",
                skill_path=str(src), skill_name=name,
                injection_path=str(link), body_sha256="",
                result="failed", inject_tag=tag,
                reason="post-write symlink target mismatch")
            continue

        enabled_names.add(name)
        _emit_skill_event(
            agent_id=agent_id, provider="claude",
            skill_path=str(src), skill_name=name,
            injection_path=str(link), body_sha256="",
            result="linked", inject_tag=tag)

    # Sweep: drop any marker that no longer matches an enabled entry.
    try:
        for entry in skills_dir.iterdir():
            if not entry.name.endswith(SKILLS_MANAGED_MARKER_SUFFIX):
                continue
            name = entry.name[:-len(SKILLS_MANAGED_MARKER_SUFFIX)]
            if name in enabled_names:
                continue
            link = skills_dir / name
            try:
                if link.is_symlink():
                    link.unlink()
                entry.unlink()
                (skills_dir / f"{name}.inject-tag").unlink(missing_ok=True)
            except OSError:
                pass
    except OSError:
        pass


def ensure_cursor_skill_rules(injected: list[dict], agent_id: str) -> None:
    """Reconcile ~/.cursor/rules/<basename>.mdc against the pref.

    Cursor reads every *.mdc file in ~/.cursor/rules/ on launch and
    treats each as a rule block prepended to the model's context.
    Same sidecar-marker pattern as Claude — never touches files that
    weren't planted by the dashboard.
    """
    rules_dir = HOME / ".cursor" / "rules"
    try:
        rules_dir.mkdir(parents=True, exist_ok=True)
    except OSError as ex:
        log_event("error", "skills",
                  "cannot create cursor rules dir",
                  agent_id=agent_id, error=str(ex))
        return

    enabled_files: set[str] = set()
    for entry in injected:
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        name = src.name
        target = rules_dir / f"{name}.mdc"
        marker = rules_dir / f"{name}.mdc{SKILLS_MANAGED_MARKER_SUFFIX}"
        tag = _short_hex()

        body = _skill_body(src)
        if not body:
            _emit_skill_event(
                agent_id=agent_id, provider="cursor",
                skill_path=str(src), skill_name=name,
                injection_path="", body_sha256="",
                result="skipped", inject_tag=tag,
                reason="source SKILL.md missing or empty")
            # Reap stale-but-owned file if any.
            if marker.exists():
                target.unlink(missing_ok=True)
                marker.unlink(missing_ok=True)
            continue

        if target.exists() and not marker.exists():
            _emit_skill_event(
                agent_id=agent_id, provider="cursor",
                skill_path=str(src), skill_name=name,
                injection_path=str(target), body_sha256="",
                result="skipped", inject_tag=tag,
                reason="name collision with user-authored .mdc")
            continue

        written = (
            f"# Skill: {name}\n"
            f"# Source: {src}\n"
            f"{_canary_comment(tag)}\n\n"
            f"{body}\n"
        )
        try:
            _atomic_write_text(target, written)
            marker.touch()
        except OSError as ex:
            _emit_skill_event(
                agent_id=agent_id, provider="cursor",
                skill_path=str(src), skill_name=name,
                injection_path=str(target), body_sha256="",
                result="failed", inject_tag=tag,
                reason=str(ex))
            continue

        body_hash = _sha256_12(written)
        if not _verify_file_hash(target, body_hash):
            _emit_skill_event(
                agent_id=agent_id, provider="cursor",
                skill_path=str(src), skill_name=name,
                injection_path=str(target), body_sha256=body_hash,
                result="failed", inject_tag=tag,
                reason="post-write hash mismatch")
            continue

        enabled_files.add(f"{name}.mdc")
        _emit_skill_event(
            agent_id=agent_id, provider="cursor",
            skill_path=str(src), skill_name=name,
            injection_path=str(target), body_sha256=body_hash,
            result="rule-written", inject_tag=tag)

    try:
        for entry in rules_dir.iterdir():
            if not entry.name.endswith(
                    f".mdc{SKILLS_MANAGED_MARKER_SUFFIX}"):
                continue
            base = entry.name[:-len(SKILLS_MANAGED_MARKER_SUFFIX)]
            if base in enabled_files:
                continue
            try:
                (rules_dir / base).unlink(missing_ok=True)
                entry.unlink()
            except OSError:
                pass
    except OSError:
        pass


def ensure_gemini_skill_block(injected: list[dict], agent_id: str) -> None:
    """Update the managed block in ~/.gemini/GEMINI.md.

    Anything outside the BEGIN/END block stays byte-for-byte intact.
    If the file doesn't exist we create it with just the block. If it
    exists but lacks the block we append.
    """
    target = GEMINI_CONFIG_PATH
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as ex:
        log_event("error", "skills",
                  "cannot create gemini config dir",
                  agent_id=agent_id, error=str(ex))
        return

    body_chunks: list[str] = []
    for entry in injected:
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        name = src.name
        tag = _short_hex()
        body = _skill_body(src)
        if not body:
            _emit_skill_event(
                agent_id=agent_id, provider="gemini",
                skill_path=str(src), skill_name=name,
                injection_path="", body_sha256="",
                result="skipped", inject_tag=tag,
                reason="source SKILL.md missing or empty")
            continue
        chunk = (
            f"## Skill: {name}\n"
            f"_Source: {src}_\n"
            f"{_canary_comment(tag)}\n\n"
            f"{body}"
        )
        body_chunks.append(chunk)
        _emit_skill_event(
            agent_id=agent_id, provider="gemini",
            skill_path=str(src), skill_name=name,
            injection_path=str(target),
            body_sha256=_sha256_12(chunk),
            result="managed-block-written", inject_tag=tag)

    managed = (
        f"{GEMINI_BLOCK_BEGIN}\n"
        + ("\n\n".join(body_chunks) + "\n" if body_chunks else "")
        + f"{GEMINI_BLOCK_END}\n"
    )

    try:
        existing = target.read_text(encoding="utf-8") if target.is_file() else ""
    except OSError:
        existing = ""

    if GEMINI_BLOCK_BEGIN in existing and GEMINI_BLOCK_END in existing:
        start = existing.index(GEMINI_BLOCK_BEGIN)
        end = existing.index(GEMINI_BLOCK_END) + len(GEMINI_BLOCK_END)
        # Eat trailing newline of the block if present, so we don't
        # accumulate blank lines on every reconcile.
        if end < len(existing) and existing[end] == "\n":
            end += 1
        new_text = existing[:start] + managed + existing[end:]
    elif existing:
        sep = "" if existing.endswith("\n") else "\n"
        new_text = existing + sep + "\n" + managed
    else:
        new_text = managed

    if new_text == existing:
        return
    try:
        _atomic_write_text(target, new_text)
    except OSError as ex:
        log_event("error", "skills",
                  "cannot rewrite gemini config",
                  agent_id=agent_id, error=str(ex))


def write_aider_skill_file(injected: list[dict],
                           agent_id: str) -> Path | None:
    """Concatenate every injected SKILL.md body into one tmpfile and
    return its path so the aider provider can splice `--read <path>`
    into its launch line. Returns None if there's nothing to write.
    """
    try:
        AIDER_SKILL_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as ex:
        log_event("error", "skills",
                  "cannot create aider skills cache dir",
                  agent_id=agent_id, error=str(ex))
        return None

    chunks: list[str] = []
    for entry in injected:
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        name = src.name
        tag = _short_hex()
        body = _skill_body(src)
        if not body:
            _emit_skill_event(
                agent_id=agent_id, provider="aider",
                skill_path=str(src), skill_name=name,
                injection_path="", body_sha256="",
                result="skipped", inject_tag=tag,
                reason="source SKILL.md missing or empty")
            continue
        chunk = (
            f"# Skill: {name}\n"
            f"# Source: {src}\n"
            f"{_canary_comment(tag)}\n\n"
            f"{body}"
        )
        chunks.append(chunk)

    safe_id = _safe_token(agent_id)
    target = AIDER_SKILL_DIR / f"aider-skills-{safe_id}.txt"

    if not chunks:
        # Reset any stale file so we don't keep --read'ing yesterday's
        # skills after the user has unselected them all.
        target.unlink(missing_ok=True)
        return None

    written = "\n\n".join(chunks) + "\n"
    try:
        _atomic_write_text(target, written)
    except OSError as ex:
        log_event("error", "skills",
                  "cannot write aider skills file",
                  agent_id=agent_id, error=str(ex))
        return None

    # One event per chunk, with the same target path.
    for entry, chunk in zip(injected, chunks):
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        name = src.name
        _emit_skill_event(
            agent_id=agent_id, provider="aider",
            skill_path=str(src), skill_name=name,
            injection_path=str(target),
            body_sha256=_sha256_12(chunk),
            result="read-file-attached",
            inject_tag=chunk.split("agent-workspace-inject: ", 1)[-1]
                        .split(" -->", 1)[0])
    return target


def _codex_sys_prompt_append(injected: list[dict], agent_id: str,
                              sys_prompt: str) -> str:
    """Append every injected skill's body to the Codex system prompt.

    Codex's launcher exports AGENT_SYS_PROMPT in the spawned shell —
    that's where the body has to land. Emits one audit event per
    skill.
    """
    chunks: list[str] = []
    for entry in injected:
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        name = src.name
        tag = _short_hex()
        body = _skill_body(src)
        if not body:
            _emit_skill_event(
                agent_id=agent_id, provider="codex",
                skill_path=str(src), skill_name=name,
                injection_path="", body_sha256="",
                result="skipped", inject_tag=tag,
                reason="source SKILL.md missing or empty")
            continue
        chunk = (
            f"--- Skill: {name} (from {src}) ---\n"
            f"{_canary_comment(tag)}\n"
            f"{body}\n---"
        )
        chunks.append(chunk)
        _emit_skill_event(
            agent_id=agent_id, provider="codex",
            skill_path=str(src), skill_name=name,
            injection_path="$AGENT_SYS_PROMPT",
            body_sha256=_sha256_12(chunk),
            result="sys-prompt-appended", inject_tag=tag)
    if not chunks:
        return sys_prompt
    return sys_prompt + "\n\n" + "\n\n".join(chunks)


def _emit_skipped_for_provider(injected: list[dict], agent_id: str,
                                provider: str, reason: str) -> None:
    for entry in injected:
        src = Path(str(entry.get("path", "")).strip()).expanduser()
        if not src.is_absolute():
            continue
        _emit_skill_event(
            agent_id=agent_id, provider=provider,
            skill_path=str(src), skill_name=src.name,
            injection_path="", body_sha256="",
            result="skipped", inject_tag=_short_hex(),
            reason=reason)


def inject_skills(provider_id: str,
                  injected: list[dict],
                  working_dir: Path,
                  agent_id: str,
                  sys_prompt: str) -> tuple[str, Path | None]:
    """Cross-provider dispatcher. Returns
    `(augmented_sys_prompt, aider_extra_path)`.

    Side-effects: reconciles provider-specific files (symlinks for
    Claude, .mdc for Cursor, managed block in GEMINI.md for Gemini,
    tmpfile for Aider, sys-prompt append for Codex). Emits one audit
    `log_event` per skill via the structured `skills` component log.
    Best-effort throughout — never raises out to the caller.

    `aider_extra_path` is the path the Aider provider should attach
    via `--read`, or None for every other provider / when no skills
    apply.
    """
    if not injected:
        return sys_prompt, None

    with _RECONCILE_LOCK:
        try:
            if provider_id == "claude":
                ensure_claude_code_skills(injected, agent_id=agent_id)
                return sys_prompt, None
            if provider_id == "cursor":
                ensure_cursor_skill_rules(injected, agent_id=agent_id)
                return sys_prompt, None
            if provider_id == "gemini":
                ensure_gemini_skill_block(injected, agent_id=agent_id)
                return sys_prompt, None
            if provider_id == "aider":
                tmp = write_aider_skill_file(injected, agent_id=agent_id)
                return sys_prompt, tmp
            if provider_id == "codex":
                return _codex_sys_prompt_append(
                    injected, agent_id=agent_id,
                    sys_prompt=sys_prompt), None
            if provider_id == "crush":
                _emit_skipped_for_provider(
                    injected, agent_id, "crush",
                    "crush has no system-prompt path")
                return sys_prompt, None
            # Unknown provider — skip everything but record the gap.
            _emit_skipped_for_provider(
                injected, agent_id, provider_id,
                f"unknown provider id {provider_id!r}")
            return sys_prompt, None
        except Exception as ex:  # noqa: BLE001
            log_event("error", "skills",
                      "skill injection raised",
                      agent_id=agent_id, provider=provider_id,
                      error=f"{type(ex).__name__}: {ex}")
            return sys_prompt, None
