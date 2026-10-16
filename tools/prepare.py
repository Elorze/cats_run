"""Slice sprites + extract closed-loop centerline from track art."""
from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "assets" / "raw"
OUT = ROOT / "assets" / "game"
OUT.mkdir(parents=True, exist_ok=True)


def whiten(im: Image.Image, thr: int = 250) -> Image.Image:
    a = np.asarray(im.convert("RGBA")).copy()
    m = (a[:, :, 0] > thr) & (a[:, :, 1] > thr) & (a[:, :, 2] > thr)
    a[m, 3] = 0
    return Image.fromarray(a)


def slice_sprites() -> dict:
    sheet = Image.open(RAW / "sprites.png").convert("RGBA")
    arr = np.asarray(sheet)
    rgb = arr[:, :, :3]
    bg = (rgb[:, :, 0] > 248) & (rgb[:, :, 1] > 248) & (rgb[:, :, 2] > 248)
    mask = ~bg
    h, w = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    boxes = []
    ys, xs = np.where(mask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if visited[y, x]:
            continue
        stack = [(x, y)]
        visited[y, x] = True
        minx = maxx = x
        miny = maxy = y
        count = 0
        while stack:
            cx, cy = stack.pop()
            count += 1
            minx = min(minx, cx)
            maxx = max(maxx, cx)
            miny = min(miny, cy)
            maxy = max(maxy, cy)
            for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                if 0 <= nx < w and 0 <= ny < h and mask[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True
                    stack.append((nx, ny))
        bw, bh = maxx - minx + 1, maxy - miny + 1
        if count >= 400 and bw > 15 and bh > 15:
            boxes.append((minx, miny, bw, bh, count))

    # merge overlaps
    def ov(a, b, pad=10):
        return not (
            a[0] + a[2] + pad < b[0]
            or b[0] + b[2] + pad < a[0]
            or a[1] + a[3] + pad < b[1]
            or b[1] + b[3] + pad < a[1]
        )

    boxes.sort(key=lambda b: b[4], reverse=True)
    merged = []
    for b in boxes:
        hit = False
        for i, m in enumerate(merged):
            if ov(m, b):
                x0 = min(m[0], b[0])
                y0 = min(m[1], b[1])
                x1 = max(m[0] + m[2], b[0] + b[2])
                y1 = max(m[1] + m[3], b[1] + b[3])
                merged[i] = (x0, y0, x1 - x0, y1 - y0, m[4] + b[4])
                hit = True
                break
        if not hit:
            merged.append(b)
    merged.sort(key=lambda b: (b[1] // 30, b[0]))

    names = [
        "cat",
        "paw_l",
        "paw_r",
        "finish",
        "curb",
        "skull",
        "tires",
        "bush",
        "yarn",
        "trophy",
        "star",
    ]
    atlas = {}
    for i, (x, y, bw, bh, area) in enumerate(merged):
        pad = 2
        sx, sy = max(0, x - pad), max(0, y - pad)
        sw = min(w - sx, bw + pad * 2)
        sh = min(h - sy, bh + pad * 2)
        name = names[i] if i < len(names) else f"s{i:02d}"
        crop = whiten(sheet.crop((sx, sy, sx + sw, sy + sh)))
        crop.save(OUT / f"{name}.png")
        atlas[name] = {"x": sx, "y": sy, "w": sw, "h": sh, "area": int(area)}
        print(f"{i:02d} {name}: {sw}x{sh} @ {sx},{sy}")
    return atlas


def catmull_rom_chain(pts, n_per_seg=16):
    pts = list(pts)
    pts = [pts[-2], pts[-1]] + pts + [pts[0], pts[1]]
    out = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]
        for j in range(n_per_seg):
            t = j / n_per_seg
            t2 = t * t
            t3 = t2 * t
            x = 0.5 * (
                (2 * p1[0])
                + (-p0[0] + p2[0]) * t
                + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
            )
            y = 0.5 * (
                (2 * p1[1])
                + (-p0[1] + p2[1]) * t
                + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
            )
            out.append([x, y])
    out.append(out[0][:])
    return out


def resample_path(path, spacing=14.0):
    pts = [list(p) for p in path]
    out = [pts[0][:]]
    carry = 0.0
    for i in range(1, len(pts)):
        x0, y0 = pts[i - 1]
        x1, y1 = pts[i]
        sdx, sdy = x1 - x0, y1 - y0
        seg = float(np.hypot(sdx, sdy))
        if seg < 1e-6:
            continue
        pos = 0.0
        while carry + (seg - pos) >= spacing:
            need = spacing - carry
            t = (pos + need) / seg
            out.append([x0 + sdx * t, y0 + sdy * t])
            pos += need
            carry = 0.0
        carry += seg - pos
    out.append(out[0][:])
    return out


def extract_centerline() -> dict:
    """Author a clean closed centerline (game coords) for the loop track.

    Auto-tracing the raster art produced knots near the checkered finish and made
    curb/finish rendering look chaotic. A stable authored path matches the
    silhouette and keeps finish detection reliable.
    """
    im = Image.open(RAW / "track_loop.png").convert("RGB")
    tw = 720
    th = int(im.height * (tw / im.width))

    # Key points in game coordinates — finish on the right straight, then up and around.
    waypoints = [
        [610, 580],
        [612, 520],
        [610, 450],
        [600, 380],
        [575, 320],
        [530, 270],
        [460, 245],
        [380, 250],
        [310, 280],
        [260, 340],
        [250, 420],
        [270, 490],
        [330, 540],
        [390, 580],
        [420, 640],
        [390, 700],
        [330, 750],
        [270, 810],
        [250, 890],
        [290, 960],
        [370, 1010],
        [460, 1030],
        [540, 1000],
        [590, 940],
        [610, 860],
        [615, 780],
        [615, 700],
        [612, 640],
        [610, 600],
    ]
    path = resample_path(catmull_rom_chain(waypoints, 16), 14)

    # Rotate so finish (~610,580) is index 0 and direction goes up (decreasing y).
    tx, ty = 610.0, 580.0
    bi = int(np.argmin([(p[0] - tx) ** 2 + (p[1] - ty) ** 2 for p in path[:-1]]))
    path = path[bi:-1] + path[:bi] + [path[bi][:]]
    if path[4][1] > path[0][1]:
        path = path[::-1]
    path[-1] = path[0][:]

    meta = {
        "width": tw,
        "height": th,
        "path": path,
        "finishIndex": 0,
        "startIndex": 5,
    }
    (OUT / "track_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"centerline points: {len(path)} finishIndex=0 startIndex=5")
    return meta


def pack_assets(meta: dict) -> None:
    # compress track
    track = Image.open(RAW / "track_loop.png").convert("RGB")
    tw = 720
    th = int(track.height * (tw / track.width))
    track = track.resize((tw, th), Image.Resampling.LANCZOS)
    # Path may already be authored in game coords (720 x th).
    sx = tw / meta["width"]
    sy = th / meta["height"]
    path = [[x * sx, y * sy] for x, y in meta["path"]]
    meta2 = {
        "width": tw,
        "height": th,
        "path": path,
        "finishIndex": meta["finishIndex"],
        "startIndex": meta["startIndex"],
    }
    track_path = OUT / "track.jpg"
    track.save(track_path, quality=82, optimize=True)

    pack = {}
    for p in OUT.glob("*.png"):
        data = p.read_bytes()
        pack[p.stem] = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
    pack["track"] = "data:image/jpeg;base64," + base64.b64encode(track_path.read_bytes()).decode("ascii")
    pack["_meta"] = meta2  # will strip when writing JS

    js_obj = {k: v for k, v in pack.items() if k != "_meta"}
    (OUT / "assets.js").write_text(
        "window.ASSETS=" + json.dumps(js_obj) + ";\nwindow.TRACK_META=" + json.dumps(meta2) + ";\n",
        encoding="utf-8",
    )
    total = sum(len(v) for v in js_obj.values()) // 1024
    print(f"packed ~{total} KB base64, track {tw}x{th}, path={len(path)}")


def main():
    slice_sprites()
    meta = extract_centerline()
    pack_assets(meta)


if __name__ == "__main__":
    main()
