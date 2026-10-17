// Find one post in a subreddit's logged-out listing feed (walking pages of hot/new/top) and
// save its <shreddit-post> card as card-<id>.html (input for offline.mjs / lab-post.mjs).
//   node feed-one.mjs <sub> <t3_id> [<out-dir>]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [sub, id] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000);
const r = await page.evaluate(async ([sub, id]) => {
  for (const sort of ["hot", "new", "top"]) {
    let after = "";
    for (let i = 0; i < 6; i++) {
      const t = await (await fetch(`/svc/shreddit/community-more-posts/${sort}/?name=${sub}&t=day${after ? "&after=" + encodeURIComponent(btoa(after)) : ""}`, { headers: { Accept: "text/vnd.reddit.partial+html" } })).text();
      const d = new DOMParser().parseFromString(t, "text/html");
      const p = d.getElementById(id);
      if (p) return { sort, page: i, html: p.outerHTML };
      const all = d.querySelectorAll("shreddit-post");
      if (!all.length) break;
      after = all[all.length - 1].id;
    }
  }
  return null;
}, [sub, id]);
if (r) { fs.writeFileSync(path.join(process.argv[4] || ".", `card-${id}.html`), r.html); console.log(r.sort, r.page, r.html.length); } else console.log("not found");
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
