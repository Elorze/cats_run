"""Bake assets.js + game.js into a single self-contained HTML."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHELL = (ROOT / "src" / "shell.html").read_text(encoding="utf-8")
GAME = (ROOT / "src" / "game.js").read_text(encoding="utf-8")
ASSETS = (ROOT / "assets" / "embed" / "assets.js").read_text(encoding="utf-8")

out = SHELL.replace("<!--ASSETS-->", f"<script>\n{ASSETS}\n</script>")
out = out.replace("/*GAME*/", GAME)

dest = ROOT / "MeowDrift.html"
dest.write_text(out, encoding="utf-8")
kb = dest.stat().st_size / 1024
print(f"Wrote {dest} ({kb:.1f} KB)")
