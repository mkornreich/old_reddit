// Logged out: do the front-page feeds honour sort/t? Compares home-feed vs popular-feed
// (2nd page, since the 1st is ~3 posts) by post ages, scores and upvote ratios.
//   node probe15.mjs
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-probe-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2000);
const out = await page.evaluate(async () => {
  const ACC = "text/vnd.reddit.partial+html, text/html;q=0.9";
  const now = Date.now();
  const posts = async (u) => {
    const r = await fetch(u, { credentials: "include", headers: { Accept: ACC } });
    const d = new DOMParser().parseFromString(await r.text(), "text/html");
    return Array.from(d.querySelectorAll("shreddit-post")).filter((p) => !(p.parentElement && p.parentElement.closest("shreddit-post")))
      .map((p) => ({ id: p.id, ageH: (now - Date.parse(p.getAttribute("created-timestamp").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"))) / 3.6e6, score: +p.getAttribute("score"), ratio: +p.getAttribute("upvote-ratio") }));
  };
  const page2 = async (feed, qs) => {
    const p1 = await posts(`/svc/shreddit/feeds/${feed}?${qs}`);
    if (!p1.length) return [];
    const c = encodeURIComponent(btoa(p1[p1.length - 1].id));
    return p1.concat(await posts(`/svc/shreddit/feeds/${feed}?${qs}&after=${c}&cursor=${c}`));
  };
  const sum = (ps) => {
    if (!ps.length) return "0 posts";
    const ages = ps.map((p) => p.ageH).sort((a, b) => a - b);
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return `${ps.length} posts, age ${ages[0].toFixed(1)}–${ages[ages.length - 1].toFixed(1)} h, avg score ${Math.round(avg(ps.map((p) => p.score)))}, avg ratio ${avg(ps.map((p) => p.ratio)).toFixed(2)}, first ${ps[0].id}`;
  };
  const o = {};
  for (const feed of ["home-feed", "popular-feed"]) {
    for (const qs of ["sort=BEST", "sort=HOT", "sort=NEW", "sort=TOP&t=HOUR", "sort=CONTROVERSIAL"]) o[`${feed} ${qs}`] = sum(await page2(feed, qs));
  }
  return o;
});
console.log(JSON.stringify(out, null, 1));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
