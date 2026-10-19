// In-page navigation without new Reddit's router: listing → thread → Back → Forward,
// reporting each page (rebuilt, items, scroll) plus any full document loads and any fetch
// new Reddit's own router made for those pages (`screen_view_count` — there should be none).
//   node nav-check.mjs <ext-dir>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1300, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
const routerFetches = [], docLoads = [];
page.on("request", (r) => { if (/screen_view_count/.test(r.url())) routerFetches.push(r.url().replace("https://www.reddit.com", "").slice(0, 70)); if (r.resourceType() === "document") docLoads.push(r.url().replace("https://www.reddit.com", "").slice(0, 70)); });
const state = () => page.evaluate(() => ({ path: location.pathname.slice(0, 50), rebuilt: document.documentElement.classList.contains("orr-rebuilt"), links: document.querySelectorAll("#siteTable > .thing.link").length, comments: document.querySelectorAll(".commentarea .thing.comment").length, y: Math.round(scrollY) }));
await page.goto("https://www.reddit.com/r/sysadmin/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 });
await page.waitForTimeout(2500);
docLoads.length = 0;
await page.mouse.wheel(0, 900); await page.waitForTimeout(600);
const s0 = await state();
await page.click("#siteTable > .thing.link:nth-of-type(3) a.comments");
await page.waitForSelector(".commentarea .thing.comment", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const s1 = await state();
await page.goBack(); await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500);
const s2 = await state();
await page.goForward(); await page.waitForSelector(".commentarea", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500);
const s3 = await state();
await page.click(".tabmenu a[href*='new']").catch(() => {}); await page.waitForTimeout(3000);
const s4 = await state();
console.log(JSON.stringify({ listing: s0, thread: s1, back: s2, forward: s3, tab: s4, routerFetches, docLoads }, null, 1));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
