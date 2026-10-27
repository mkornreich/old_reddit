// When a first load can't be rebuilt, the page is left to new Reddit — and new Reddit then
// moves between pages without reloading (its own router), so the extension used to stay
// out of every page clicked to from there ("sometimes I see new Reddit"). Fakes one failed
// load (the listing feed answers 403 once), then checks: the fallback says why in the
// console; moving to another subreddit in new Reddit's own page gets rebuilt; that took no
// full page load (new Reddit's router did it).
//   node fallback-retry.mjs <ext-dir> [--firefox]
// (--firefox: Playwright's Firefox with the add-on installed over RDP; stage the
//  extension with `stage-ext.mjs … --firefox` for that)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium, firefox } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "--firefox");
const useFirefox = process.argv.includes("--firefox");
const [extDir] = args;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const PORT = 6000 + Math.floor(Math.random() * 1000);
let ctx;
if (useFirefox) {
  ctx = await firefox.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1300, height: 900 }, args: ["-start-debugger-server", String(PORT)],
    firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false },
  });
  const install = () => new Promise((resolve, reject) => {
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
        else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: path.resolve(extDir) }); }
        else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); }
      }
    });
    sock.on("error", reject);
  });
  for (let i = 0; i < 20; i++) { try { await install(); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
} else {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: false, viewport: { width: 1300, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
  });
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
}
let failFeed = 1; // the first listing feed request fails
await ctx.route(/\/svc\/shreddit\/community-more-posts\//, (route) => {
  if (failFeed > 0) { failFeed--; return route.fulfill({ status: 403, contentType: "text/html", body: "<html><body>blocked</body></html>" }); }
  return route.continue();
});
const page = await ctx.newPage();
const docs = [], consoleMsgs = [], errors = [];
page.on("request", (r) => { if (r.resourceType() === "document" && r.frame() === page.mainFrame()) docs.push(r.url().replace("https://www.reddit.com", "")); });
page.on("console", (m) => { if (/Classic Layout for Reddit/.test(m.text())) consoleMsgs.push(m.text()); });
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const state = () => page.evaluate(() => ({ url: location.pathname, app: !!document.querySelector("shreddit-app"), title: document.title.slice(0, 30), rebuilt: document.documentElement.classList.contains("orr-rebuilt") && !!document.getElementById("siteTable"), things: document.querySelectorAll("#siteTable > .thing.link").length, sub: (document.querySelector("#siteTable > .thing.link") || { dataset: {} }).dataset.subreddit || "" }));

await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(5000);
const s0 = await state();
check("the failed load is left to new Reddit", !s0.rebuilt, JSON.stringify(s0));
check("…and the console says why", consoleMsgs.some((m) => /couldn't load the listing \(HTTP 403\)/.test(m)), JSON.stringify(consoleMsgs));
// new Reddit's own in-page navigation (its router handles a same-origin link click)
const docsBefore = docs.length;
// (a same-document navigation new Reddit's router takes; a link click where it doesn't)
await page.evaluate(() => {
  if (typeof navigation !== "undefined" && navigation.navigate) { navigation.navigate("/r/AskReddit/"); return; }
  const a = document.createElement("a"); a.href = "/r/AskReddit/"; a.textContent = "go"; document.body.appendChild(a); a.click();
});
await page.waitForFunction(() => document.documentElement.classList.contains("orr-rebuilt") && document.querySelectorAll("#siteTable > .thing.link").length > 0, null, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const s1 = await state();
check("moving to another subreddit in new Reddit gets rebuilt", s1.rebuilt && s1.url === "/r/AskReddit/" && s1.things > 0, JSON.stringify(s1));
console.log("document loads after the click:", JSON.stringify(docs.slice(docsBefore)));
// (only if new Reddit's app — and so its router — was there: automated Chromium can be
// handed Reddit's "Prove your humanity" page instead, which navigates for real)
if (s0.app) check("…by new Reddit's own in-page navigation (no full page load)", docs.length === docsBefore, JSON.stringify(docs.slice(docsBefore)));
else console.log("(skipped the in-page check: the fallen-back page wasn't new Reddit's app — " + s0.title + ")");
// and from there on, the extension owns navigation again
await page.evaluate(() => { const a = document.createElement("a"); a.href = "/r/pics/"; a.id = "orr-test-back"; a.textContent = "pics"; document.querySelector(".content").prepend(a); });
await page.click("#orr-test-back");
await page.waitForTimeout(4000);
const s2 = await state();
check("then the extension's own navigation works again", s2.rebuilt && s2.url === "/r/pics/" && s2.things > 0, JSON.stringify(s2));
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
