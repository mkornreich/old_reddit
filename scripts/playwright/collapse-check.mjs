// Issue #33 — collapsing comments, Firefox (temporary add-on), logged out, with a real pointer:
//  - "collapse all" next to the comment sort folds every top-level comment to one line, each
//    showing old reddit's "(N children)", and turns into "expand all", which undoes it;
//  - the line along a comment's left side lights up under the pointer, and a click on it
//    collapses that comment (a nested one folds only itself), keeping it on screen even when
//    its top had scrolled away; a click in the comment's text doesn't;
//  - after "collapse all", top-level comments loaded later (end of the page) arrive folded.
//   node collapse-check.mjs <ext-dir> <out-dir> [thread-url] [big-thread-url]   (CHROMIUM=1: Chromium build)
// (big thread: one with more top-level comments than the first page serves; default: the
//  top post of the week on r/AskReddit.)  Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, threadArg, bigArg] = process.argv.slice(2);
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
    let buf = "", step = 0;
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const c = buf.indexOf(":"); if (c < 0) return;
        const len = parseInt(buf.slice(0, c), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.slice(c + 1, c + 1 + len)); buf = buf.slice(c + 1 + len);
        if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
        else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
        else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error + ": " + msg.message)) : resolve(msg.addon); }
      }
    });
    sock.on("error", reject);
  });
}
for (let i = 0; !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const THREAD = threadArg || "https://www.reddit.com/r/ApplyingToCollege/comments/cnwczp/a_comprehensive_list_of_essay_editing_tools/";
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const page = await ctx.newPage();
await page.setViewportSize({ width: 1400, height: 900 });
const settle = (ms = 400) => page.waitForTimeout(ms);
const tops = () => page.evaluate(() => Array.from(document.querySelectorAll(".nestedlisting > .thing.comment")).map((t) => ({
  collapsed: t.classList.contains("collapsed"), kids: t.querySelectorAll(":scope > .child .thing.comment").length,
  nc: (() => { const n = t.querySelector(":scope > .entry .numchildren"); return n ? { text: n.textContent, shown: getComputedStyle(n).display !== "none" } : null; })(),
})));
const link = () => page.evaluate(() => { const a = document.querySelector(".commentarea a.orr-collapse-all"); return a ? { text: a.textContent, shown: !a.parentElement.hidden && a.offsetParent !== null } : null; });

await page.goto(THREAD, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".commentarea .thing.comment", { timeout: 30000 }).catch(() => {});
await settle(3000);

// 1) collapse all / expand all
let l = await link();
console.log("link:", JSON.stringify(l));
ok(l && l.shown && l.text === "collapse all", `"collapse all" link: ${JSON.stringify(l)}`);
let t = await tops();
ok(t.length >= 3, `only ${t.length} top-level comments`);
ok(t.every((x) => !x.collapsed), "some comments start collapsed");
ok(t.every((x) => !x.nc || !x.nc.shown), "(N children) shows on an open comment");
const listH = () => page.evaluate(() => document.querySelector(".nestedlisting").offsetHeight);
const h0 = await listH();
await page.click(".commentarea a.orr-collapse-all");
await settle();
t = await tops();
l = await link();
const h1 = await listH();
console.log("after collapse all:", JSON.stringify({ link: l, collapsed: t.filter((x) => x.collapsed).length, of: t.length, h0, h1, sample: t.filter((x) => x.nc).slice(0, 3).map((x) => x.nc.text) }));
ok(t.every((x) => x.collapsed), "collapse all left some open");
ok(l && l.text === "expand all", `after collapse all the link says ${JSON.stringify(l && l.text)}`);
ok(h1 < h0 / 2, `the comments only went from ${h0}px to ${h1}px tall`);
const withKids = t.filter((x) => x.kids > 0);
ok(withKids.length > 0 && withKids.every((x) => x.nc && x.nc.shown && /^\(\d+ child(ren)?\)$/.test(x.nc.text)), "a collapsed comment with replies has no visible (N children)");
ok(withKids.every((x) => parseInt(x.nc.text.slice(1), 10) >= x.kids), "(N children) is fewer than its loaded replies");
await page.screenshot({ path: path.join(outDir, "collapsed-all.png") });
await page.click(".commentarea a.orr-collapse-all");
await settle();
t = await tops();
l = await link();
ok(t.every((x) => !x.collapsed), "expand all left some collapsed");
ok(l && l.text === "collapse all", `after expand all the link says ${JSON.stringify(l && l.text)}`);

// 2) the thread line: scroll into a long top-level thread, hover its line, click it
const target = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll(".nestedlisting > .thing.comment"));
  const c = all.filter((t) => t.querySelector(":scope > .child .thing.comment")).sort((a, b) => b.offsetHeight - a.offsetHeight)[0];
  if (!c) return null;
  c.id = c.id || "orr-test-target";
  // scroll so the comment's top is 150px above the window (reading inside it)
  window.scrollTo({ top: window.scrollY + c.getBoundingClientRect().top + 150, behavior: "instant" });
  return { id: c.id, h: c.offsetHeight };
});
ok(target && target.h > 300, `no tall thread to test the line on: ${JSON.stringify(target)}`);
await settle(600);
if (target) {
  const pt = await page.evaluate((id) => {
    const c = document.getElementById(id), child = c.querySelector(":scope > .child");
    const r = c.getBoundingClientRect(), x = child.getBoundingClientRect().left;
    const y = Math.min(r.bottom - 20, window.innerHeight / 2);
    return { x: Math.round(x), y: Math.round(y), top: Math.round(r.top) };
  }, target.id);
  // a click in the comment's text (not on the line) does nothing
  await page.mouse.move(pt.x + 300, pt.y);
  await settle(200);
  const off = await page.evaluate(() => ({ line: !!document.getElementById("orr-tline") && getComputedStyle(document.getElementById("orr-tline")).display !== "none" }));
  ok(!off.line, "the line lights up away from it");
  await page.mouse.move(pt.x, pt.y, { steps: 3 });
  await settle(200);
  const hov = await page.evaluate(() => {
    const el = document.getElementById("orr-tline");
    const r = el && el.getBoundingClientRect();
    return { shown: !!el && getComputedStyle(el).display !== "none", hot: document.documentElement.classList.contains("orr-tline-hot"), rect: r && [Math.round(r.left), Math.round(r.top), Math.round(r.height)] };
  });
  console.log("hover:", JSON.stringify({ pt, hov }));
  ok(hov.shown && hov.hot && hov.rect[2] > 200, `hovering the line doesn't light it up: ${JSON.stringify(hov)}`);
  await page.screenshot({ path: path.join(outDir, "line-hover.png") });
  await page.mouse.click(pt.x, pt.y);
  await settle(900); // smooth scroll
  const after = await page.evaluate((id) => {
    const c = document.getElementById(id);
    return { collapsed: c.classList.contains("collapsed"), top: Math.round(c.getBoundingClientRect().top),
      lineGone: getComputedStyle(document.getElementById("orr-tline")).display === "none" };
  }, target.id);
  console.log("after line click:", JSON.stringify(after));
  ok(after.collapsed, "clicking the line didn't collapse the comment");
  ok(after.top >= 0 && after.top < 120, `the collapsed comment isn't on screen (top ${after.top})`);
  await page.screenshot({ path: path.join(outDir, "line-collapsed.png") });

  // a nested comment's line folds just that one
  await page.evaluate((id) => { const ex = document.getElementById(id).querySelector(":scope > .entry .expand"); ex.click(); }, target.id);
  await settle(300);
  const npt = await page.evaluate((id) => {
    const c = document.getElementById(id);
    const n = Array.from(c.querySelectorAll(":scope > .child > .thing.comment")).find((x) => x.querySelector(":scope > .child .thing.comment"));
    if (!n) return null;
    n.id = n.id || "orr-test-nested";
    window.scrollTo({ top: window.scrollY + n.getBoundingClientRect().top - 200, behavior: "instant" });
    const r = n.getBoundingClientRect(), x = n.querySelector(":scope > .child").getBoundingClientRect().left;
    return { id: n.id, x: Math.round(x), y: Math.round(Math.min(r.bottom - 10, r.top + 60)) };
  }, target.id);
  if (npt) {
    await settle(700);
    const p2 = await page.evaluate((id) => { const n = document.getElementById(id); const r = n.getBoundingClientRect(); return { x: Math.round(n.querySelector(":scope > .child").getBoundingClientRect().left), y: Math.round(Math.min(r.bottom - 10, r.top + 60)) }; }, npt.id);
    console.log("nested point:", JSON.stringify(p2), await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && (e.tagName + "." + e.className); }, [p2.x, p2.y]));
    await page.mouse.click(p2.x, p2.y);
    await settle(500);
    const n2 = await page.evaluate(([id, pid]) => ({ nested: document.getElementById(id).classList.contains("collapsed"), parent: document.getElementById(pid).classList.contains("collapsed") }), [npt.id, target.id]);
    console.log("nested line click:", JSON.stringify(n2));
    ok(n2.nested && !n2.parent, `a nested comment's line: ${JSON.stringify(n2)}`);
  } else console.log("(no nested comment with replies here — nested line not tested)");
}

