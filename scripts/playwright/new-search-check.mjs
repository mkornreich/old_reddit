// Firefox (temporary add-on), logged out, "Fold read comment threads" on: "n" finds new
// comments that aren't loaded yet (PR #34). Uses a big, busy thread (the AskReddit post with
// the most comments, or the URL given) and writes its last-visit record in the add-on's
// storage (over the debugging protocol: Playwright can't open moz-extension:// pages):
//   - last visit = the newest comment a fresh render shows, so new comments are only behind
//     "load more": n searches (paced loads, at most 10 a press) and jumps to one, or says why not
//   - last visit = now (nothing new): a press spends its loads and says so; Esc stops the next
//   - always: no new comment hidden inside a branch folded as read; a branch folded as read
//     sits at the top level or under a comment with something new (like the first render),
//     never loaded replies folded inside a read branch; search loads ≥ 1 s apart
//   - the listing's "N new" badge is red (old reddit's grey button color used to win)
//   node new-search-check.mjs <ext-dir> <out-dir> [<thread url>]   (exits non-zero on failure)
//   EARLIER=<seconds> moves that first last-visit time back, so a search is likelier to find one;
//   LASTVISIT=<unix seconds> sets it outright (a quiet thread's loads bring the same comments each run)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, threadArg] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const ADDON_ID = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8")).browser_specific_settings.gecko.id;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
const ctx = await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: {
    "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true,
    "xpinstall.signatures.required": false,
    "extensions.background.idle.timeout": 3600000, // keep the add-on's event page up for addonEval
  },
});
// One Remote Debugging Protocol conversation: handler(msg, send) returns a value to end it.
// (Message lengths are in bytes.)
function rdp(handler, ms = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("RDP timeout")); }, ms);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const c = buf.indexOf(58); if (c < 0) return;
        const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
        let r; try { r = handler(msg, send); } catch (e) { clearTimeout(timer); sock.destroy(); return reject(e); }
        if (r !== undefined) { clearTimeout(timer); sock.end(); return resolve(r); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function rdpInstall(dir) {
  let step = 0;
  return rdp((m, send) => {
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
    else if (step === 1 && m.addonsActor) { step = 2; send({ to: m.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
    else if (step === 2 && m.error) throw new Error(m.error + ": " + m.message);
    else if (step === 2 && m.addon) return m.addon;
  });
}
for (let i = 0; i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
// Run JS in the add-on's background page (Playwright can't open moz-extension:// pages):
// the add-on's watcher lists its frames; the moz-extension:// one is the background page.
function addonEval(js) {
  let step = 0;
  return rdp((m, send) => {
    if (step === 0) { step = 1; send({ to: "root", type: "listAddons" }); }
    else if (step === 1 && m.addons) { step = 2; send({ to: m.addons.find((a) => a.id === ADDON_ID).actor, type: "getWatcher" }); }
    else if (step === 2 && m.actor) { step = 3; send({ to: m.actor, type: "watchTargets", targetType: "frame" }); }
    else if (step === 3 && m.type === "target-available-form" && /^moz-extension:/.test(m.target.url || "")) {
      step = 4; send({ to: m.target.consoleActor, type: "evaluateJSAsync", text: js, mapped: { await: true } });
    } else if (step === 3 && m.from && !m.type) throw new Error("addonEval: the add-on's background page isn't running");
    else if (step === 4 && m.type === "evaluationResult") {
      if (m.hasException || m.topLevelAwaitRejected) throw new Error("addonEval: " + JSON.stringify(m.exceptionMessage || "rejected"));
      return m.result === undefined ? null : m.result;
    } else if (m.error) throw new Error(m.error + ": " + (m.message || ""));
  });
}

const fails = [];
const page = await ctx.newPage();
const loads = []; // [time, url] of "load more comments" requests
page.on("request", (r) => { if (/\/more-comments\/|\/api\/morechildren/.test(r.url())) loads.push([Date.now(), r.url()]); });
let n429 = 0;
const loadStatus = [];
page.on("response", (r) => {
  if (r.status() === 429) n429++;
  if (/\/more-comments\/|\/api\/morechildren/.test(r.url())) loadStatus.push(r.status());
});

// Settings and the visit record live in the add-on's storage.local (prefs fall back to it).
const setPrefs = (patch) => addonEval(`browser.storage.local.set(${JSON.stringify(patch)}).then(() => "ok")`);
const waitRebuilt = async (sel) => { await page.waitForSelector(sel, { timeout: 40000 }).catch(() => {}); await page.waitForTimeout(2500); };

// 1) a busy thread: the AskReddit post with the most comments on its hot page (or the one given)
let thread = threadArg;
if (!thread) {
  await page.goto("https://www.reddit.com/r/AskReddit/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await waitRebuilt("#siteTable .thing.link");
  thread = await page.evaluate(() => {
    const posts = Array.from(document.querySelectorAll("#siteTable .thing.link:not(.stickied)"))
      .map((p) => ({ c: parseInt(p.getAttribute("data-comments") || "0", 10), href: p.getAttribute("data-permalink") }))
      .filter((p) => p.href).sort((a, b) => b.c - a.c);
    return posts[0] ? location.origin + posts[0].href : null;
  });
}
console.log("thread:", thread);
if (!thread) { console.log("FAIL\n  no thread found"); await ctx.close(); process.exit(1); }

// 2) visits. Each revisit's last-visit record is written first.
const info = () => page.evaluate(() => {
  const post = document.querySelector("#siteTable .thing.link");
  const created = Array.from(document.querySelectorAll(".thing.comment")).map((c) => parseInt(c.getAttribute("data-created") || "0", 10));
  return { t3: post && post.getAttribute("data-fullname"), count: parseInt((post && post.getAttribute("data-comments")) || "0", 10),
    comments: created.length, newest: Math.max(0, ...created), stubs: document.querySelectorAll("a.orr-more").length };
});
let t3 = null, count = 0;
async function visit(lastVisit, extra) {
  if (lastVisit != null) await setPrefs(Object.assign({ threadVisits: { [t3]: { t: lastVisit, c: Math.max(0, count - 5) } } }, extra || {}));
  await page.goto(thread, { waitUntil: "domcontentloaded", timeout: 45000 });
  await waitRebuilt(lastVisit != null ? ".commentarea.orr-foldread .thing.comment" : ".commentarea .thing.comment");
  return info();
}
const first = await visit(null);
console.log("first visit:", JSON.stringify(first));
if (!first.t3 || !first.comments) { console.log("FAIL\n  thread didn't rebuild"); await ctx.close(); process.exit(1); }
t3 = first.t3; count = first.count;

const state = () => page.evaluate(() => {
  const area = document.querySelector(".commentarea");
  const toast = document.getElementById("orr-toast");
  const news = Array.from(document.querySelectorAll(".thing.comment.orr-new"));
  const atTop = news.find((t) => { const r = t.getBoundingClientRect(); return r.top >= -2 && r.top < 120 && t.offsetParent !== null; });
  // invariants: no new comment hidden in a read fold; a read fold sits where the first render would put one
  const hiddenNew = document.querySelectorAll(".thing.comment[data-orr-readfold] .thing.comment.orr-new").length;
  const badFolds = Array.from(document.querySelectorAll(".thing.comment[data-orr-readfold]")).filter((c) => {
    const p = c.parentElement && c.parentElement.closest(".thing.comment");
    return p && !p.classList.contains("orr-new") && !p.querySelector(".thing.comment.orr-new");
  }).map((c) => c.id);
  return { foldread: !!(area && area.classList.contains("orr-foldread")), news: news.length, jumpedToNew: !!atTop,
    toast: toast ? toast.textContent : "", searching: document.querySelectorAll(".orr-searching").length,
    readFolds: document.querySelectorAll(".thing.comment[data-orr-readfold]").length, hiddenNew, badFolds, y: Math.round(scrollY) };
});
// Press n and follow the search: the "(k/10)" progress shows as each paced load starts.
const ticks = []; // [time, k]
const commentIds = () => page.evaluate(() => Array.from(document.querySelectorAll(".thing.comment")).map((c) => [c.id, parseInt(c.getAttribute("data-created") || "0", 10)]));
async function pressN(label, opts) {
  const before = loads.length, statusFrom = loadStatus.length;
  const idsBefore = new Set((await commentIds()).map((x) => x[0]));
  await page.keyboard.press("n");
  let s = await state(), lastK = 0, escAt = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const m = /\((\d+)\/(\d+)\)/.exec(s.toast);
    if (m && +m[1] !== lastK) { lastK = +m[1]; ticks.push([Date.now(), lastK]); }
    if (opts && opts.escAfter && lastK >= opts.escAfter && !escAt) { await page.keyboard.press("Escape"); escAt = loads.length; }
    if (!/Loading more comments/.test(s.toast) && Date.now() - t0 > 600) break;
    await page.waitForTimeout(150);
    s = await state();
  }
  await page.waitForTimeout(escAt ? 4000 : 800);
  s = await state();
  const added = (await commentIds()).filter((x) => !idsBefore.has(x[0])).map((x) => x[1]);
  const r = Object.assign({ loads: loads.length - before, searchLoads: lastK, afterEsc: escAt ? loads.length - escAt : null,
    statuses: loadStatus.slice(statusFrom).join(","), added: added.length, addedNewest: added.length ? Math.max(...added) : null }, s);
  console.log(`${label}:`, JSON.stringify(r));
  if (s.hiddenNew) fails.push(`${label}: ${s.hiddenNew} new comments hidden inside read folds`);
  if (s.badFolds.length) fails.push(`${label}: read folds under a read comment: ${s.badFolds.slice(0, 5).join(", ")}`);
  if (s.searching) fails.push(`${label}: "searching" mark left on ${s.searching} comments`);
  if (lastK > 10) fails.push(`${label}: ${lastK} loads in one press, want at most 10`);
  return r;
}
const checkPacing = (from) => {
  const t = ticks.slice(from);
  for (let i = 1; i < t.length; i++) if (t[i][1] === t[i - 1][1] + 1 && t[i][0] - t[i - 1][0] < 850) fails.push(`search loads ${t[i][0] - t[i - 1][0]} ms apart, want ≥ 1 s`);
};

// 3) last visit = the newest comment a fresh render shows (twice: the first screen moves
// on as comments come in), so new comments are only behind "load more". Press n until a
// search jumps to one or says why not.
const second = await visit(first.newest, { foldReadComments: true });
// (EARLIER = seconds before that: more of what's behind "load more" counts as new)
const EARLIER = parseInt(process.env.EARLIER || "0", 10) || 0;
const LAST = parseInt(process.env.LASTVISIT || "0", 10) || second.newest - EARLIER; // LASTVISIT=<unix s> pins it
const s0 = await visit(LAST);
console.log("last visit set to", LAST, "(2nd visit's newest of", second.comments, "comments:", second.newest + ")");
const r0 = await state();
console.log("revisit:", JSON.stringify(s0), JSON.stringify(r0));
if (!r0.foldread) fails.push("read folding didn't turn on");
await page.mouse.move(700, 450);
let searched = false, found = false;
const t1 = ticks.length;
for (let i = 1; i <= 8; i++) {
  // new comments already on screen: read past them (scroll just below the lowest), so n has to search
  await page.evaluate(() => {
    const vis = Array.from(document.querySelectorAll(".thing.comment.orr-new")).filter((t) => t.offsetParent !== null);
    const last = vis[vis.length - 1];
    if (last) window.scrollTo(0, scrollY + last.getBoundingClientRect().top + 10);
  });
  await page.waitForTimeout(1500); // let the scroll auto-loader settle
  const r = await pressN("n #" + i);
  if (r.searchLoads) searched = true;
  if (r.searchLoads && r.jumpedToNew) { found = true; break; }
  if (!r.jumpedToNew && !/press n again|No more new|No new comments|limiting/.test(r.toast)) fails.push(`n #${i}: no jump and no message (toast ${JSON.stringify(r.toast)})`);
  if (/No more new|No new comments|limiting/.test(r.toast)) break;
}
checkPacing(t1);
console.log(`search ran: ${searched}, found a new comment behind "load more": ${found}, 429s so far: ${n429}`);
if (!searched) console.log("note: every press found a new comment already on the page — the search didn't run here");
await page.screenshot({ path: path.join(outDir, "after-n.png") });

// 4) nothing new (last visit = now): a press spends its loads and says so; Esc stops the next
await visit(Math.floor(Date.now() / 1000));
const t2 = ticks.length;
const q1 = await pressN("nothing new, n");
if (!q1.searchLoads) fails.push("nothing new: n didn't search");
if (!/press n again|No new comments/.test(q1.toast)) fails.push(`nothing new: message ${JSON.stringify(q1.toast)}`);
checkPacing(t2);
const q2 = await pressN("nothing new, n then Esc", { escAfter: 2 });
if (q2.afterEsc == null) fails.push("Esc: search never got to its 2nd load");
else {
  if (q2.afterEsc > 1) fails.push(`Esc: ${q2.afterEsc} loads after stopping`); // one may already be in flight
  if (q2.searchLoads > 3) fails.push(`Esc: search went on to load ${q2.searchLoads}`);
  if (/Loading more comments/.test(q2.toast)) fails.push("Esc: search message still up");
}
console.log(`429s: ${n429}`);

// 5) the listing's "N new" badge is red
await page.goto("https://www.reddit.com/r/AskReddit/", { waitUntil: "domcontentloaded", timeout: 45000 });
await waitRebuilt("#siteTable .thing.link");
await setPrefs({ threadVisits: { [t3]: { t: first.newest, c: Math.max(0, count - 5) } } });
await page.reload({ waitUntil: "domcontentloaded" });
await waitRebuilt("#siteTable .thing.link");
const badge = await page.evaluate((t3) => {
  const a = document.querySelector(`#siteTable .thing.link[data-fullname="${t3}"] a.orr-newcount`);
  return a ? { text: a.textContent, color: getComputedStyle(a).color } : null;
}, t3);
console.log("badge:", JSON.stringify(badge));
if (!badge) console.log("note: thread not on the first AskReddit page any more — badge not checked");
else if (badge.color !== "rgb(255, 69, 0)") fails.push(`"N new" badge is ${badge.color}, want rgb(255, 69, 0)`);

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? "FAIL\n  " + fails.join("\n  ") : "PASS");
process.exit(fails.length ? 1 : 0);
