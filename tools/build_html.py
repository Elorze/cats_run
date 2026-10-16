from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
shell = (ROOT / "src" / "shell.html").read_text(encoding="utf-8")
game = (ROOT / "src" / "game.js").read_text(encoding="utf-8")
assets = (ROOT / "assets" / "game" / "assets.js").read_text(encoding="utf-8")
out = shell.replace("<!--ASSETS-->", f"<script>\n{assets}\n</script>").replace("/*GAME*/", game)
dest = ROOT / "index.html"
dest.write_text(out, encoding="utf-8")
print(f"Wrote {dest} ({dest.stat().st_size/1024:.1f} KB)")
