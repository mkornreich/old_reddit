// Pinch zoom (3×): the extension's horizontal scrollbar for the magnified view — none at 100%;
// shown along the bottom of the view with a thumb as wide as the share of the page in view;
// dragging the thumb pans the view; clicking the track pages back.
//   node pinch-bar.mjs <ext-dir> [url] [screenshot.png]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, url = "https://www.reddit.com/r/sysadmin/", out] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 914, height: 700 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing, .commentarea", { timeout: 30000 }); await page.waitForTimeout(2500);
const noBarAt1 = await page.evaluate(() => { const b = document.getElementById("orr-pinchbar"); return !b || getComputedStyle(b).display === "none"; });
const cdp = await ctx.newCDPSession(page);
await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 3 }); await page.waitForTimeout(800);
const st = () => page.evaluate(() => {
  const vv = visualViewport, b = document.getElementById("orr-pinchbar"), t = b && b.firstElementChild;
  const r = t ? t.getBoundingClientRect() : null, br = b ? b.getBoundingClientRect() : null;
  return { x: Math.round(vv.pageLeft), shown: !!b && getComputedStyle(b).display !== "none",
    // thumb centre and bar in on-screen pixels (visual viewport × zoom)
    thumb: r && { cx: (r.left - vv.offsetLeft + r.width / 2) * vv.scale, cy: (r.top - vv.offsetTop + r.height / 2) * vv.scale, w: r.width * vv.scale },
    bar: br && { left: (br.left - vv.offsetLeft) * vv.scale, bottom: (br.bottom - vv.offsetTop) * vv.scale, w: br.width * vv.scale, h: br.height * vv.scale } };
});
const a = await st();
// drag the thumb 200 screen px right (Playwright's mouse at page zoom: coordinates in zoomed-view CSS px)
const s = 3;
await page.mouse.move(a.thumb.cx / s, a.thumb.cy / s); await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move((a.thumb.cx + 20 * i) / s, a.thumb.cy / s); await page.waitForTimeout(30); }
await page.mouse.up(); await page.waitForTimeout(300);
const b = await st();
// click the track left of the thumb → a page back
await page.mouse.click((b.thumb.cx - b.thumb.w) / s - 2, b.thumb.cy / s); await page.waitForTimeout(300);
const c = await st();
if (out) await page.screenshot({ path: out });
console.log(JSON.stringify({ noBarAt1, zoomed: { x: a.x, shown: a.shown, bar: a.bar, thumbW: Math.round(a.thumb.w) }, afterDrag: b.x, afterTrackClick: c.x }));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
check("no bar at 100%", noBarAt1);
check("bar along the bottom of the zoomed view", a.shown && Math.abs(a.bar.h - 14) < 1 && a.bar.w > 800 && a.bar.bottom > 690, JSON.stringify(a.bar));
check("thumb = share of the page in view (1/3)", Math.abs(a.thumb.w - a.bar.w / 3) < 3, String(Math.round(a.thumb.w)));
check("dragging the thumb 200px pans the view", b.x >= 190 && b.x <= 210, a.x + " → " + b.x);
check("clicking the track pages back", c.x < b.x, b.x + " → " + c.x);
console.log(fail ? fail + " FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
