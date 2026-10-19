// Pinch-zoom the page (Chrome's page scale, like a trackpad pinch), then send sideways and
// downward two-finger scrolls; report whether the visual viewport pans.
//   node pinch-pan.mjs <ext-dir|-> <url>   ("-" = no extension, for comparison)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, url] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const extArgs = extDir !== "-" ? [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] : [];
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1200, height: 800 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [...extArgs, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000);
const cdp = await ctx.newCDPSession(page);
await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2.5 }).catch((e) => console.log("scale failed", e.message));
await page.waitForTimeout(1200);
const vv = () => page.evaluate(() => ({ scale: +visualViewport.scale.toFixed(2), left: Math.round(visualViewport.pageLeft), top: Math.round(visualViewport.pageTop), rebuilt: document.documentElement.classList.contains("orr-rebuilt") }));
await page.mouse.move(600, 400);
const wheel = async (dx, dy) => { for (let i = 0; i < 4; i++) { await page.mouse.wheel(dx, dy); await page.waitForTimeout(150); } await page.waitForTimeout(500); };
const a = await vv();
await wheel(120, 0); const b = await vv();
await wheel(-60, 0); const c = await vv();
await wheel(0, 120); const d = await vv();
console.log(JSON.stringify({ url: url.slice(0, 50), pinched: a, right: b, left: c, down: d, panRight: b.left > a.left, panLeft: c.left < b.left, panDown: d.top > c.top }));
// wheel listeners that can cancel scrolling
const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
const { listeners: wl } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId });
const { result: dres } = await cdp.send("Runtime.evaluate", { expression: "document" });
const { listeners: dl } = await cdp.send("DOMDebugger.getEventListeners", { objectId: dres.objectId });
console.log("wheel/touch listeners:", JSON.stringify([...wl.map((l) => ["window", l.type, l.passive]), ...dl.map((l) => ["document", l.type, l.passive])].filter((x) => /wheel|touch|gesture/.test(x[1]))));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
