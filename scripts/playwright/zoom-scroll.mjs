// Zoomed-in pages scroll sideways: at a narrow window (what Ctrl/Cmd+zoom does to CSS
// width) report html/body overflow, the page width vs the window, what sticks out, any
// rules setting overflow on html/body, and whether a sideways wheel / scrollBy moves it.
//   node zoom-scroll.mjs <ext-dir> <url> [width=700]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, url, widthArg] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: +(widthArg || 700), height: 800 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing, .commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3500);
const st = () => page.evaluate(() => {
  const cs = (el) => { const c = getComputedStyle(el); return { ox: c.overflowX, oy: c.overflowY, w: el.scrollWidth, cw: el.clientWidth, style: el.getAttribute("style") || "" }; };
  const wide = Array.from(document.querySelectorAll("body *")).filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 2).slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + "." + String(e.className).split(" ")[0] + " r=" + Math.round(e.getBoundingClientRect().right));
  // which stylesheet rules set overflow on html/body
  const rules = [];
  for (const sh of Array.from(document.styleSheets)) { let rs; try { rs = sh.cssRules; } catch (e) { continue; } for (const r of Array.from(rs || [])) { if (r.selectorText && /(^|[\s,])(html|body|:root)\b/.test(r.selectorText) && /overflow|touch-action|overscroll/.test(r.cssText)) rules.push((sh.href || (sh.ownerNode && sh.ownerNode.id) || "inline").slice(-40) + " :: " + r.cssText.slice(0, 160)); } }
  return { html: cs(document.documentElement), body: cs(document.body), scrollX: Math.round(scrollX), scrollMaxX: document.documentElement.scrollWidth - document.documentElement.clientWidth, wide, rules: rules.slice(0, 12), htmlClass: document.documentElement.className.slice(0, 120) };
});
const before = await st();
console.log(JSON.stringify(before, null, 1));
await page.mouse.move(350, 400);
await page.mouse.wheel(300, 0);
await page.waitForTimeout(800);
console.log("after horizontal wheel: scrollX =", await page.evaluate(() => Math.round(scrollX)));
await page.evaluate(() => window.scrollBy(300, 0));
console.log("after scrollBy: scrollX =", await page.evaluate(() => Math.round(scrollX)));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
