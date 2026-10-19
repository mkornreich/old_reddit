// In-page navigation: a listing scrolled deep (infinite scroll) → a post → Back must bring
// back every loaded post at the same scroll position, with the post you came from on
// screen; Forward / Back again too; a fresh visit to the listing starts at page 1. Also: no
// full document loads, and no fetches by new Reddit's own router (`screen_view_count`).
// Clicks only on-screen links — Playwright would scroll an off-screen target into view
// first, which no user does (and which once looked like "Back loses your place").
//   node nav-check.mjs <ext-dir> [listing-url]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, listingUrl = "https://www.reddit.com/r/sysadmin/"] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1300, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
const routerFetches = [], docLoads = [], errors = [];
page.on("request", (r) => {
  if (/screen_view_count/.test(r.url())) routerFetches.push(r.url().replace("https://www.reddit.com", "").slice(0, 70));
  if (r.resourceType() === "document") docLoads.push(r.url().replace("https://www.reddit.com", "").slice(0, 70));
});
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const state = () => page.evaluate(() => ({ path: location.pathname.slice(0, 60), y: Math.round(scrollY), items: document.querySelectorAll("#siteTable > .thing.link").length, comments: document.querySelectorAll(".commentarea .thing.comment").length }));
const settleOn = async (sel) => { await page.waitForSelector(sel, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2000); };

await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
await settleOn("#siteTable .thing.link");
docLoads.length = 0;
await page.mouse.move(400, 400);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(700); }
await page.waitForTimeout(1500);
const deep = await state();
// a post whose comments link is on screen right now
const idx = await page.evaluate(() => Array.from(document.querySelectorAll("#siteTable > .thing.link")).findIndex((t) => {
  const a = t.querySelector("a.comments"); if (!a) return false; const r = a.getBoundingClientRect(); return r.top > 80 && r.bottom < innerHeight - 80;
}));
const postId = await page.evaluate((i) => document.querySelectorAll("#siteTable > .thing.link")[i].id, idx);
await page.locator("#siteTable > .thing.link").nth(idx).locator("a.comments").click();
await settleOn(".commentarea .thing.comment");
const thread = await state();
const onScreen = () => page.evaluate((id) => { const t = document.getElementById(id); if (!t) return "missing"; const r = t.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight ? "yes" : "off screen (" + Math.round(r.top) + ")"; }, postId);
await page.goBack();
await settleOn("#siteTable .thing.link");
const back = await state();
const backSeen = await onScreen();
await page.goForward();
await settleOn(".commentarea");
const fwd = await state();
await page.goBack();
await settleOn("#siteTable .thing.link");
const back2 = await state();
console.log(JSON.stringify({ deep, clicked: idx, thread, back, forward: fwd, back2 }));
check("deep scroll loaded more pages", deep.items > 50 && deep.y > 5000, JSON.stringify(deep));
check("opened the post in place", /\/comments\//.test(thread.path) && thread.comments > 0 && thread.y === 0, JSON.stringify(thread));
check("Back: every post back, same scroll position", back.path === deep.path && back.items >= deep.items && Math.abs(back.y - deep.y) <= 2, JSON.stringify(back));
check("Back: the post you came from is on screen", backSeen === "yes", backSeen);
check("Forward then Back again", /\/comments\//.test(fwd.path) && back2.items >= deep.items && Math.abs(back2.y - deep.y) <= 2, JSON.stringify([fwd, back2]));
// a fresh visit (a link to the listing, not Back) starts over at page 1, at the top
await page.evaluate((u) => { const a = document.createElement("a"); a.href = new URL(u).pathname; a.id = "orr-test-link"; a.textContent = "x"; document.querySelector(".content").prepend(a); }, listingUrl);
await page.evaluate(() => window.scrollTo(0, 0));
await page.click("#orr-test-link");
await settleOn("#siteTable .thing.link");
const fresh = await state();
check("a fresh visit starts at page 1, at the top", fresh.items < deep.items && fresh.y === 0, JSON.stringify(fresh));
check("no full page loads, no new-Reddit router fetches", !docLoads.length && !routerFetches.length, JSON.stringify({ docLoads, routerFetches }));
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
