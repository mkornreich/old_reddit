// An interactive Reddit app post (Devvit: games, maps, polls…) works on the rebuilt page
// (2026-11-17: r/whereidlive's map posts only said "open it on Reddit", which showed new
// Reddit). Logged out, Firefox (temporary add-on) or Chromium:
//  - the thread page, loaded directly: old reddit's page (header, sort bar, comments) with the
//    app running in the post — Reddit's own element, its frame from *.devvit.net at the app's
//    height — and the "open it on Reddit" note hidden; the app answers a click (its expanded
//    view opens), styled with Reddit's design variables inside the app's box only;
//  - the same thread reached in-page from a listing that had no app (Reddit's code for apps
//    not loaded yet): the app still starts;
//  - a listing of app posts: opening one's preview starts its app, or shows the note;
//  - the post with #orr-native (the note's "Open it on Reddit"): Reddit's own page, untouched,
//    with Reddit's own app running.
//   node app-check.mjs <ext-dir> <out-dir> [<app post url>]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, appUrl = "https://www.reddit.com/r/whereidlive/comments/1xyytze/where_id_live_as_a_black_solo_polyamorus_hijabi/"] = process.argv.slice(2);
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
const appState = () => page.evaluate(() => {
  const s = document.querySelector("#siteTable devvit2-surface");
  const r = s && s.getBoundingClientRect();
  const frames = [];
  const walk = (root) => {
    root.querySelectorAll("iframe").forEach((f) => { if (/devvit\.net/.test(f.src)) { const b = f.getBoundingClientRect(); frames.push({ src: f.src.slice(0, 90), w: Math.round(b.width), h: Math.round(b.height) }); } });
    root.querySelectorAll("*").forEach((e) => e.shadowRoot && walk(e.shadowRoot));
  };
  const st = document.getElementById("siteTable");
  if (st && document.documentElement.classList.contains("orr-rebuilt")) walk(st); // (only the rebuilt post: Reddit's own page, under it until the rebuild, runs the app too)
  const note = document.querySelector("#siteTable .orr-app-note");
  return {
    rebuilt: document.documentElement.classList.contains("orr-rebuilt"),
    captcha: /Prove your humanity/i.test((document.body && document.body.innerText) || ""),
    oldHeader: !!document.querySelector("#header #header-bottom-left"),
    sortBar: !!document.querySelector(".commentarea > .menuarea"),
    comments: document.querySelectorAll(".commentarea .thing.comment").length,
    defined: s ? s.matches(":defined") : null,
    surface: r ? [Math.round(r.width), Math.round(r.height)] : null,
    frames,
    noteShown: note ? !note.hidden : null,
  };
});
const waitApp = async (ms = 25000) => {
  let s;
  for (let t = 0; t < ms; t += 1000) { s = await appState(); if (s.captcha || (s.rebuilt && ((s.frames.length && s.frames[0].h >= 300) || s.noteShown))) break; await page.waitForTimeout(1000); }
  return s;
};
const appFrame = () => page.frames().filter((f) => /devvit\.net/.test(f.url()) && !f.isDetached()).pop();

