// Replies behind a "load more comments" INSIDE a thread load on their own (issue #33,
// 2026-11-23) — while they're below the screen, so nothing you're reading moves (issue #35,
// 2026-11-26; jump-check.mjs checks that). Logged out, Reddit's thread page sends little
// beyond the top-level comments, so nearly every one ended in a "load more comments" you
// had to click; old reddit shows the replies outright. Firefox (temporary add-on) or
// Chromium, logged out, one thread:
//  - where the comments begin, with no scrolling, the stubs just below the screen load by
//    themselves (the comment count grows, or they came in with the first screen's, fetched
//    together before the comments showed: v3.17.29); the ones on screen stay links, and a
//    click loads one;
//  - after the comments show, auto-loads go one request at a time, ~1 s apart;
//  - a collapsed comment's stubs don't load (scrolled past); expanded again, they do;
//  - scrolling down, the stubs further down load before they come on screen;
//  - after a reload, "collapse all" right away: nothing more loads; a comment opened again
//    gets its replies.
// A page that isn't rebuilt (Reddit's CAPTCHA or block page) is reported as not tested.
//   node reply-more-check.mjs <ext-dir> <out-dir> [<thread url>]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
const url = argUrl || "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/";
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-rmc-"));
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
        const len = parseInt(buf.slice(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.slice(c + 1, c + 1 + len).toString("utf8")); buf = buf.slice(c + 1 + len);
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
// Every more-comments request for replies inside a thread (startingDepth=…; the top-level
// stub at the end of the thread asks for top-level=1): when it started and ended.
const reqs = [];
const isReply = (u) => /\/svc\/shreddit\/more-comments\//.test(u) && !/[?&]top-level=1/.test(u);
page.on("request", (r) => { if (r.method() === "POST" && isReply(r.url())) reqs.push({ url: r.url(), start: Date.now(), end: 0 }); });
const done = (r) => { const x = reqs.find((q) => q.url === r.url() && !q.end); if (x) x.end = Date.now(); };
page.on("requestfinished", done);
page.on("requestfailed", done);
const STUBS = ".commentarea .child a.orr-more[data-partial], .commentarea .child a.orr-more[data-children]";
const state = () => page.evaluate((sel) => {
  const stubs = [...document.querySelectorAll(sel)].map((a) => ({ a, r: a.getBoundingClientRect() })).filter((x) => x.r.height > 0);
  return {
    comments: document.querySelectorAll(".commentarea .thing.comment").length,
    replyStubs: stubs.length,
    onScreen: stubs.filter((x) => x.r.top >= 0 && x.r.bottom <= innerHeight).map((x) => x.a.getAttribute("data-partial") || x.a.getAttribute("data-children")),
    // just below the screen: these should have loaded by now
    ahead: stubs.filter((x) => x.r.top >= innerHeight && x.r.top < innerHeight + 1000).length,
  };
}, STUBS);
// put a comment's own "load more comments" a little below the screen
// (its own: right under it; else the first one in its replies)
const putBelow = (id) => page.evaluate((id) => {
  const a = document.querySelector(`.thing.comment[data-fullname="${id}"] > .child > .morecomments a.orr-more`) ||
    document.querySelector(`.thing.comment[data-fullname="${id}"] .child a.orr-more`);
  if (!a) return "none";
  window.scrollBy(0, a.getBoundingClientRect().top - innerHeight - 300);
  // (on a short page it can't get below the screen: then it stays a link, and a click loads it)
  return a.getBoundingClientRect().top >= innerHeight ? "below" : "on screen";
}, id);
const clickStubOf = (id) => page.evaluate((id) => {
  const a = document.querySelector(`.thing.comment[data-fullname="${id}"] > .child > .morecomments a.orr-more`) ||
    document.querySelector(`.thing.comment[data-fullname="${id}"] .child a.orr-more`);
  if (a) a.click();
}, id);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
const rebuilt = await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).then(() => true).catch(() => false);
// (the comments show once the replies on the first screen are in: those are fetched together,
// before this — v3.17.29, first-screen-check.mjs — so the pacing below counts only later ones)
const shownAt = Date.now();
// requests started in [from, to): one at a time, and ~1 s apart
const paced = (from, to) => {
  const list = reqs.filter((r) => r.start >= from && r.start < to).sort((a, b) => a.start - b.start);
  const overlap = list.some((r, i) => i && r.start < (list[i - 1].end || Infinity));
  const gaps = list.slice(1).map((r, i) => r.start - (list[i].end || list[i].start));
  return { n: list.length, ok: !overlap && gaps.every((g) => g >= 700), gaps };
};
if (!rebuilt) {
  console.log(`NOT TESTED ${url}: not rebuilt (Reddit's CAPTCHA or block page?)`);
} else {
  // (where the comments begin, so some "load more comments" are on screen)
  await page.evaluate(() => { const c = document.querySelector(".commentarea .thing.comment"); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 40); });
  await page.waitForTimeout(300);
  const first = await state();
  await page.waitForTimeout(20000);
  const after = await state();
  const early = reqs.filter((r) => r.start < shownAt).length;
  console.log(`  at first: ${JSON.stringify({ ...first, onScreen: first.onScreen.length })}; after 20 s: ${JSON.stringify({ ...after, onScreen: after.onScreen.length })}; reply requests: ${reqs.length} (${early} before the comments showed)`);
  ok(reqs.length > 0 && (after.comments > first.comments || early > 0), `with no scrolling, replies below the screen load by themselves (${first.comments} → ${after.comments} comments, ${reqs.length} requests, ${early} of them before the comments showed)`);
  ok(after.ahead === 0, `no "load more comments" left inside threads just below the screen (${after.ahead})`);
  const p1 = paced(shownAt, Date.now());
  // One that hasn't loaded, brought to the middle of the screen: it stays a link (loading it
  // there would push down what you're reading) — and a click loads it.
  const mid = await page.evaluate((sel) => {
    const a = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().top > innerHeight + 1400 && !x.dataset.orrLoading);
    if (!a) return null;
    window.scrollBy(0, a.getBoundingClientRect().top - innerHeight / 2);
    return a.getAttribute("data-partial") || a.getAttribute("data-children");
  }, STUBS);
  if (!mid) console.log("NOT TESTED on screen: no unloaded \"load more comments\" far enough down");
  else {
    const byKey = (p) => page.evaluate((p) => { const a = [...document.querySelectorAll("a.orr-more")].find((x) => (x.getAttribute("data-partial") || x.getAttribute("data-children")) === p); return a ? Math.round(a.getBoundingClientRect().top) : null; }, p);
    const n2 = reqs.length;
    await page.waitForTimeout(8000);
    const asked = reqs.slice(n2).some((r) => r.url.indexOf(mid.replace(/&amp;/g, "&")) >= 0);
    const top = await byKey(mid);
    ok(top !== null && !asked, `one on screen stays a link (at ${top}px; loading it would push down what you're reading)`);
    const c2 = (await state()).comments;
    await page.evaluate((p) => [...document.querySelectorAll("a.orr-more")].find((x) => (x.getAttribute("data-partial") || x.getAttribute("data-children")) === p).click(), mid);
    await page.waitForTimeout(5000);
    ok((await byKey(mid)) === null && (await state()).comments > c2, `a click loads it`);
  }

  // Collapse a comment further down that still has replies to load, scroll past it: they stay.
  const target = await page.evaluate(() => {
    const stub = [...document.querySelectorAll(".commentarea .child a.orr-more[data-partial], .commentarea .child a.orr-more[data-children]")]
      .find((a) => a.getBoundingClientRect().top > innerHeight + 1500 && !a.dataset.orrLoading);
    if (!stub) return null;
    const c = stub.closest(".thing.comment");
    const ex = c.querySelector(":scope > .entry .expand");
    ex.click();
    return { id: c.getAttribute("data-fullname"), partial: stub.getAttribute("data-partial") || stub.getAttribute("data-children"), text: stub.textContent, observed: stub.getAttribute("data-orr-observed"), top: Math.round(stub.getBoundingClientRect().top) };
  });
  if (!target) console.log("NOT TESTED collapsed comment: no stub far enough down");
  else {
    const n0 = reqs.length;
    await page.evaluate((id) => document.querySelector(`.thing.comment[data-fullname="${id}"]`).scrollIntoView({ block: "start" }), target.id);
    await page.waitForTimeout(8000);
    const asked = reqs.slice(n0).some((r) => r.url.indexOf(target.partial.replace(/&amp;/g, "&")) >= 0);
    ok(!asked, `a collapsed comment's replies don't load when you scroll to it (${target.id})`);
    await page.evaluate((id) => document.querySelector(`.thing.comment[data-fullname="${id}"] > .entry .expand`).click(), target.id);
    await page.waitForTimeout(500);
    const where = await putBelow(target.id); // (it loads while it's below the screen)
    if (where === "on screen") await clickStubOf(target.id);
    await page.waitForTimeout(8000);
    const left = await page.evaluate((id) => { const a = document.querySelector(`.thing.comment[data-fullname="${id}"] > .child > .morecomments a.orr-more`); return a ? { text: a.textContent, loading: a.dataset.orrLoading || "", observed: a.getAttribute("data-orr-observed"), top: Math.round(a.getBoundingClientRect().top), collapsed: !!a.closest(".collapsed") } : null; }, target.id);
    ok(!left, `expanded again, its replies load (${where === "on screen" ? "on screen on this short page: with a click" : "below the screen: by themselves"})${left ? " (stub: " + JSON.stringify(left) + "; before: " + JSON.stringify(target) + ")" : ""}`);
  }

  // Scroll down through the thread: the stubs further down load before they come on screen.
  const before = await state();
  const scrollFrom = Date.now();
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(1800); }
  await page.waitForTimeout(6000);
  const end = await state();
  console.log(`  scrolled down: ${before.comments} → ${end.comments} comments`);
  ok(end.comments > before.comments && end.ahead === 0, `scrolling down, replies further down load before they come on screen (${before.comments} → ${end.comments} comments; ${end.ahead} stub(s) left just below the screen)`);
  // (sitting at the top, then scrolling down: no clicks in either)
  const p2 = paced(scrollFrom, Date.now());
  ok(p1.ok && p2.ok && p1.n + p2.n >= 2, `after the comments show, one request at a time, ~1 s apart (${p1.n + p2.n} requests; gaps ${p1.gaps.concat(p2.gaps).slice(0, 10).join(", ")} ms)`);
  await page.screenshot({ path: path.join(outDir, "thread.png") });

  // "collapse all" right away, while replies wait to load: nothing more loads; a comment
  // opened again gets its replies.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  const again = await page.waitForSelector("html.orr-rebuilt .commentarea a.orr-collapse-all", { timeout: 40000 }).then(() => true).catch(() => false);
  if (!again) console.log("NOT TESTED collapse all: the reloaded page wasn't rebuilt");
  else {
    await page.click("a.orr-collapse-all");
    const clickedAt = Date.now();
    await page.waitForTimeout(8000);
    const late = reqs.filter((r) => r.start > clickedAt + 1500).length; // (one may be in flight)
    ok(late === 0, `after "collapse all", no more replies load (${late} requests)`);
    const opened = await page.evaluate(() => {
      const c = [...document.querySelectorAll(".commentarea .nestedlisting > .thing.comment.collapsed")]
        .find((t) => t.querySelector(":scope > .child a.orr-more[data-partial], :scope > .child a.orr-more[data-children]"));
      if (!c) return null;
      c.querySelector(":scope > .entry .expand").click();
      return c.getAttribute("data-fullname");
    });
    if (!opened) console.log("NOT TESTED collapse all: no folded comment with replies to load");
    else {
      await page.waitForTimeout(500);
      const n1 = reqs.length;
      const replies = (id) => page.evaluate((id) => document.querySelectorAll(`.thing.comment[data-fullname="${id}"] .thing.comment`).length, id);
      const k0 = await replies(opened);
      const where = await putBelow(opened);
      if (where === "on screen") await clickStubOf(opened);
      await page.waitForTimeout(6000);
      const k1 = await replies(opened);
      // (replies already fetched when "collapse all" folded it were held, and go in without a request)
      ok(k1 > k0, `a comment opened again gets its replies (${opened}, ${where === "on screen" ? "on screen on this short page: with a click" : "below the screen: by itself"}; ${k0} → ${k1} replies, ${reqs.length - n1} requests)`);
    }
  }
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
