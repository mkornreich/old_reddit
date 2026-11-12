// Tagline quick actions + logged-out hover cards (PR #29 + follow-up), live, logged out:
// icons hidden (taking no room) until the pointer is on their tagline; filter → hide + toast + undo; tag → badge, with
// the same icon/badge order before and after a reload; hover cards with real data;
// comments page: tag icons only.   node quick-actions.mjs <ext-dir> <out-dir>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled", "--window-position=-3000,0"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
page.on("dialog", (d) => d.accept("qa-test"));
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
// the icons take no room until the pointer is on their tagline (no blank gaps in it)
const shownOf = (sel) => page.evaluate((sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0 : null; }, sel);
// point at an icon's tagline, then click the icon (it only exists on screen while pointed at)
const clickIcon = async (loc) => { await loc.locator("xpath=ancestor::p[contains(@class,'tagline')]").hover(); await page.waitForTimeout(150); await loc.click(); };
const order = (u) => page.evaluate((u) => { const a = Array.from(document.querySelectorAll("#siteTable a.author")).find((x) => x.textContent === u); const tl = a && a.closest(".tagline"); return tl ? Array.from(tl.children).map((c) => c.classList.contains("orr-qa") ? "qa:" + c.dataset.qa : (c.className || c.tagName).split(" ")[0]).filter((x) => x !== "time").join(">") : null; }, u);
const card = () => page.evaluate(() => { const c = document.getElementById("orr-hovercard"); return c && c.style.display !== "none" ? c.innerText.replace(/\s+/g, " ") : null; });

await page.goto("https://www.reddit.com/r/popular/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.mouse.move(1300, 850);
const first = "#siteTable .thing.link:first-child a.orr-qa";
const counts = await page.evaluate(() => ({ posts: document.querySelectorAll("#siteTable .thing.link").length, icons: document.querySelectorAll("#siteTable a.orr-qa").length }));
check("3 icons per listing post", counts.icons === counts.posts * 3, JSON.stringify(counts));
check("icons hidden (and take no room) until hover", (await shownOf(first)) === false);
await page.hover("#siteTable .thing.link:first-child a.title");
await page.waitForTimeout(300);
check("still hidden while pointing at the title", (await shownOf(first)) === false);
await page.hover("#siteTable .thing.link:first-child .tagline");
await page.waitForTimeout(300);
check("icons shown while pointing at the tagline", (await shownOf(first)) === true);
await page.screenshot({ path: path.join(outDir, "hover-icons.png"), clip: { x: 0, y: 80, width: 900, height: 200 } });

// filter + undo
const subIcon = page.locator('#siteTable .thing.link:not(.orr-filtered) a.orr-qa[data-qa="filter"][data-qa-kind="subreddits"]').first();
const sub = await subIcon.getAttribute("data-qa-name");
const visible = () => page.evaluate((s) => Array.from(document.querySelectorAll("#siteTable .thing.link")).filter((t) => (t.dataset.subreddit || "").toLowerCase() === s.toLowerCase() && !t.classList.contains("orr-filtered")).length, sub);
const v0 = await visible();
await clickIcon(subIcon);
await page.waitForTimeout(600);
const toast = await page.evaluate(() => (document.getElementById("orr-toast") || {}).innerText || "");
check("filter hides the sub's posts + toast", (await visible()) === 0 && /filtered/.test(toast), `${sub}: ${v0} → 0, "${toast}"`);
await page.click("#orr-toast a");
await page.waitForTimeout(600);
check("undo restores them", (await visible()) === v0);

// tag → badge; icons sit after the badge, same order after a reload
const tagIcon = page.locator('#siteTable a.orr-qa[data-qa="tag"]').nth(1);
const user = await tagIcon.getAttribute("data-qa-name");
await clickIcon(tagIcon);
await page.waitForTimeout(600);
const o1 = await order(user);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const o2 = await order(user);
check("badge/icon order stable across reload", !!o1 && o1 === o2 && /orr-usertag>qa:/.test(o1), `${o1} | ${o2}`);

// logged-out hover cards from Reddit's hover-card partials
await page.locator("#siteTable a.author").first().hover();
await page.waitForTimeout(2500);
const uc = await card();
check("user hover card has karma + cake day", !!uc && /comment karma/.test(uc) && /cake day \d{4}-/.test(uc), uc);
await page.mouse.move(5, 5);
await page.waitForTimeout(500);
await page.locator("#siteTable .tagline a.subreddit").first().hover();
await page.waitForTimeout(2500);
const sc = await card();
check("sub hover card has weekly visitors + description", !!sc && /weekly visitors/.test(sc), sc && sc.slice(0, 140));
await page.screenshot({ path: path.join(outDir, "hovercard.png") });
await page.mouse.move(5, 5);

// comments page: tag icons only; filtering from a hover card says "in listings"
await page.locator("#siteTable .thing.link:not(.stickied) a.bylink.comments").first().click();
await page.waitForSelector(".commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const ci = await page.evaluate(() => ({ comments: document.querySelectorAll(".commentarea .thing.comment").length, tag: document.querySelectorAll('.commentarea a.orr-qa[data-qa="tag"]').length, filter: document.querySelectorAll('a.orr-qa[data-qa="filter"]').length }));
check("comments page: one tag icon per comment, no filter icons", ci.tag === ci.comments && ci.filter === 0, JSON.stringify(ci));
await page.locator(".commentarea .thing.comment a.author").first().hover();
await page.waitForTimeout(2500);
await page.click("#orr-hovercard .orr-filterbtn").catch(() => {});
await page.waitForTimeout(500);
const t2 = await page.evaluate(() => (document.getElementById("orr-toast") || {}).innerText || "");
check("comments-page filter toast says 'in listings'", /hidden in listings/.test(t2), t2);
await page.screenshot({ path: path.join(outDir, "comments.png"), clip: { x: 0, y: 80, width: 900, height: 360 } });
check("no page errors", errors.length === 0, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
