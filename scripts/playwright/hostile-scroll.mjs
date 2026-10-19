// Sideways scrolling at a zoomed-in width when new Reddit's leftover styles try to clip
// the page: overflow hidden on html/body via an adopted stylesheet, a <style class>, and an
// inline style on <html>; and a browser that reports a touch-ish pointer (hover:none).
//   node hostile-scroll.mjs <ext-dir> <url> [width=640]
// Exits non-zero if the page can't scroll sideways.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, url, w] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: +(w || 640), height: 800 }, hasTouch: true,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => {
  try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {}
  const hostile = () => {
    try { const sh = new CSSStyleSheet(); sh.replaceSync("html { overflow-x: hidden !important; } body { overflow-x: hidden; }"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sh]; } catch (e) {}
    const st = document.createElement("style"); st.className = "nr-keep"; st.textContent = "html, body { overflow-x: clip; }"; (document.head || document.documentElement).appendChild(st);
    document.documentElement.style.overflowX = "hidden";
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hostile); else hostile();
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing, .commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3500);
const st = await page.evaluate(() => ({ hover: matchMedia("(hover:hover)").matches, pointerFine: matchMedia("(pointer:fine)").matches,
  htmlOx: getComputedStyle(document.documentElement).overflowX, bodyOx: getComputedStyle(document.body).overflowX, bodyW: document.body.scrollWidth, vw: document.documentElement.clientWidth, max: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
await page.mouse.move(300, 400); await page.mouse.wheel(250, 0); await page.waitForTimeout(800);
const scrolledX = await page.evaluate(() => Math.round(scrollX));
console.log(JSON.stringify({ ...st, scrolledX }));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
process.exit(st.max > 0 && scrolledX > 0 ? 0 : 1);
