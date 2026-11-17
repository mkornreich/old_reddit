// A listing that runs out says so at the bottom: "no more posts" (2026-11-17: r/SubredditDrama/top/
// — the day's top posts fit on one page, and the page just stopped, with no sign more weren't
// coming). Logged out, Firefox (temporary add-on) or Chromium. For each page: scroll down until
// infinite scroll has nothing more to load (at most MAX_SCROLLS loads), then
//  - ended: one end message, with the page's wording, below the last item, nothing loading;
//  - not ended yet (a long listing): no end message while more can load;
//  - an empty listing: old reddit's "there doesn't seem to be anything here" / "No results.", no end message.
//   node list-end-check.mjs <ext-dir> <out-dir> [<url>=<expected end text> …]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, ...args] = process.argv.slice(2);
const cases = args.length ? args.map((a) => { const i = a.lastIndexOf("="); return [a.slice(0, i), a.slice(i + 1)]; }) : [
  ["https://www.reddit.com/r/SubredditDrama/top/", "no more posts"],         // the day's top: one short page
  ["https://www.reddit.com/r/SubredditDrama/top/?t=month", "no more posts"], // infinite scroll loads pages, then runs out
  ["https://www.reddit.com/r/pics/", "no more posts"],                       // long: must not say it while more load
  ["https://www.reddit.com/r/SubredditDrama/search/?q=drama&restrict_sr=on&t=week", "no more results"],
  ["https://www.reddit.com/search/?q=%22zzqx%20no%20such%20phrase%20qqzx%22", "no more results"], // empty
];
const MAX_SCROLLS = +(process.env.MAX_SCROLLS || 8);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
// CHROMIUM=1: Playwright's Chromium with the unpacked Chromium build (stage-ext.mjs without --firefox)
const CHROMIUM = process.env.CHROMIUM === "1";
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
const ITEM = "#siteTable > .thing[id^='thing_']";
const state = () => page.evaluate((ITEM) => {
  const items = Array.from(document.querySelectorAll(ITEM)).filter((t) => t.offsetParent);
  const ends = Array.from(document.querySelectorAll(".orr-list-end"));
  const sentinel = document.querySelector(".orr-inf-sentinel");
  const last = items[items.length - 1];
  const e = ends[0];
  return {
    captcha: /Prove your humanity/i.test((document.body && document.body.innerText) || ""),
    items: items.length, ends: ends.length, endText: e ? e.textContent.trim() : null,
    endShown: !!(e && e.offsetParent && getComputedStyle(e).visibility !== "hidden"),
    endBelowLast: !!(e && last && e.getBoundingClientRect().top >= last.getBoundingClientRect().bottom - 1),
    loading: !!sentinel, loadingText: sentinel ? sentinel.textContent.trim() : null,
    // empty: no items, just old reddit's "there doesn't seem to be anything here" / "No results."
    empty: !document.querySelector("#siteTable > .thing[id^='thing_']"),
    emptyText: ((document.getElementById("siteTable") || {}).textContent || "").trim().slice(0, 80),
  };
}, ITEM);

for (const [url, want] of cases) {
  const tag = url.replace("https://www.reddit.com", "");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
  let s = await state();
  const first = s.items;
  for (let i = 0; i < MAX_SCROLLS && s.loading && !/rate|couldn|⚠/.test(s.loadingText || ""); i++) {
    const n = s.items;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    for (let k = 0; k < 20; k++) { await page.waitForTimeout(500); s = await state(); if (s.items !== n || !s.loading) break; }
    await page.waitForTimeout(1200); // (paced: one page load at a time)
    s = await state();
  }
  s.loads = s.items > first ? "some" : 0;
  console.log(`  ${tag}: first page ${first}, ${JSON.stringify(s)}`);
  if (s.captcha) {
    ok(false, `${tag}: Reddit showed its "Prove your humanity" CAPTCHA — not tested (never solve it; try later or in Firefox)`);
  } else if (s.empty) {
    ok(s.ends === 0 && !!s.emptyText, `${tag}: empty listing ("${s.emptyText}") has no end message`);
  } else if (s.loading) {
    ok(s.ends === 0, `${tag}: more to load after ${s.items} items — no end message yet`);
  } else {
    ok(s.items > 0, `${tag}: has items (${s.items}${s.loads ? `, ${s.loads} more pages loaded` : ""})`);
    ok(s.ends === 1 && s.endShown && s.endText === want, `${tag}: says "${want}" at the end (got ${s.ends}× "${s.endText}")`);
    ok(s.endBelowLast, `${tag}: the end message is below the last item`);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, tag.replace(/[^\w]+/g, "_").slice(0, 60) + ".png") });
}

await ctx.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
