// Logged out, an empty subreddit feed (r/Android's top of the past 24 hours a day after its
// last post) must render old reddit's empty listing — the tab, the time menu and "there
// doesn't seem to be anything here", no 18+ gate — while a banned / missing subreddit,
// whose feed is just as empty, is left to Reddit's own page. Reddit's feed partial is faked
// empty (a real empty top-of-day can't be counted on); the community hover card that tells
// the two apart is the real one.
//   node empty-listing.mjs <ext-dir> <out-dir> [visible-sub] [banned-sub]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, visible = "Android", banned = "fatpeoplehate"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1300, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
// an empty feed, like Reddit's (no posts, no "load more")
await ctx.route(/\/svc\/shreddit\/community-more-posts\//, (r) => r.fulfill({ status: 200, contentType: "text/vnd.reddit.partial+html; charset=utf-8", body: '<faceplate-batch><span id="end-of-feed-tracker"></span></faceplate-batch>' }));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const look = async (sub) => {
  await page.goto(`https://www.reddit.com/r/${sub}/top/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable, shreddit-app", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(outDir, `empty-${sub}.png`) });
  return page.evaluate(() => ({
    rebuilt: document.documentElement.classList.contains("orr-rebuilt") && !!document.getElementById("siteTable"),
    empty: (document.getElementById("noresults") || {}).textContent || "",
    tab: (document.querySelector(".tabmenu li.selected a") || {}).textContent || "",
    time: (document.querySelector(".content .menuarea a[style*=bold], .content a[style*='font-weight:bold']") || {}).textContent || "",
    gate: !!document.querySelector(".orr-over18-yes"),
    things: document.querySelectorAll("#siteTable .thing.link").length,
  }));
};
const v = await look(visible);
console.log(JSON.stringify(v));
check(`r/${visible}: an empty top feed renders old reddit's empty listing`, v.rebuilt && /anything here/.test(v.empty) && v.tab === "top" && /24 hours/.test(v.time) && !v.things, JSON.stringify(v));
check(`r/${visible}: no 18+ gate for an empty feed`, !v.gate);
const b = await look(banned);
console.log(JSON.stringify(b));
check(`r/${banned} (banned): left to Reddit's own page`, !b.rebuilt, JSON.stringify(b));
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
