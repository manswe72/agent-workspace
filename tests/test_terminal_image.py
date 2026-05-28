"""Regression tests for the /api/terminal-image `file=` path-injection
hardening (CodeQL py/path-injection, alert #16).

The endpoint reads a file under $HOME, base64-encodes it, and queues
it for display in an agent terminal. The old guard only checked that
the path stayed *inside* HOME, so any caller could exfiltrate any
file under HOME — SSH keys, the dashboard's own GitHub PAT, etc.
`_read_terminal_image_file` adds a loopback-bind gate and an
image-magic-byte content check; these tests pin both.
"""
from __future__ import annotations

import base64

import agent_workspace as cw

# Minimal valid headers for the formats the content gate accepts.
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24
_GIF = b"GIF89a" + b"\x00" * 24
_WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 24


def test_sniff_image_format_recognises_real_images():
    assert cw._sniff_image_format(_PNG) == "png"
    assert cw._sniff_image_format(_JPEG) == "jpeg"
    assert cw._sniff_image_format(_GIF) == "gif"
    assert cw._sniff_image_format(_WEBP) == "webp"


def test_sniff_image_format_rejects_text_secret():
    # A github token / SSH key carries no image magic number.
    assert cw._sniff_image_format(b"ghp_deadbeefcafef00d") is None
    assert cw._sniff_image_format(b"-----BEGIN OPENSSH PRIVATE KEY-----") is None


def test_bind_is_loopback():
    assert cw._bind_is_loopback("127.0.0.1")
    assert cw._bind_is_loopback("127.0.0.5")
    assert cw._bind_is_loopback("::1")
    assert cw._bind_is_loopback("localhost")
    assert not cw._bind_is_loopback("0.0.0.0")
    assert not cw._bind_is_loopback("192.168.1.10")
    assert not cw._bind_is_loopback("::")


def test_token_file_under_home_is_rejected(tmp_path):
    # Simulate ~/.config/agent-workspace/github-token under a fake HOME.
    token = tmp_path / ".config" / "agent-workspace" / "github-token"
    token.parent.mkdir(parents=True)
    token.write_text("ghp_supersecrettokenvalue\n")

    data, err = cw._read_terminal_image_file(
        str(token), bind_host="127.0.0.1", home_root=tmp_path)
    assert data is None
    assert err is not None
    status, msg = err
    assert status == 400
    assert "recognised image" in msg


def test_real_image_under_home_is_accepted(tmp_path):
    img = tmp_path / "Pictures" / "shot.png"
    img.parent.mkdir(parents=True)
    img.write_bytes(_PNG)

    data, err = cw._read_terminal_image_file(
        str(img), bind_host="127.0.0.1", home_root=tmp_path)
    assert err is None
    assert base64.b64decode(data) == _PNG


def test_path_outside_home_is_rejected(tmp_path):
    outside = tmp_path.parent / "etc-passwd"
    outside.write_bytes(_PNG)
    home = tmp_path / "home"
    home.mkdir()

    data, err = cw._read_terminal_image_file(
        str(outside), bind_host="127.0.0.1", home_root=home)
    assert data is None
    assert err[0] == 400
    assert "inside $HOME" in err[1]


def test_non_loopback_bind_refuses_file_reads(tmp_path):
    # Even a legitimate image is refused when bound to 0.0.0.0 — the
    # browser must send data= instead. Closes the Docker exposure.
    img = tmp_path / "shot.png"
    img.write_bytes(_PNG)

    data, err = cw._read_terminal_image_file(
        str(img), bind_host="0.0.0.0", home_root=tmp_path)
    assert data is None
    assert err[0] == 403
    assert "loopback" in err[1]


def test_directory_is_rejected(tmp_path):
    d = tmp_path / "adir"
    d.mkdir()
    data, err = cw._read_terminal_image_file(
        str(d), bind_host="127.0.0.1", home_root=tmp_path)
    assert data is None
    assert err[0] == 400
    assert "regular file" in err[1]
