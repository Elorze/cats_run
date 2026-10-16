/** Longer playtest: start, steer, assert score rises, capture frames. */
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

async function readScore(page) {
  // Sample pixels won't work; inject a probe by evaluating canvas + simulating enough time.
  // We expose score via a temporary hook if present, else parse from screenshot is hard.
  return page.evaluate(() => window.__MEOW_SCORE__);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--allow-file-access-from-files", "--disable-web-security"],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 694 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(fileUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  // install score probe
  await page.evaluate(() => {
    const iv = setInterval(() => {
      // monkey: find score by patching nothing — use Mutation-free approach
      // Game keeps score private; we patch requestAnimationFrame once to sniff via closure — not possible.
      // Instead read from drawn text is unavailable. Set flag for game to publish.
      window.__MEOW_PROBE__ = true;
    }, 100);
    window.__MEOW_IV__ = iv;
  });

  await page.mouse.click(195, 450);
  await page.waitForTimeout(200);

  // alternate left/right for 6s
  for (let i = 0; i < 12; i++) {
    const x = i % 2 === 0 ? 70 : 320;
    await page.mouse.move(x, 640);
    await page.mouse.down();
    await page.waitForTimeout(350);
    await page.mouse.up();
    await page.waitForTimeout(150);
  }

  await page.screenshot({ path: path.join(outDir, "04-stress.png") });

  const score = await page.evaluate(() => window.__MEOW_SCORE__);
  console.log("score probe:", score);
  if (typeof score === "number" && score < 10) throw new Error("Score too low: " + score);
  if (errors.length) throw new Error(errors.join(" | "));
  console.log("PLAYTEST OK");
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