// 3) after "collapse all", comments loaded at the end of the page arrive folded
let big = bigArg;
if (!big) {
  await page.goto("https://www.reddit.com/r/AskReddit/top/?t=week", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable .thing.link a.comments", { timeout: 30000 }).catch(() => {});
  big = await page.evaluate(() => { const a = document.querySelector("#siteTable .thing.link a.comments"); return a && a.href; });
}
console.log("big thread:", big);
if (big) {
  await page.goto(big, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".commentarea .thing.comment", { timeout: 30000 }).catch(() => {});
  await settle(3000);
  await page.click(".commentarea a.orr-collapse-all");
  await settle();
  const n0 = (await tops()).length;
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await settle(2500);
    if ((await tops()).length > n0) break;
  }
  t = await tops();
  console.log("loaded more:", JSON.stringify({ before: n0, after: t.length, open: t.filter((x) => !x.collapsed).length }));
  ok(t.length > n0, `no more top-level comments loaded at the end (${n0})`);
  ok(t.every((x) => x.collapsed), `${t.filter((x) => !x.collapsed).length} comments loaded after "collapse all" arrived open`);
  l = await link();
  ok(l && l.text === "expand all", `link says ${JSON.stringify(l && l.text)} after more loaded`);
}

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? "FAIL\n  " + fails.join("\n  ") : "PASS");
process.exit(fails.length ? 1 : 0);
