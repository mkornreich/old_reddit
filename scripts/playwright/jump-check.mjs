// Loading replies never moves what you're reading (issue #35, 2026-11-26). Since v3.17.26
// the "load more comments" inside a thread load by themselves; while they did, the
// comments on screen jumped down as replies were put in above them. Firefox (temporary
// add-on) or Chromium, logged out, one thread:
//  - sitting still where the comments begin, from the moment the page appears, for 15 s,
//    no comment on screen moves;
//  - reading down from a fresh load (a short scroll, a pause), no comment on screen moves
//    during the pauses;
//  - the replies further down still load by themselves before you get to them.
// A page that isn't rebuilt (Reddit's CAPTCHA or block page) is reported as not tested.
//   node jump-check.mjs <ext-dir> <out-dir> [<thread url>]   (CHROMIUM=1: Chromium build)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-jump-"));
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
let replyReqs = 0;
page.on("request", (r) => { if (r.method() === "POST" && /\/svc\/shreddit\/more-comments\//.test(r.url()) && !/[?&]top-level=1/.test(r.url())) replyReqs++; });
// where each comment on screen is (its own line: the tagline), keyed by its id
const onScreen = () => page.evaluate(() => {
  const out = {};
  document.querySelectorAll(".commentarea .thing.comment > .entry > .tagline").forEach((t) => {
    const r = t.getBoundingClientRect();
    if (r.height && r.top >= 0 && r.bottom <= innerHeight) out[t.closest(".thing").getAttribute("data-fullname")] = Math.round(r.top);
  });
  // (a comment can be taller than the screen: then the one whose text is on screen)
  if (!Object.keys(out).length) {
    const e = [...document.querySelectorAll(".commentarea .thing.comment > .entry")].find((x) => { const r = x.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; });
    if (e) out[e.closest(".thing").getAttribute("data-fullname")] = Math.round(e.getBoundingClientRect().top);
  }
  return out;
});
// …and where those same comments are now, on screen or not (one pushed off the bottom moved too)
const whereNow = (a) => page.evaluate((ids) => {
  const out = {};
  ids.forEach((id) => { const t = document.querySelector(`.thing.comment[data-fullname="${id}"] > .entry > .tagline`) || document.querySelector(`.thing.comment[data-fullname="${id}"] > .entry`); if (t) out[id] = Math.round(t.getBoundingClientRect().top); });
  return out;
}, Object.keys(a));
const moved = (a, b) => Object.keys(a).filter((k) => k in b && Math.abs(a[k] - b[k]) > 1).map((k) => `${k} ${a[k]}→${b[k]}`);
const count = () => page.evaluate(() => document.querySelectorAll(".commentarea .thing.comment").length);

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
const rebuilt = await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).then(() => true).catch(() => false);
if (!rebuilt) {
  console.log(`NOT TESTED ${url}: not rebuilt (Reddit's CAPTCHA or block page?)`);
} else {
  // Start reading right away, where the comments begin (the post can be tall), as the page
  // appears — while the replies near the top are still loading.
  const toComments = () => page.evaluate(() => { const c = document.querySelector(".commentarea .thing.comment"); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 40); });
  await toComments();
  await page.waitForTimeout(200);
  const still0 = await onScreen();
  const jumps = [];
  for (let i = 0; i < 60; i++) { // 15 s
    await page.waitForTimeout(250);
    jumps.push(...moved(still0, await whereNow(still0)).map((m) => `${((i + 1) / 4).toFixed(2)}s: ${m}`));
  }
  console.log(`  sitting still: ${Object.keys(still0).length} comments on screen; ${replyReqs} reply requests`);
  ok(jumps.length === 0, `sitting still where the comments begin, no comment on screen moves${jumps.length ? " (" + [...new Set(jumps)].slice(0, 4).join("; ") + ")" : ""}`);

  // Again from a fresh load, reading down: a short scroll, a pause, checking nothing moved
  // in the pause.
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).catch(() => {});
  await toComments();
  const c0 = await count(), r0 = replyReqs;
  const readJumps = [];
  for (let i = 0; i < 24; i++) { // ~36 s
    await page.mouse.wheel(0, 350);
    await page.waitForTimeout(250);
    const a = await onScreen();
    await page.waitForTimeout(1250);
    readJumps.push(...moved(a, await whereNow(a)).map((m) => `step ${i + 1}: ${m}`));
  }
  const c1 = await count();
  console.log(`  reading down: ${c0} → ${c1} comments, ${replyReqs - r0} reply requests`);
  ok(readJumps.length === 0, `reading down, no comment on screen moves while you read${readJumps.length ? " (" + readJumps.length + ": " + readJumps.slice(0, 4).join("; ") + ")" : ""}`);
  ok(c1 > c0 && replyReqs > r0, `the replies further down still load by themselves (${c0} → ${c1} comments)`);
  await page.screenshot({ path: path.join(outDir, "thread.png") });
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
