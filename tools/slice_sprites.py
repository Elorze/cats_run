"""Slice sprite sheet into PNGs + atlas.json via connected components."""
from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / "图片"
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

SHEET = IMG / "6c9f8d8a4286ee119648e74baad8ef2d.jpg"
TRACK = IMG / "f1786b024da15a2661c0530b92a74bdf.jpg"
CONCEPT = IMG / "3b452d27a322bdc34529ac7207953762.jpg"


def main() -> None:
    im = Image.open(SHEET).convert("RGBA")
    arr = np.asarray(im)
    rgb = arr[:, :, :3]
    # near-white background
    bg = (rgb[:, :, 0] > 245) & (rgb[:, :, 1] > 245) & (rgb[:, :, 2] > 245)
    mask = ~bg

    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    boxes: list[tuple[int, int, int, int, int]] = []

    ys, xs = np.where(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if visited[y, x]:
            continue
        # BFS
        stack = [(x, y)]
        visited[y, x] = True
        min_x = max_x = x
        min_y = max_y = y
        count = 0
        while stack:
            cx, cy = stack.pop()
            count += 1
            if cx < min_x:
                min_x = cx
            if cx > max_x:
                max_x = cx
            if cy < min_y:
                min_y = cy
            if cy > max_y:
                max_y = cy
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((nx, ny))
        bw, bh = max_x - min_x + 1, max_y - min_y + 1
        if count >= 600 and bw > 18 and bh > 18:
            boxes.append((min_x, min_y, bw, bh, count))

    # merge overlaps
    def overlap(a, b, pad=14):
        ax, ay, aw, ah, _ = a
        bx, by, bw, bh, _ = b
        return not (ax + aw + pad < bx or bx + bw + pad < ax or ay + ah + pad < by or by + bh + pad < ay)

    boxes = sorted(boxes, key=lambda b: b[4], reverse=True)
    merged: list[tuple[int, int, int, int, int]] = []
    for b in boxes:
        hit = False
        for i, m in enumerate(merged):
            if overlap(m, b):
                mx = min(m[0], b[0])
                my = min(m[1], b[1])
                mx2 = max(m[0] + m[2], b[0] + b[2])
                my2 = max(m[1] + m[3], b[1] + b[3])
                merged[i] = (mx, my, mx2 - mx, my2 - my, m[4] + b[4])
                hit = True
                break
        if not hit:
            merged.append(b)

    # sort reading order
    merged.sort(key=lambda b: (b[1] // 40, b[0]))

    # Heuristic names by row/col position (will refine after inspect)
    names_guess = [
        "cat_run",
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
        "text_lap",
        "text_score",
        "digits",
        "bubble_meow",
        "bubble_close",
        "paw_prints",
        "speed_lines",
        "burst",
    ]

    atlas = {}
    pad = 3
    for i, (x, y, bw, bh, area) in enumerate(merged):
        sx = max(0, x - pad)
        sy = max(0, y - pad)
        sw = min(w - sx, bw + pad * 2)
        sh = min(h - sy, bh + pad * 2)
        name = names_guess[i] if i < len(names_guess) else f"sprite_{i:02d}"
        crop = im.crop((sx, sy, sx + sw, sy + sh))
        # make pure white nearly transparent for nicer draw
        c = crop.convert("RGBA")
        ca = np.asarray(c).copy()
        white = (ca[:, :, 0] > 248) & (ca[:, :, 1] > 248) & (ca[:, :, 2] > 248)
        ca[white, 3] = 0
        Image.fromarray(ca).save(OUT / f"{name}.png")
        atlas[name] = {"x": sx, "y": sy, "w": sw, "h": sh, "area": area}
        print(f"{i:02d} {name}: {sx},{sy} {sw}x{sh} area={area}")

    (OUT / "atlas.json").write_text(json.dumps(atlas, indent=2), encoding="utf-8")

    # preview montage of crops
    Image.open(TRACK).save(OUT / "track.jpg", quality=90)
    Image.open(CONCEPT).save(OUT / "concept.jpg", quality=90)
    im.convert("RGB").save(OUT / "sheet.jpg", quality=90)
    print(f"Done: {len(merged)} sprites -> {OUT}")


if __name__ == "__main__":
    main()
