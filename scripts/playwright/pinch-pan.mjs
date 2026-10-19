// Pinch zoom (4×): sideways scrolls and Shift + scroll pan the magnified view by exactly one
// step each — A) with real wheel input, where the browser pans the view itself (the extension
// must not double it; at most the very first step), and B) with wheel events the browser doesn't act on, like a Linux
// touchpad's sideways swipe in Chrome (user report: "nothing moves") — the extension pans.
//   node pinch-pan.mjs <ext-dir> [url]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, url = "https://www.reddit.com/r/sysadmin/"] = process.argv.slice(2);
let fail = 0;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 914, height: 800 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const run = async (label, step) => {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable .thing, .commentarea", { timeout: 30000 }); await page.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 4 }); await page.waitForTimeout(800);
  await page.mouse.move(450, 400);
  const x = () => page.evaluate(() => Math.round(visualViewport.pageLeft));
  const xs = [await x()];
  for (let i = 0; i < 5; i++) { await step(page, false); await page.waitForTimeout(200); xs.push(await x()); }
  const shift = [await x()];
  for (let i = 0; i < 4; i++) { await step(page, true); await page.waitForTimeout(200); shift.push(await x()); }
  const steps = (a) => a.slice(1).map((v, i) => v - a[i]);
  // one step each; where the browser pans too (A), the very first step after zooming may be
  // doubled before the extension notices and steps aside — never after that
  const even = (a) => { const d = steps(a); return d[0] >= 20 && d[0] <= 40 && d.slice(1).every((x) => x === 20); };
  const ok = even(xs) && even(shift);
  console.log((ok ? "PASS " : "FAIL ") + label.padEnd(34), "sideways:", JSON.stringify(xs), " shift+scroll:", JSON.stringify(shift));
  if (!ok) fail++;
  await page.close();
};
// A: real wheel input (the browser pans the zoomed view itself here)
await run("A real wheel (browser pans)", async (page, shift) => { if (shift) { await page.keyboard.down("Shift"); await page.mouse.wheel(0, 80); await page.keyboard.up("Shift"); } else await page.mouse.wheel(80, 0); });
// B: wheel events the browser doesn't act on (like the user's touchpad)
await run("B synthetic (browser doesn't pan)", (page, shift) => page.evaluate((shift) => {
  const t = document.elementFromPoint(450 / 4 + visualViewport.offsetLeft, 400 / 4 + visualViewport.offsetTop) || document.body;
  t.dispatchEvent(new WheelEvent("wheel", { deltaX: shift ? 0 : 20, deltaY: shift ? 20 : 0, shiftKey: shift, bubbles: true, cancelable: true, view: window }));
}, shift));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? fail + " FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
