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


def extract_centerline() -> dict:
    """Sample dark track pixels and build ordered closed centerline."""
    im = Image.open(RAW / "track_loop.png").convert("RGB")
    # work at moderate res for speed
    max_w = 360
    scale = max_w / im.width
    small = im.resize((max_w, int(im.height * scale)), Image.Resampling.BILINEAR)
    a = np.asarray(small).astype(np.float32)
    # track = dark gray (low brightness, low green dominance vs grass)
    brightness = a.mean(axis=2)
    green = a[:, :, 1]
    # grass is bright green; track is dark
    track = (brightness < 90) & (green < 110)
    # also include slightly lighter curb-adjacent asphalt
    track |= (brightness < 120) & (green < 130) & (a[:, :, 0] < 140)

    ys, xs = np.where(track)
    if len(xs) < 100:
        raise RuntimeError("track mask too small")

    # distance transform style skeleton approx via local maxima of distance to grass
    # simpler: bin into cells and take centroid of track pixels per cell along a loop order
    # Use angular sort around track centroid after thinning via stride
    cy, cx = ys.mean(), xs.mean()

    # Collect sample points by walking with nearest-neighbor along mask
    mask = track
    # pick start: rightmost track pixel near vertical middle of right straight (finish area)
    right_candidates = np.where(mask[:, -40:])
    if len(right_candidates[0]):
        ry = right_candidates[0]
        rx = right_candidates[1] + (mask.shape[1] - 40)
        # prefer mid-right
        mid = mask.shape[0] / 2
        i = int(np.argmin(np.abs(ry - mid)))
        start = (int(rx[i]), int(ry[i]))
    else:
        start = (int(xs[np.argmax(xs)]), int(ys[np.argmax(xs)]))

    # greedy walk
    pts = [start]
    visited = np.zeros_like(mask, dtype=bool)
    x, y = start
    step = 6
    for _ in range(800):
        visited[
            max(0, y - step) : min(mask.shape[0], y + step + 1),
            max(0, x - step) : min(mask.shape[1], x + step + 1),
        ] = True
        # search ring ahead
        best = None
        best_score = -1e9
        for ang in np.linspace(0, 2 * np.pi, 36, endpoint=False):
            nx = int(round(x + step * np.cos(ang)))
            ny = int(round(y + step * np.sin(ang)))
            if not (0 <= nx < mask.shape[1] and 0 <= ny < mask.shape[0]):
                continue
            if not mask[ny, nx]:
                continue
            # prefer unvisited
            vpen = 80 if visited[ny, nx] else 0
            # prefer continuing direction
            if len(pts) >= 2:
                px, py = pts[-1][0] - pts[-2][0], pts[-1][1] - pts[-2][1]
                dx, dy = nx - x, ny - y
                dot = (px * dx + py * dy) / (np.hypot(px, py) * np.hypot(dx, dy) + 1e-6)
            else:
                dot = 0
            score = dot * 40 - vpen
            if score > best_score:
                best_score = score
                best = (nx, ny)
        if best is None:
            break
        # closed?
        if len(pts) > 40 and np.hypot(best[0] - start[0], best[1] - start[1]) < step * 1.5:
            pts.append(start)
            break
        pts.append(best)
        x, y = best

    # upsample to original image coords
    path = [[p[0] / scale, p[1] / scale] for p in pts]
    # smooth
    path = smooth_path(path, 2)

    meta = {
        "width": im.width,
        "height": im.height,
        "path": path,
        "startIndex": 0,
    }
    # find finish: checkered is black/white on right straight — use rightmost dense area mid
    meta["finishIndex"] = find_finish_index(path, im.width)
    (OUT / "track_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(f"centerline points: {len(path)} finishIndex={meta['finishIndex']}")
    return meta


def smooth_path(path, passes=2):
    pts = path[:]
    for _ in range(passes):
        nxt = [pts[0]]
        for i in range(1, len(pts) - 1):
            x = (pts[i - 1][0] + pts[i][0] * 2 + pts[i + 1][0]) / 4
            y = (pts[i - 1][1] + pts[i][1] * 2 + pts[i + 1][1]) / 4
            nxt.append([x, y])
        nxt.append(pts[-1])
        pts = nxt
    return pts


def find_finish_index(path, width):
    # finish line roughly mid-right straight: high x, medium y
    best_i, best = 0, -1e9
    for i, (x, y) in enumerate(path[:-1]):
        score = x - abs(y - path[len(path) // 2][1]) * 0.15
        if x > width * 0.7 and score > best:
            best, best_i = score, i
    return best_i


def pack_assets(meta: dict) -> None:
    # compress track
    track = Image.open(RAW / "track_loop.png").convert("RGB")
    tw = 720
    th = int(track.height * (tw / track.width))
    track = track.resize((tw, th), Image.Resampling.LANCZOS)
    # scale path to resized track
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
