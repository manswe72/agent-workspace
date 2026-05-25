#!/usr/bin/env python3
"""
Render an image inline in a agent-workspace agent terminal.

The script POSTs to the dashboard's /api/terminal-image endpoint; the
dashboard's 1-second poll loop picks it up and writes the IIP escape
sequence directly to xterm.js.

Usage:
  python3 iip.py [issue] [image_or_preset]

  issue             – issue key or '__agent__' (default: '__agent__')
  image_or_preset   – path to an image file, or one of:
                        mandelbrot   (default)
                        plasma

Examples:
  python3 iip.py mandelbrot
  python3 iip.py __agent__ mandelbrot
  python3 iip.py BSS-10029 /tmp/chart.png
"""
import base64
import io
import json
import math
import os
import struct
import sys
import zlib
from urllib import error as _err
from urllib import request as _req

DASHBOARD_URL = os.environ.get("AGENT_WORKSPACE_URL", "http://localhost:8765")


def post_image(issue: str, png_bytes: bytes) -> None:
    data = base64.b64encode(png_bytes).decode()
    payload = json.dumps({"issue": issue, "data": data}).encode()
    req = _req.Request(
        f"{DASHBOARD_URL}/api/terminal-image",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with _req.urlopen(req, timeout=5) as resp:
            json.loads(resp.read())
            print(f"[iip] queued for {issue}: {len(png_bytes)} bytes — image appears in ~1s")
    except _err.URLError as e:
        print(f"[iip] ERROR: could not reach dashboard at {DASHBOARD_URL}: {e}", file=sys.stderr)
        sys.exit(1)


def make_png(width, height, pixel_fn):
    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xffffffff
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)
    raw = b""
    for y in range(height):
        raw += b"\x00"
        for x in range(width):
            r, g, b = pixel_fn(x, y, width, height)
            raw += bytes([r & 0xFF, g & 0xFF, b & 0xFF])
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6))
            + chunk(b"IEND", b""))


def mandelbrot():
    W, H = 800, 400
    MAX = 120
    def pixel(x, y, w, h):
        cx = -2.5 + x / w * 3.5
        cy = -1.2 + y / h * 2.4
        zr = zi = 0.0
        for i in range(MAX):
            zr2, zi2 = zr*zr, zi*zi
            if zr2 + zi2 > 4:
                t = i / MAX
                return (
                    int(9*(1-t)*t*t*t*255),
                    int(15*(1-t)*(1-t)*t*t*255),
                    int(8.5*(1-t)*(1-t)*(1-t)*t*255),
                )
            zi = 2*zr*zi + cy
            zr = zr2 - zi2 + cx
        return 0, 0, 0
    return make_png(W, H, pixel)


def plasma():
    W, H = 400, 120
    def pixel(x, y, w, h):
        v  = math.sin(x / 18.0)
        v += math.sin(y / 12.0)
        v += math.sin((x + y) / 22.0)
        v += math.sin(math.sqrt(x*x + y*y) / 14.0)
        v = (v + 4) / 8
        r = int(math.sin(math.pi * v)          * 255)
        g = int(math.sin(math.pi * v + 2.094)  * 255)
        b = int(math.sin(math.pi * v + 4.189)  * 255)
        return max(0, r), max(0, g), max(0, b)
    return make_png(W, H, pixel)


def from_file(path):
    try:
        from PIL import Image
        img = Image.open(path).convert("RGB")
        img.thumbnail((600, 400))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()
    except ImportError:
        with open(path, "rb") as f:
            return f.read()


PRESETS = {"mandelbrot": mandelbrot, "plasma": plasma}

if __name__ == "__main__":
    args = sys.argv[1:]
    issue = "__agent__"
    target = "mandelbrot"

    if len(args) == 0:
        pass
    elif len(args) == 1:
        # Could be an issue key or a preset/file
        if args[0] in PRESETS or os.path.exists(args[0]):
            target = args[0]
        else:
            issue = args[0]
    else:
        issue, target = args[0], args[1]

    if target in PRESETS:
        print(f"[iip] generating {target}…")
        png = PRESETS[target]()
    else:
        png = from_file(target)

    post_image(issue, png)
