"""Rename/crop final game sprites and emit base64 pack for HTML embed."""
from __future__ import annotations

import base64
import json
import shutil
from pathlib import Path

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "assets"
FINAL = ROOT / "assets" / "final"
FINAL.mkdir(parents=True, exist_ok=True)


def whiten_alpha(im: Image.Image, thr: int = 248) -> Image.Image:
    im = im.convert("RGBA")
    a = np.asarray(im).copy()
    white = (a[:, :, 0] > thr) & (a[:, :, 1] > thr) & (a[:, :, 2] > thr)
    a[white, 3] = 0
    return Image.fromarray(a)


def save(name: str, im: Image.Image) -> None:
    im = whiten_alpha(im)
    im.save(FINAL / f"{name}.png")
    print(f"saved {name} {im.size}")


def main() -> None:
    # Clear final
    for p in FINAL.glob("*"):
        p.unlink()

    mapping = {
        "cat_normal": "cat_dizzy.png",  # calm running
        "cat_dizzy": "cat_happy.png",  # spiral eyes
        "cat_happy": "cat_run.png",  # star eyes
        "cucumber": "cucumber.png",
        "vacuum": "vacuum.png",
        "yarn_pink": "yarn_pink.png",
        "yarn_blue": "yarn_blue.png",
        "fish_coin": "paw_r.png",
        "tuna": "text_lap.png",
        "fish_dry": "digits.png",
        "ui_banners": "speed_lines.png",
        "bubbles": "burst.png",
        "paw_l": "sprite_20.png",
    }
    for name, src in mapping.items():
        save(name, Image.open(RAW / src))

    # Crop R button from dual paw sheet
    dual = Image.open(RAW / "sprite_21.png").convert("RGBA")
    w, h = dual.size
    # right half roughly
    save("paw_r", dual.crop((w // 2, 0, w, int(h * 0.78))))

    # Crop MEOW / CLOSE CALL from bubbles sheet
    bub = Image.open(RAW / "burst.png").convert("RGBA")
    bw, bh = bub.size
    save("meow", bub.crop((0, 0, int(bw * 0.55), int(bh * 0.48))))
    save("close_call", bub.crop((int(bw * 0.35), int(bh * 0.35), bw, bh)))

    # Crop LAP banner / SCORE / digits from UI sheet
    ui = Image.open(RAW / "speed_lines.png").convert("RGBA")
    uw, uh = ui.size
    save("ui_lap", ui.crop((0, 0, uw, int(uh * 0.28))))
    save("ui_score", ui.crop((0, int(uh * 0.28), int(uw * 0.55), int(uh * 0.52))))
    save("ui_digits", ui.crop((0, int(uh * 0.52), uw, int(uh * 0.82))))

    # Effects from remaining sprites if useful
    for name, src in [
        ("fx_burst", "sprite_22.png"),
        ("fx_paws", "sprite_24.png"),
        ("fx_lines", "sprite_27.png"),
    ]:
        if (RAW / src).exists():
            save(name, Image.open(RAW / src))

    # Track + concept + sheet copies
    shutil.copy2(RAW / "track.jpg", FINAL / "track.jpg")
    shutil.copy2(RAW / "concept.jpg", FINAL / "concept.jpg")
    shutil.copy2(RAW / "sheet.jpg", FINAL / "sheet.jpg")

    # Build base64 pack (exclude huge concept from runtime if needed; include for splash)
    pack = {}
    for p in sorted(FINAL.iterdir()):
        if p.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        if p.name in {"sheet.jpg"}:
            continue  # keep sheet only for ref; embed concept+track+sprites
        mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        b64 = base64.b64encode(p.read_bytes()).decode("ascii")
        pack[p.stem] = f"data:{mime};base64,{b64}"
        print(f"pack {p.name}: {len(b64)//1024} KB b64")

    (FINAL / "pack.json").write_text(json.dumps(pack), encoding="utf-8")
    # also a js module for easy concat
    js = "window.ASSETS = " + json.dumps(pack) + ";\n"
    (FINAL / "assets.js").write_text(js, encoding="utf-8")
    print("Done ->", FINAL)


if __name__ == "__main__":
    main()