// 1) the thread page, loaded directly
await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
let s = await waitApp(40000);
await page.waitForTimeout(1500); // (the app's own start)
console.log("  direct:", JSON.stringify(s));
// (Reddit's own code on the page? Not when the page it sent was its bot check — the test
// Chromium gets that on its first page — then nothing can start the app: the note shows)
const runtime = await page.evaluate(() => !!customElements.get("faceplate-loader"));
if (s.captcha) ok(false, "direct: Reddit showed its CAPTCHA — not tested");
else if (!runtime) {
  console.log("  (Reddit's own page was its bot check here: no Reddit code to start the app — the app part of this step isn't tested)");
  ok(s.rebuilt && s.comments > 0 && s.noteShown === true, `direct, no Reddit code on the page: old reddit's page with the "open it on Reddit" note (${JSON.stringify({ comments: s.comments, note: s.noteShown })})`);
} else {
  ok(s.rebuilt && s.oldHeader && s.sortBar && s.comments > 0, `direct: old reddit's page — header, sort bar, ${s.comments} comments`);
  ok(s.defined && s.frames.length === 1 && s.frames[0].h >= 400 && s.frames[0].w >= 300 && s.noteShown === false,
    `direct: the app runs in the post at its height, the note hidden (${JSON.stringify({ frames: s.frames, surface: s.surface, note: s.noteShown })})`);
  await page.locator("#siteTable .orr-app").scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(outDir, "direct.png") });
  // the app answers: its "LIST" button opens its expanded view (a dialog over the page)
  const fr = appFrame();
  if (fr) {
    const t0 = await fr.evaluate(() => document.body.innerText).catch(() => "");
    await fr.getByText("LIST", { exact: false }).first().click({ timeout: 5000 }).catch((e) => console.log("  (click: " + e.message.split("\n")[0] + ")"));
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(outDir, "after-list.png") });
    const fr2 = appFrame();
    const t1 = await (fr2 || fr).evaluate(() => document.body.innerText).catch(() => "");
    console.log("  app text before/after LIST:", JSON.stringify(t0.slice(0, 80)), "→", JSON.stringify(t1.slice(0, 160)));
    ok(t1 && t1 !== t0, "direct: the app answers a click (its LIST button opens its expanded view)");
    // Reddit's design variables (its stylesheet is gone from the rebuilt page) style the
    // app's own parts, inside the app's box only
    const tok = await page.evaluate(() => {
      const box = document.querySelector("#siteTable .orr-app");
      return { app: box ? getComputedStyle(box).getPropertyValue("--color-neutral-background").trim() : "", page: getComputedStyle(document.body).getPropertyValue("--color-neutral-background").trim() };
    });
    ok(!!tok.app && !tok.page, `direct: Reddit's design variables inside the app's box, not on the page (${JSON.stringify(tok)})`);
  } else ok(false, "direct: the app's frame is reachable");
}

// 2) reached in-page from a listing with no app (Reddit's code for apps not loaded there)
await page.goto("https://www.reddit.com/r/technology/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const pre = await page.evaluate((u) => {
  window.__orrSameDoc = 1; // (gone after a full page load)
  const a = document.createElement("a");
  a.id = "orr-check-applink"; a.href = new URL(u).pathname; a.textContent = "the app post";
  document.getElementById("siteTable").prepend(a);
  return { rebuilt: document.documentElement.classList.contains("orr-rebuilt"), appCode: !!customElements.get("devvit2-surface") };
}, appUrl);
if (!pre.rebuilt) ok(false, "in-page: r/technology wasn't rebuilt (CAPTCHA?) — not tested");
else {
  await page.click("#orr-check-applink");
  await page.waitForSelector(".commentarea", { timeout: 30000 }).catch(() => {});
  s = await waitApp();
  const same = await page.evaluate(() => window.__orrSameDoc === 1);
  s.tokens = await page.evaluate(() => { const b = document.querySelector("#siteTable .orr-app"); return b ? getComputedStyle(b).getPropertyValue("--rem16").trim() : ""; });
  console.log("  in-page:", JSON.stringify({ appCodeBefore: pre.appCode, sameDoc: same, ...s }));
  ok(same && s.rebuilt && s.comments > 0 && s.defined && s.frames.length === 1 && s.frames[0].h >= 400 && s.noteShown === false,
    `in-page (Reddit's app code ${pre.appCode ? "already" : "not yet"} loaded): the app runs (${JSON.stringify({ sameDoc: same, frames: s.frames, note: s.noteShown })})`);
  ok(!!s.tokens, `in-page: Reddit's design variables (read on the first page) inside the app's box (--rem16: "${s.tokens}")`);
  await page.locator("#siteTable .orr-app").scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(outDir, "inpage.png") });
}

