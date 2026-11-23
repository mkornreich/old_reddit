// Replies behind a "load more comments" INSIDE a thread load on their own (issue #33,
// 2026-11-23). Logged out, Reddit's thread page sends little beyond the top-level comments,
// so nearly every one ended in a "load more comments" you had to click; old reddit shows
// the replies outright. Firefox (temporary add-on) or Chromium, logged out, one thread:
//  - with no scrolling, the stubs inside threads near the top of the page load by
//    themselves (the comment count grows), one request at a time, ~1 s apart;
//  - scrolling down, the stubs further down load as they come near the screen;
//  - a collapsed comment's stubs don't load (scrolled past); expanded again, they do.
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
const state = () => page.evaluate(() => {
  const stubs = [...document.querySelectorAll(".commentarea .child a.orr-more[data-partial], .commentarea .child a.orr-more[data-children]")];
  return {
    comments: document.querySelectorAll(".commentarea .thing.comment").length,
    replyStubs: stubs.length,
    // stubs within 800px of the screen, not in a collapsed comment
    nearStubs: stubs.filter((a) => { const r = a.getBoundingClientRect(); return r.height > 0 && r.top < innerHeight + 700 && r.bottom > -700; }).length,
  };
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
const rebuilt = await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).then(() => true).catch(() => false);
if (!rebuilt) {
  console.log(`NOT TESTED ${url}: not rebuilt (Reddit's CAPTCHA or block page?)`);
} else {
  const first = await state();
  await page.waitForTimeout(20000);
  const after = await state();
  console.log(`  at first: ${JSON.stringify(first)}; after 20 s: ${JSON.stringify(after)}; reply requests: ${reqs.length}`);
  ok(reqs.length > 0 && after.comments > first.comments, `with no scrolling, replies near the top load by themselves (${first.comments} → ${after.comments} comments, ${reqs.length} requests)`);
  ok(after.nearStubs === 0, `no "load more comments" left inside threads near the screen (${after.nearStubs})`);
  const sorted = [...reqs].sort((a, b) => a.start - b.start);
  const overlap = sorted.some((r, i) => i && r.start < (sorted[i - 1].end || Infinity));
  const gaps = sorted.slice(1).map((r, i) => r.start - (sorted[i].end || sorted[i].start));
  ok(!overlap && gaps.every((g) => g >= 700), `one request at a time, ~1 s apart (gaps ${gaps.slice(0, 8).join(", ")} ms)`);

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
    await page.evaluate((id) => document.querySelector(`.thing.comment[data-fullname="${id}"]`).scrollIntoView({ block: "center" }), target.id);
    await page.waitForTimeout(8000);
    const asked = reqs.slice(n0).some((r) => r.url.indexOf(target.partial.replace(/&amp;/g, "&")) >= 0);
    ok(!asked, `a collapsed comment's replies don't load when you scroll to it (${target.id})`);
    await page.evaluate((id) => document.querySelector(`.thing.comment[data-fullname="${id}"] > .entry .expand`).click(), target.id);
    await page.waitForTimeout(500);
    // (the replies it already shows can be long: go to where its stub is)
    await page.evaluate((id) => { const a = document.querySelector(`.thing.comment[data-fullname="${id}"] > .child > .morecomments a.orr-more`); if (a) a.scrollIntoView({ block: "center" }); }, target.id);
    await page.waitForTimeout(8000);
    const left = await page.evaluate((id) => { const a = document.querySelector(`.thing.comment[data-fullname="${id}"] > .child > .morecomments a.orr-more`); return a ? { text: a.textContent, loading: a.dataset.orrLoading || "", observed: a.getAttribute("data-orr-observed"), top: Math.round(a.getBoundingClientRect().top), collapsed: !!a.closest(".collapsed") } : null; }, target.id);
    ok(!left, `expanded again, its replies load${left ? " (stub: " + JSON.stringify(left) + "; before: " + JSON.stringify(target) + ")" : ""}`);
  }

  // Scroll down through the thread: the stubs further down load as they come near.
  const before = await state();
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(1800); }
  await page.waitForTimeout(6000);
  const end = await state();
  console.log(`  scrolled down: ${JSON.stringify(before)} → ${JSON.stringify(end)}`);
  ok(end.comments > before.comments && end.nearStubs <= 1, `scrolling down, replies further down load as they come near (${before.comments} → ${end.comments} comments; ${end.nearStubs} stub(s) near the screen)`);
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
      await page.evaluate((id) => { const a = document.querySelector(`.thing.comment[data-fullname="${id}"] .child a.orr-more`); if (a) a.scrollIntoView({ block: "center" }); }, opened);
      await page.waitForTimeout(6000);
      ok(reqs.length > n1, `a comment opened again loads its replies (${opened}: ${reqs.length - n1} requests)`);
    }
  }
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
