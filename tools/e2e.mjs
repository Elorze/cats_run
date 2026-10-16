/**
 * Smoke E2E for MeowDrift.html using local Playwright browsers (no download).
 * PLAYWRIGHT_BROWSERS_PATH=D:\\ms-playwright
 */
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const html = path.join(root, "MeowDrift.html");
const outDir = path.join(root, "tools", "e2e-out");
fs.mkdirSync(outDir, { recursive: true });

const fileUrl = "file:///" + html.replace(/\\/g, "/");

async function main() {
  if (!fs.existsSync(html)) throw new Error("Missing MeowDrift.html — run build_html.py first");

  // Prefer system Chrome to avoid browser revision downloads
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--allow-file-access-from-files", "--disable-web-security"],
  });
  const page = await browser.newPage({
    viewport: { width: 390, height: 694 },
    deviceScaleFactor: 2,
  });

  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console: " + msg.text());
  });

  await page.goto(fileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);

  // assets loaded?
  const assetCount = await page.evaluate(() => Object.keys(window.ASSETS || {}).length);
  console.log("ASSETS keys:", assetCount);
  if (assetCount < 10) throw new Error("ASSETS not embedded");

  await page.screenshot({ path: path.join(outDir, "01-title.png") });

  // start game
  await page.mouse.click(195, 400);
  await page.waitForTimeout(400);

  const mode = await page.evaluate(() => {
    // poke private via canvas existence + running animation
    return document.getElementById("game") ? "ok" : "missing";
  });
  console.log("canvas:", mode);

  // hold left then right
  await page.mouse.move(80, 620);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.mouse.move(310, 620);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();

  // keyboard
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(300);
  await page.keyboard.up("ArrowRight");

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "02-playing.png") });

  // run longer to spawn entities
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(outDir, "03-later.png") });

  if (errors.length) {
    console.error("ERRORS:", errors);
    throw new Error("Page errors: " + errors.join(" | "));
  }

  console.log("E2E OK");
  console.log("Screenshots in", outDir);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