// 3) a listing of app posts: open the first one's preview
const sub = new URL(appUrl).pathname.split("/comments/")[0] + "/";
await page.goto("https://www.reddit.com" + sub, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const L0 = await page.evaluate(() => {
  const t = Array.from(document.querySelectorAll("#siteTable > .thing.link")).find((x) => x.querySelector(".orr-app, .orr-app-note"));
  if (!t) return null;
  const b = t.querySelector(".expando-button");
  t.scrollIntoView({ block: "start" });
  return { id: t.id, withApp: !!t.querySelector(".orr-app[data-orr-app-init]"), started: !!t.querySelector("devvit2-surface"), button: !!b };
});
console.log("  listing:", JSON.stringify(L0));
if (!L0) ok(false, `${sub}: an app post in the listing`);
else {
  ok(!L0.started, `${sub}: a closed preview doesn't start its app`);
  if (L0.button) await page.click(`#${L0.id} .expando-button`);
  let L1;
  for (let t = 0; t < 20000; t += 1000) {
    await page.waitForTimeout(1000);
    L1 = await page.evaluate((id) => {
      const t = document.getElementById(id);
      const f = []; const walk = (r) => { r.querySelectorAll("iframe").forEach((x) => { if (/devvit\.net/.test(x.src)) f.push(Math.round(x.getBoundingClientRect().height)); }); r.querySelectorAll("*").forEach((e) => e.shadowRoot && walk(e.shadowRoot)); }; walk(t);
      const note = t.querySelector(".orr-app-note");
      return { frames: f, note: !!note && !note.hidden && !!note.offsetParent };
    }, L0.id);
    if ((L1.frames[0] || 0) >= 300 || (L1.note && !L0.withApp)) break;
  }
  console.log("  listing opened:", JSON.stringify(L1));
  ok(L0.withApp ? (L1.frames[0] || 0) >= 300 : L1.note, `${sub}: opening the preview ${L0.withApp ? "starts the app" : "shows the note (the listing doesn't carry the app)"} (${JSON.stringify(L1)})`);
  await page.screenshot({ path: path.join(outDir, "listing.png") });
}

// 4) the escape hatch: the post with #orr-native ("Open it on Reddit") is Reddit's own page,
// untouched — nothing hidden, rebuilt or restyled — with Reddit's own app in it
await page.goto("about:blank"); // (a fresh load, not a same-page hash change)
await page.goto(appUrl.replace(/#.*$/, "") + "#orr-native", { waitUntil: "domcontentloaded", timeout: 45000 });
let N;
for (let t = 0; t < 30000; t += 1000) {
  await page.waitForTimeout(1000);
  N = await page.evaluate(() => {
    const frames = [];
    const walk = (root) => { root.querySelectorAll("iframe").forEach((f) => { if (/devvit\.net/.test(f.src)) frames.push(Math.round(f.getBoundingClientRect().height)); }); root.querySelectorAll("*").forEach((e) => e.shadowRoot && walk(e.shadowRoot)); };
    walk(document);
    const post = document.querySelector("shreddit-post");
    return {
      hash: location.hash,
      captcha: /Prove your humanity/i.test((document.body && document.body.innerText) || ""),
      // anything of the add-on's: an orr- class on <html>, an element with an orr- id or class,
      // old reddit's header
      ours: Array.from(document.documentElement.classList).filter((c) => c.startsWith("orr-"))
        .concat(Array.from(document.querySelectorAll("[id^='orr-'], [class^='orr-'], [class*=' orr-']")).slice(0, 5).map((e) => e.tagName.toLowerCase() + "#" + e.id + "." + String(e.className).slice(0, 30)))
        .concat(document.getElementById("header") ? ["#header"] : []),
      visible: getComputedStyle(document.documentElement).visibility === "visible",
      redditPost: !!post && post.getBoundingClientRect().height > 100,
      redditCss: !!document.querySelector("link[rel=stylesheet][href*='redditstatic.com/shreddit/']"),
      appFrames: frames,
    };
  });
  if (N.captcha || (N.redditPost && N.appFrames.some((h) => h >= 300))) break;
}
console.log("  #orr-native:", JSON.stringify(N));
if (N.captcha) ok(false, "#orr-native: Reddit showed its CAPTCHA — not tested");
else {
  ok(N.hash === "#orr-native" && N.ours.length === 0 && N.visible && N.redditPost && N.redditCss,
    `#orr-native: Reddit's own page, nothing of the add-on's on it (${JSON.stringify({ ours: N.ours, visible: N.visible, post: N.redditPost, css: N.redditCss })})`);
  ok(N.appFrames.some((h) => h >= 300), `#orr-native: Reddit's own app runs in it (frames ${JSON.stringify(N.appFrames)})`);
}
await page.screenshot({ path: path.join(outDir, "native.png") });

await ctx.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
