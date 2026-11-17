// Google's "Sign in to Reddit with Google" prompt (One Tap) stays off the rebuilt page
// (2026-11-17: Reddit's scripts, still running underneath, opened it in the bottom-left
// corner for logged-out visitors, from about the second page on). Logged out, Firefox
// (temporary add-on) or Chromium. Opens several pages in a row, scrolling each, and:
//  - where Google's prompt was asked for (its /gsi/iframe/select page loaded), it never
//    showed (sampled every 100 ms) and no page ends with it on it, shown or hidden;
//  - Google shows it only on some visits, so on the first page: a stand-in put up the way
//    its library does is taken off at once, never shown;
//  - on that page, a request for the browser's own sign-in prompt (Chrome's FedCM, how
//    Reddit's Google script asks there) is refused; on Reddit's login page (not rebuilt)
//    it's left to the browser;
//  - the prompt was asked for at least once (else the live part proves nothing: say so).
// (In Chrome it's the browser's own popup, outside the page — no-google-prompt.js refuses
// the request for it; with no Google account signed in to the test browser, none shows.)
//   node onetap-check.mjs <ext-dir> <out-dir> [<url> …]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, ...argUrls] = process.argv.slice(2);
const urls = argUrls.length ? argUrls : [
  "https://www.reddit.com/r/SubredditDrama/top/",
  "https://www.reddit.com/r/SubredditDrama/top/?t=month",
  "https://www.reddit.com/r/AskHistorians/",
  "https://www.reddit.com/r/LosAngeles/",
];
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
// before Reddit's scripts: note every time Google's prompt box goes onto the page
await ctx.addInitScript(() => {
  const SEL = "#credential_picker_container, #credential_picker_iframe, iframe[src*='accounts.google.com/gsi/iframe']";
  const st = window.__orrOneTap = { added: 0, shownMs: 0 };
  const watch = () => new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType === 1 && (n.id === "credential_picker_container" || n.id === "credential_picker_iframe")) st.added++;
  }))).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) watch(); else document.addEventListener("readystatechange", watch, { once: true });
  // Google's script asking the browser itself for its prompt (Chrome's FedCM) and what it got
  // back: wrapped once the page is parsed, outside the add-on's own wrapper (no-google-prompt.js,
  // in place from the start), before Google's script loads
  window.__orrFedcm = [];
  document.addEventListener("readystatechange", () => {
    const c = navigator.credentials;
    if (!c || !c.get) return;
    const inner = c.get;
    c.get = function (o) {
      const p = inner.apply(this, arguments);
      if (o && o.identity) {
        const rec = { outcome: "pending" };
        window.__orrFedcm.push(rec);
        p.then(() => { rec.outcome = "resolved"; }, (e) => { rec.outcome = e.name + ": " + e.message; });
      }
      return p;
    };
  }, { once: true });
  // how long it was on screen: sampled every 100 ms
  setInterval(() => {
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") { st.shownMs += 100; break; }
    }
  }, 100);
});
let asked = 0, standIn = false;
// a request for the browser's own sign-in prompt (Chrome's FedCM, what Reddit's Google script
// makes there), from the page's world: refused by the add-on? (else whatever the browser says)
const askBrowser = () => page.evaluate(() => Promise.race([
  navigator.credentials.get({ identity: { providers: [{ configURL: "https://accounts.google.com/gsi/fedcm/config/passive.json", clientId: "x" }], mode: "passive" }, mediation: "optional" })
    .then(() => "resolved", (e) => e.name + ": " + e.message),
  new Promise((r) => setTimeout(() => r("still waiting"), 3000)),
]));
for (const url of urls) {
  const tag = url.replace("https://www.reddit.com", "");
  let selects = 0;
  const onReq = (r) => { if (/accounts\.google\.com\/gsi\/iframe\/select/.test(r.url())) selects++; };
  page.on("request", onReq);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(1500); }
  await page.waitForTimeout(+(process.env.WAIT || 12000));
  page.off("request", onReq);
  const s = await page.evaluate(() => ({
    rebuilt: document.documentElement.classList.contains("orr-rebuilt"),
    captcha: /Prove your humanity/i.test((document.body && document.body.innerText) || ""),
    added: (window.__orrOneTap || {}).added || 0,
    shownMs: (window.__orrOneTap || {}).shownMs || 0,
    present: !!document.querySelector("#credential_picker_container, #credential_picker_iframe, iframe[src*='accounts.google.com/gsi/iframe']"),
    gsi: !!(window.google && window.google.accounts && window.google.accounts.id),
    fedcm: (window.__orrFedcm || []).map((r) => r.outcome),
  }));
  console.log(`  ${tag}: ${JSON.stringify(s)}, prompt pages loaded: ${selects}`);
  if (s.captcha || !s.rebuilt) { ok(false, `${tag}: ${s.captcha ? "Reddit showed its CAPTCHA" : "page wasn't rebuilt"} — not tested`); continue; }
  if (s.fedcm.length) {
    asked++;
    // refused by the add-on — or by a browser with no such prompt of its own (Firefox: "not supported")
    ok(s.fedcm.every((o) => /Classic Layout for Reddit|^NotSupportedError/.test(o)),
      `${tag}: Google's script asked the browser for its prompt ${s.fedcm.length}×, refused every time (${[...new Set(s.fedcm)].join("; ")})`);
  }
  if (selects || s.added) {
    asked++;
    ok(s.shownMs === 0 && !s.present, `${tag}: Google's prompt (put up ${s.added}×) never showed (on screen ${s.shownMs} ms) and isn't left on the page`);
  } else if (!s.fedcm.length) {
    ok(!s.present && s.shownMs === 0, `${tag}: no Google prompt on the page (not asked for here)`);
  }
  await page.screenshot({ path: path.join(outDir, tag.replace(/[^\w]+/g, "_").slice(0, 60) + ".png") });
  if (standIn) continue;
  standIn = true; // the first page that rebuilt:
  // Google shows its prompt only on some visits, so also put up a stand-in the way its
  // library does (a box at the end of <body> holding an iframe) and see it go
  const t0 = await page.evaluate(() => window.__orrOneTap.shownMs);
  await page.evaluate(() => {
    const box = document.createElement("div");
    box.id = "credential_picker_container";
    box.style.cssText = "position:fixed;left:0;bottom:0;width:300px;height:150px;background:#fff;border:1px solid #888;z-index:9999";
    const f = document.createElement("iframe");
    f.title = "Sign in with Google Dialog";
    f.style.cssText = "width:300px;height:150px;border:0";
    box.appendChild(f);
    document.body.appendChild(box);
  });
  await page.waitForTimeout(1000);
  const f = await page.evaluate(() => ({ present: !!document.getElementById("credential_picker_container"), shownMs: window.__orrOneTap.shownMs }));
  ok(!f.present && f.shownMs === t0, `${tag}: a stand-in for Google's prompt is taken off at once, never shown (on screen ${f.shownMs - t0} ms, still there: ${f.present})`);
  const fed = await askBrowser();
  ok(/Classic Layout for Reddit/.test(fed), `${tag}: a request for the browser's own sign-in prompt is refused (${fed})`);
}
// Reddit's own login page isn't rebuilt: the request goes to the browser as usual
await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(4000);
const login = await page.evaluate(() => ({ rebuilt: document.documentElement.classList.contains("orr-rebuilt"), captcha: /Prove your humanity/i.test((document.body && document.body.innerText) || "") }));
if (login.captcha) ok(false, "/login/: Reddit showed its CAPTCHA — not tested");
else {
  const fed = await askBrowser();
  ok(!login.rebuilt && !/Classic Layout for Reddit/.test(fed), `/login/ (not rebuilt): the request is left to the browser (${fed})`);
}
ok(standIn, "a page rebuilt, so the stand-in and browser-prompt steps ran");
ok(asked > 0, `Google's prompt was asked for ${asked}× on ${urls.length} pages (0 = this run proves nothing; run it again)`);

await ctx.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
