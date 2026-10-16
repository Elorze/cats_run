"""Compress final assets for smaller single-HTML delivery."""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FINAL = ROOT / "assets" / "final"
OUT = ROOT / "assets" / "embed"
OUT.mkdir(parents=True, exist_ok=True)

# Only runtime-needed keys
KEEP = [
    "cat_normal",
    "cat_dizzy",
    "cat_happy",
    "cucumber",
    "vacuum",
    "yarn_pink",
    "yarn_blue",
    "fish_coin",
    "tuna",
    "fish_dry",
    "paw_l",
    "paw_r",
    "meow",
    "close_call",
    "ui_lap",
    "ui_score",
    "ui_digits",
    "fx_burst",
    "fx_paws",
    "fx_lines",
    "track",
    "concept",
]


def png_bytes(im: Image.Image, max_w: int) -> bytes:
    im = im.convert("RGBA")
    if im.width > max_w:
        h = max(1, int(im.height * (max_w / im.width)))
        im = im.resize((max_w, h), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def jpg_bytes(im: Image.Image, max_w: int, quality: int) -> bytes:
    im = im.convert("RGB")
    if im.width > max_w:
        h = int(im.height * (max_w / im.width))
        im = im.resize((max_w, h), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def main() -> None:
    pack = {}
    total = 0
    for key in KEEP:
        png = FINAL / f"{key}.png"
        jpg = FINAL / f"{key}.jpg"
        if png.exists():
            im = Image.open(png)
            max_w = 220 if key.startswith(("cat_", "vacuum", "yarn", "paw_", "cucumber", "tuna")) else 280
            if key.startswith("ui_") or key in {"meow", "close_call", "fx_burst", "fx_paws", "fx_lines", "fish_coin", "fish_dry"}:
                max_w = 260
            data = png_bytes(im, max_w)
            # rewrite optimized
            (OUT / f"{key}.png").write_bytes(data)
            uri = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        elif jpg.exists():
            im = Image.open(jpg)
            if key == "track":
                data = jpg_bytes(im, 420, 72)
            else:
                data = jpg_bytes(im, 540, 70)
            (OUT / f"{key}.jpg").write_bytes(data)
            uri = "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")
        else:
            print("missing", key)
            continue
        pack[key] = uri
        kb = len(uri) // 1024
        total += kb
        print(f"{key}: {kb} KB")

    (OUT / "pack.json").write_text(json.dumps(pack), encoding="utf-8")
    (OUT / "assets.js").write_text("window.ASSETS=" + json.dumps(pack) + ";\n", encoding="utf-8")
    print(f"TOTAL ~{total} KB base64")


if __name__ == "__main__":
    main()
