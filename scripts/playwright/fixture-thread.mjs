// Probe: a thread as a LOGGED-IN reader sees it, from a saved thread.json. Fake login:
// /api/me.json says "orr_test_user", the thread's .json is answered from the file, writes
// are answered {} and nothing reaches a Reddit account. Plain Chromium (nothing hidden).
// Prints each top-level comment's pictures (tag, address, size) and the start of its body;
// screenshots the first three comments and the page. (Used 2026-11-20 to check a GIF
// comment logged in; build the file with arctic-fixture.mjs.)
//   node fixture-thread.mjs <chromium-ext-dir> <out-dir> <thread.json> <thread url>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, fix, url] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const thread = JSON.parse(fs.readFileSync(fix, "utf8"));
const post = thread[0].data.children[0].data;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-fix-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
});
const json = (route, body, status) => route.fulfill({ status: status || 200, contentType: "application/json; charset=UTF-8", body: JSON.stringify(body) });
const served = [];
await ctx.route(/^https:\/\/www\.reddit\.com\/(api|r|comments)\//, async (route) => {
  const u = new URL(route.request().url());
  const p = u.pathname;
  if (route.request().method() === "POST") return json(route, {});
  if (p === "/api/me.json") return json(route, { kind: "t2", data: { name: "orr_test_user", modhash: "mh_test", link_karma: 1, comment_karma: 1, inbox_count: 0 } });
  if (p.endsWith(".json") && p.indexOf("/comments/" + post.id) >= 0) { served.push(p + u.search); return json(route, thread); }
  return route.continue();
});
await ctx.route(/^https:\/\/www\.reddit\.com\/login/, (route) => route.abort()); // (new Reddit's own logged-out redirect)
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
const rebuilt = await page.waitForSelector("html.orr-rebuilt .commentarea .comment", { timeout: 40000 }).then(() => true).catch(() => false);
await page.waitForTimeout(6000);
console.log("rebuilt:", rebuilt, "| thread .json answered from the file:", served.length);
const info = await page.evaluate(() => [...document.querySelectorAll(".commentarea .comment")].filter((c) => !c.parentElement.closest(".comment")).map((c) => {
  const e = c.querySelector(":scope > .entry");
  const body = e.querySelector(".usertext-body");
  const media = [...body.querySelectorAll("img, video")].map((m) => { const r = m.getBoundingClientRect(); return `${m.tagName} ${(m.currentSrc || m.getAttribute("src") || "").slice(0, 90)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
  return { author: c.getAttribute("data-author"), media, text: body.textContent.replace(/\s+/g, " ").trim().slice(0, 120) };
}));
console.log(JSON.stringify(info, null, 2));
const cs = await page.$$(".commentarea .comment");
for (let i = 0; i < Math.min(3, cs.length); i++) await cs[i].screenshot({ path: path.join(outDir, `c${i}.png`) }).catch(() => {});
await page.screenshot({ path: path.join(outDir, "page.png"), fullPage: true });
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
