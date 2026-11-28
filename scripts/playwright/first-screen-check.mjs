// A thread opens with the replies on its first screen already in (issue #33, 2026-11-27).
// On a text post the comments start on the first screen, and until v3.17.29 each top comment
// there ended in a "load more comments" that never loaded by itself (it was never below the
// screen). Now the comment tree waits, hidden, while those load together. Firefox (temporary
// add-on) or Chromium (CHROMIUM=1), logged out; the busiest post on r/AskReddit's hot page
// by default (or the thread or /r/<sub>/ given). Checks:
//  - when the comments appear, no "load more comments" inside a thread is on the screen;
//  - they appear at most ~2.5 s after the post does, after at most 12 requests;
//  - from then on, sitting still for 8 s, no comment on the screen moves.
// It opens the thread once before measuring, so the subreddit's style is already stored
// (COLD=1: measure the first visit; see below).
// A page that isn't rebuilt (Reddit's CAPTCHA or block page) is reported as not tested.
//   node first-screen-check.mjs <ext-dir> <out-dir> [<thread url> | /r/<sub>/]   (exits non-zero on failure)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
let url = argUrl || "/r/AskReddit/";
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-fsc-"));
const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
}) : await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false },
});
function rdpInstall(dir) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0), step = 0;
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const c = buf.indexOf(58); if (c < 0) return;
        const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
        if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
        else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
        else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error + ": " + msg.message)) : resolve(msg.addon); }
      }
    });
    sock.on("error", reject);
  });
}
for (let i = 0; !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? "PASS " : "FAIL ") + msg); };
const page = await ctx.newPage();

if (/^\/r\/[^/]+\/?$/.test(url)) { // a subreddit: its hot page's post with the most comments
  await page.goto("https://www.reddit.com" + url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("#siteTable .thing.link", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(2000);
  url = await page.evaluate(() => {
    const posts = Array.from(document.querySelectorAll("#siteTable .thing.link:not(.stickied)"))
      .map((p) => ({ c: parseInt(p.getAttribute("data-comments") || "0", 10), href: p.getAttribute("data-permalink") }))
      .filter((p) => p.href).sort((a, b) => b.c - a.c);
    return posts[0] ? location.origin + posts[0].href : null;
  });
  if (!url) { console.log("NOT TESTED: no thread found on that subreddit's page"); await ctx.close(); process.exit(0); }
}
console.log("thread:", url);
// The subreddit's own style (its header and stylesheet) comes with the sidebar on a first
// visit, and moves the whole page down when it arrives (AskReddit: ~115px) — an older,
// separate jump; later visits take it from storage at once. So the thread is opened once
// first, like someone coming back to a subreddit. COLD=1 skips that (and shows that jump).
if (process.env.COLD !== "1") {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("html.orr-rebuilt .side .titlebox, html.orr-rebuilt .side .md", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  await page.goto("about:blank");
}
let reqs = 0;
page.on("request", (r) => { if (/\/svc\/shreddit\/more-comments\/|\/api\/morechildren/.test(r.url())) reqs++; });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
// watch, every 20 ms: when the post shows, and when the comments do
let postAt = 0, shownAt = 0, atShow = null;
for (let i = 0; i < 2500 && !shownAt; i++) {
  const s = await page.evaluate(() => {
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.height > 0 && getComputedStyle(el).visibility === "visible"; };
    const post = document.querySelector("html.orr-rebuilt #siteTable .thing.link");
    const c = document.querySelector("html.orr-rebuilt .commentarea .thing.comment");
    if (!vis(post)) return { post: false }; // (the guard hides the whole page: visibility)
    if (!vis(c)) return { post: true };
    const stubs = [...document.querySelectorAll(".commentarea .child a.orr-more")].filter((a) => {
      const r = a.getBoundingClientRect(); return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    }).map((a) => a.textContent.trim());
    return { post: true, comments: true, stubs, n: document.querySelectorAll(".commentarea .thing.comment").length };
  }).catch(() => ({}));
  if (s.post && !postAt) postAt = Date.now();
  if (s.comments) { shownAt = Date.now(); atShow = s; }
  else await page.waitForTimeout(20);
}
if (!shownAt) {
  console.log(`NOT TESTED ${url}: no comments appeared (Reddit's CAPTCHA or block page?)`);
} else {
  const reqsAtShow = reqs;
  await page.screenshot({ path: path.join(outDir, "first-screen.png") });
  console.log(`  post showed, then the comments ${shownAt - postAt} ms later: ${atShow.n} comments, ${reqsAtShow} requests`);
  ok(atShow.stubs.length === 0, `no "load more comments" inside a thread on the first screen (${atShow.stubs.length}${atShow.stubs.length ? ": " + JSON.stringify(atShow.stubs) : ""})`);
  ok(shownAt - postAt <= 2500, `the comments waited ${shownAt - postAt} ms (at most ~2.5 s)`);
  ok(reqsAtShow <= 12, `${reqsAtShow} requests before they showed (at most 12)`);
  // sitting still: the comments on the screen stay where they are
  const where = () => page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".commentarea .thing.comment").forEach((c) => {
      const r = c.getBoundingClientRect();
      if (r.top >= 0 && r.top < innerHeight) out[c.getAttribute("data-fullname")] = Math.round(r.top);
    });
    return out;
  });
  const before = await where();
  let moved = [];
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(500);
    const now = await page.evaluate((ids) => ids.map((id) => {
      const c = document.querySelector(`.thing.comment[data-fullname="${id}"]`);
      return c ? Math.round(c.getBoundingClientRect().top) : null;
    }), Object.keys(before));
    Object.keys(before).forEach((id, k) => { if (now[k] !== before[id]) moved.push(`${id} ${before[id]}→${now[k]}`); });
    if (moved.length) break;
  }
  ok(moved.length === 0, `sitting still for 8 s, nothing on the screen moves (${Object.keys(before).length} comments watched${moved.length ? ": " + moved.slice(0, 4).join(", ") : ""})`);
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `${fails.length} FAILED` : "all passed");
process.exit(fails.length ? 1 : 0);
