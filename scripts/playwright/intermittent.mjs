// Many page loads in one Firefox session (like browsing), with the extension: which loads
// end up as new Reddit, and what Reddit served on those (documents + CSP, API responses).
//   node intermittent.mjs <firefox-binary|-> <ext-dir> <rounds> [private]
import "./hidden-display.mjs";
import { firefox } from "playwright";
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [ffBin, extDir, roundsArg = "2", privateMode] = process.argv.slice(2);
const URLS = ["https://www.reddit.com/", "https://www.reddit.com/r/pics/", "https://www.reddit.com/r/AskReddit/", "https://www.reddit.com/r/technology/top/?t=day",
  "https://www.reddit.com/r/sysadmin/comments/1x8cycd/namecheap_just_seized_and_disabled_all_my_domains/", "https://www.reddit.com/r/worldnews/", "https://www.reddit.com/r/gaming/new/",
  "https://www.reddit.com/r/Android/", "https://www.reddit.com/user/spez/", "https://www.reddit.com/r/movies/"];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-im-"));
if (privateMode) fs.writeFileSync(path.join(profile, "extension-preferences.json"), JSON.stringify({ "old-reddit-redirect@extension.local": { permissions: ["internal:privateBrowsingAllowed"], origins: [] } }));
const PORT = 6000 + Math.floor(Math.random() * 1000);
const ctx = await firefox.launchPersistentContext(profile, Object.assign({ headless: false, viewport: { width: 1300, height: 900 }, args: ["--start-debugger-server=" + PORT],
  firefoxUserPrefs: Object.assign({ "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false, "browser.shell.checkDefaultBrowser": false }, privateMode ? { "browser.privatebrowsing.autostart": true } : {}) },
  ffBin && ffBin !== "-" ? { channel: "moz-firefox", executablePath: ffBin } : {}));
const install = () => new Promise((resolve, reject) => {
  const sock = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0), step = 0;
  const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); for (;;) { const c = buf.indexOf(58); if (c < 0) return; const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return; const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); } else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: path.resolve(extDir) }); } else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); } } });
  sock.on("error", reject);
});
for (let i = 0; i < 20; i++) { try { await install(); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const page = ctx.pages()[0] || await ctx.newPage();
let log = [];
const t0 = { v: Date.now() };
const T = () => ((Date.now() - t0.v) / 1000).toFixed(1) + "s";
page.on("response", (r) => { const rt = r.request().resourceType(); const u = r.url(); if (/^https:\/\/www\.reddit\.com/.test(u) && (rt === "document" || /\.json|\/svc\/shreddit\/(community-more|feeds|profiles|community-hover|subreddit-right)/.test(u) || r.status() >= 300)) log.push(T() + " " + rt + " " + r.status() + " " + u.replace("https://www.reddit.com", "").slice(0, 90) + (rt === "document" ? " csp=" + (r.headers()["content-security-policy"] || "").slice(0, 25) : "")); });
page.on("requestfailed", (r) => { if (/www\.reddit\.com/.test(r.url())) log.push(T() + " FAILED " + r.resourceType() + " " + r.url().replace("https://www.reddit.com", "").slice(0, 70) + " " + ((r.failure() || {}).errorText || "")); });
page.on("framenavigated", (f) => { if (f === page.mainFrame()) log.push(T() + " NAV " + f.url().replace("https://www.reddit.com", "").slice(0, 90)); });
page.on("pageerror", (e) => log.push(T() + " PAGEERR " + String(e.message).slice(0, 150)));
page.on("console", (m) => { if (/orr|old reddit|rebuild/i.test(m.text())) log.push(T() + " CONSOLE " + m.text().slice(0, 150)); });
const results = [];
for (let round = 0; round < parseInt(roundsArg, 10); round++) {
  for (const u of URLS) {
    log = []; t0.v = Date.now();
    await page.goto(u, { waitUntil: "commit", timeout: 45000 }).catch((e) => log.push("goto " + String(e).slice(0, 80)));
    let st = null;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(500);
      st = await page.evaluate(() => ({ rebuilt: document.documentElement.classList.contains("orr-rebuilt"), shreddit: !!document.querySelector("shreddit-app"), title: document.title.slice(0, 40), url: location.pathname + location.search.slice(0, 40), things: document.querySelectorAll("#siteTable > .thing, .commentarea .thing.comment").length, text: (document.body && document.body.innerText || "").replace(/\s+/g, " ").slice(0, 80) })).catch((e) => ({ err: String(e).slice(0, 60) }));
      if (st && st.rebuilt && st.things > 0 && i >= 4) break;
    }
    const ok = st && st.rebuilt && st.things > 0;
    results.push({ round, u: u.replace("https://www.reddit.com", ""), ok, t: T() });
    console.log((ok ? "OK   " : "FAIL ") + round + " " + u.replace("https://www.reddit.com", "").slice(0, 60) + " " + T() + (ok ? "" : " " + JSON.stringify(st)));
    if (!ok) { log.forEach((l) => console.log("      " + l)); await page.screenshot({ path: path.join(os.tmpdir(), "orr-fail-" + round + "-" + results.length + ".png") }).catch(() => {}); }
  }
}
console.log("SUMMARY", results.filter((r) => r.ok).length + "/" + results.length + " rebuilt");
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
