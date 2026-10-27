// Does Reddit serve some logged-out visitors differently (A/B tests, bot checks, edge
// buckets) in ways that matter to the extension? Opens N fresh sessions (each gets its own
// edgebucket / loid cookies) per browser and records, for every data source the extension
// reads: the subreddit page itself (new Reddit / old reddit / a "Prove your humanity"
// check), the .json (blocked?), the feed partial, a thread page, the search partial, a
// combined r/a+b page, and old.reddit.com. Differences between rows = something bucketed.
// No extension involved — this is what Reddit sends.
//   node ab-probe.mjs <out.json> [n=6] [chromium|firefox|android|all]
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium, firefox } from "playwright";
import fs from "node:fs";

const [out, nArg = "6", which = "all"] = process.argv.slice(2);
const N = parseInt(nArg, 10);
const UAS = {
  chromium: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  firefox: null, // Playwright Firefox's own
  android: "Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
};
const kinds = which === "all" ? ["chromium", "firefox", "android"] : [which];
const rows = [];
for (const kind of kinds) {
  const browser = kind === "chromium" ? await chromium.launch({ channel: "chromium", headless: false, args: ["--disable-blink-features=AutomationControlled"] }) : await firefox.launch({ headless: false });
  for (let i = 0; i < N; i++) {
    const ctx = await browser.newContext(Object.assign({ viewport: kind === "android" ? { width: 412, height: 900 } : { width: 1300, height: 900 } },
      UAS[kind] ? { userAgent: UAS[kind] } : {}, kind === "android" ? { isMobile: false, hasTouch: true } : {}));
    if (kind === "chromium") await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
    const page = await ctx.newPage();
    const row = { kind, i };
    try {
      const resp = await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      row.doc = await page.evaluate(() => ({
        url: location.pathname,
        title: document.title.slice(0, 40),
        shreddit: !!document.querySelector("shreddit-app"),
        posts: document.querySelectorAll("shreddit-post").length,
        oldReddit: !!document.querySelector("#siteTable .thing"),
        challenge: /prove your humanity|verify you are human|are you a robot/i.test(document.body ? document.body.innerText.slice(0, 3000) : ""),
        appAttrs: (() => { const a = document.querySelector("shreddit-app"); return a ? Array.from(a.attributes).map((x) => x.name).filter((n) => !/^(class|style)$/.test(n)).join(",") : ""; })(),
      }));
      row.status = resp ? resp.status() : 0;
      const cookies = await ctx.cookies("https://www.reddit.com");
      row.cookies = cookies.map((c) => c.name).sort().join(",");
      row.edgebucket = (cookies.find((c) => c.name === "edgebucket") || {}).value || "";
      row.api = await page.evaluate(async () => {
        const P = { credentials: "include", headers: { Accept: "text/vnd.reddit.partial+html, text/html;q=0.9" } };
        const get = async (u, init) => { try { const r = await fetch(u, init || P); const t = await r.text(); return { s: r.status, ct: (r.headers.get("content-type") || "").split(";")[0].replace(/^text\/vnd\.reddit\.partial\+html$/, "partial"), t }; } catch (e) { return { s: -1, ct: String(e).slice(0, 40), t: "" }; } };
        const n = (t, re) => (t.match(re) || []).length;
        const j = await get("/r/pics/.json?limit=5", { credentials: "include", headers: { Accept: "application/json" } });
        const me = await get("/api/me.json", { credentials: "include", headers: { Accept: "application/json" } });
        const feed = await get("/svc/shreddit/community-more-posts/hot/?name=pics");
        const pl = (/permalink="(\/r\/pics\/comments\/[^"]+)"/.exec(feed.t) || [])[1];
        const thread = pl ? await get(pl) : { s: 0, ct: "", t: "" };
        const front = await get("/svc/shreddit/feeds/popular-feed?sort=BEST");
        const search = await get("/svc/shreddit/search/?q=cats&type=posts");
        const multi = await get("/r/pics+aww/");
        const hover = await get("/svc/shreddit/community-hover-card/pics");
        return {
          json: j.s + " " + j.ct + (/blocked/i.test(j.t) ? " (blocked)" : ""),
          me: me.s + " " + me.ct,
          feed: feed.s + " " + feed.ct + " posts=" + n(feed.t, /<shreddit-post /g),
          thread: thread.s + " " + thread.ct + " post=" + n(thread.t, /<shreddit-post /g) + " comments=" + n(thread.t, /<shreddit-comment /g),
          front: front.s + " posts=" + n(front.t, /<shreddit-post /g),
          search: search.s + " results=" + n(search.t, /data-testid="post-title"/g),
          multi: multi.s + " " + multi.ct + " oldThings=" + n(multi.t, /data-fullname="t3_/g) + " shredditPosts=" + n(multi.t, /<shreddit-post /g),
          hover: hover.s + " " + hover.t.length + "B",
          challenge: [j, feed, thread, front, search, multi].filter((x) => /prove your humanity/i.test(x.t)).length,
        };
      });
      const oresp = await page.goto("https://old.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => null);
      row.oldReddit = { status: oresp ? oresp.status() : 0, url: page.url().replace(/^https:\/\//, "").slice(0, 60), things: await page.evaluate(() => document.querySelectorAll("#siteTable .thing").length).catch(() => -1) };
    } catch (e) {
      row.error = String(e.message || e).slice(0, 160);
    }
    rows.push(row);
    console.log(JSON.stringify(row));
    await ctx.close();
  }
  await browser.close();
}
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
// what varies between sessions
const flat = rows.map((r) => ({ kind: r.kind, status: r.status, docUrl: r.doc && r.doc.url, shreddit: r.doc && r.doc.shreddit, oldDoc: r.doc && r.doc.oldReddit, challengeDoc: r.doc && r.doc.challenge, appAttrs: r.doc && r.doc.appAttrs,
  ...Object.fromEntries(Object.entries(r.api || {}).map(([k, v]) => [k, typeof v === "string" ? v.replace(/=\d+/g, (m) => (m === "=0" ? "=0" : "=N")) : v])),
  old: r.oldReddit && r.oldReddit.url.replace(/[?#].*/, "") + " " + r.oldReddit.status + (r.oldReddit.things > 0 ? " things" : ""), error: r.error }));
const keys = Object.keys(flat[0] || {});
console.log("\nVaries across sessions (same browser kind):");
for (const kind of kinds) {
  const fr = flat.filter((f) => f.kind === kind);
  const varying = keys.filter((k) => new Set(fr.map((f) => JSON.stringify(f[k]))).size > 1);
  console.log(" " + kind + ": " + (varying.length ? varying.map((k) => k + " → " + Array.from(new Set(fr.map((f) => JSON.stringify(f[k])))).join(" | ")).join("\n    ") : "nothing"));
}
console.log("\nDiffers between browser kinds:");
for (const k of keys) {
  const per = kinds.map((kind) => kind + ": " + Array.from(new Set(flat.filter((f) => f.kind === kind).map((f) => JSON.stringify(f[k])))).join(" | "));
  if (new Set(kinds.map((kind) => Array.from(new Set(flat.filter((f) => f.kind === kind).map((f) => JSON.stringify(f[k])))).join("|"))).size > 1) console.log(" " + k + "\n    " + per.join("\n    "));
}
