"""Editor integration — allowlist + detection + `subprocess.Popen` launcher.

Pure stdlib, no other awlib deps. The dashboard's /api/editors and
/api/open-file route here.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

# Allowlist of editors the dashboard may launch on the user's behalf. The
# command name is what we look up via shutil.which() and what the client
# must send in /api/open-file. Argv is just `[binary, file]` — no shell, no
# user-provided extra arguments. Terminal editors (vim/nvim/emacs -nw) are
# omitted because the server doesn't have a TTY to attach them to.
EDITOR_REGISTRY: list[tuple[str, str]] = [
    # Cross-platform editors (work on Linux and macOS once the CLI
    # helper is installed: VS Code's "Shell Command: Install 'code' in
    # PATH" command, equivalent for Cursor / Sublime / Zed).
    ("VS Code",            "code"),
    ("VS Code Insiders",   "code-insiders"),
    ("Cursor",             "cursor"),
    ("Windsurf",           "windsurf"),
    ("Zed",                "zed"),
    ("IntelliJ IDEA",      "idea"),
    ("PyCharm",            "pycharm"),
    ("WebStorm",           "webstorm"),
    ("Sublime Text",       "subl"),
    # Linux-only
    ("Gedit",              "gedit"),
    ("Kate",               "kate"),
    ("GNOME Text Editor",  "gnome-text-editor"),
    ("Xed",                "xed"),
    # macOS-friendly editors with CLI binaries on PATH when installed.
    # Filtered out by detect_editors()'s shutil.which() check on
    # machines that don't have them.
    ("BBEdit",             "bbedit"),
    ("MacVim",             "mvim"),
    ("TextMate",           "mate"),
    ("Nova",               "nova"),
]
_EDITOR_IDS = {cmd for _, cmd in EDITOR_REGISTRY}


def detect_editors() -> list[dict]:
    """Editors in EDITOR_REGISTRY annotated with whether the binary is on PATH."""
    return [
        {"id": cmd, "label": label, "available": shutil.which(cmd) is not None}
        for label, cmd in EDITOR_REGISTRY
    ]


def open_file_in_editor(
    worktree: str, rel_path: str, editor: str, worktrees_root: Path,
) -> tuple[int, dict]:
    """Validate the request and spawn `<editor> <abs_path>` detached.

    Worktree must resolve under worktrees_root and `rel_path` must stay
    inside the worktree (no `..` traversal). Editor must be in the allowlist
    and the binary must exist on PATH.
    """
    if editor not in _EDITOR_IDS:
        return 400, {"error": f"editor not in allowlist: {editor!r}"}
    binary = shutil.which(editor)
    if not binary:
        return 400, {"error": f"editor binary not on PATH: {editor!r}"}

    # Rename rows from `git status --porcelain` are "old -> new" — open the
    # destination, which is what's actually on disk now.
    if " -> " in rel_path:
        rel_path = rel_path.split(" -> ", 1)[1]
    rel_path = rel_path.strip().strip('"')

    try:
        wt = Path(worktree).resolve(strict=True)
    except (OSError, RuntimeError) as ex:
        return 400, {"error": f"worktree not found: {ex}"}
    try:
        wt.relative_to(worktrees_root.resolve())
    except ValueError:
        return 403, {"error": "worktree is outside the configured worktrees root"}

    target = (wt / rel_path).resolve()
    try:
        target.relative_to(wt)
    except ValueError:
        return 403, {"error": "path escapes the worktree"}
    if not target.exists():
        return 404, {"error": f"file does not exist: {target}"}

    # Detach so the editor survives the request handler returning.
    # On POSIX that's `start_new_session=True`; on Windows it's
    # CREATE_NEW_PROCESS_GROUP via creationflags. start_new_session
    # is silently ignored on Windows so passing both is safe.
    detach_kwargs: dict = {}
    if sys.platform == "win32":
        detach_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        detach_kwargs["start_new_session"] = True

    # When opening a specific file (not the repo dir itself), pass the
    # repo dir first so the editor opens it as the workspace and then
    # navigates to the file within that context. Editors like VS Code /
    # Cursor / Windsurf / Zed accept `<editor> <dir> <file>` for this.
    argv = (
        [binary, str(target)]
        if target == wt
        else [binary, str(wt), str(target)]
    )
    try:
        subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **detach_kwargs,
        )
    except OSError as ex:
        return 500, {"error": f"failed to spawn editor: {ex}"}
    return 200, {"ok": True, "editor": editor, "file": str(target)}
