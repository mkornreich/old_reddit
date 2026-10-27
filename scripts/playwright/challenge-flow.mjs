// Timeline of a first visit in stock Firefox with the extension: document responses (and
// their CSP), navigations, and what the page shows every half second.
import "./hidden-display.mjs";
import { firefox } from "playwright";
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [ffBin, extDir, url, privateMode] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-cf-"));
if (privateMode) fs.writeFileSync(path.join(profile, "extension-preferences.json"), JSON.stringify({ "old-reddit-redirect@extension.local": { permissions: ["internal:privateBrowsingAllowed"], origins: [] } }));
const PORT = 6000 + Math.floor(Math.random() * 1000);
const ctx = await firefox.launchPersistentContext(profile, Object.assign({ headless: false, viewport: { width: 1300, height: 900 }, args: ["--start-debugger-server=" + PORT],
  firefoxUserPrefs: Object.assign({ "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false, "browser.shell.checkDefaultBrowser": false }, privateMode ? { "browser.privatebrowsing.autostart": true } : {}) },
  ffBin && ffBin !== "-" ? { channel: "moz-firefox", executablePath: ffBin } : {}));
const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
const install = () => new Promise((resolve, reject) => {
  const sock = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0), step = 0;
  const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); for (;;) { const c = buf.indexOf(58); if (c < 0) return; const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return; const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); } else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: path.resolve(extDir) }); } else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); } } });
  sock.on("error", reject);
});
for (let i = 0; i < 20; i++) { try { await install(); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const page = ctx.pages()[0] || await ctx.newPage();
page.on("response", (r) => { const rt = r.request().resourceType(); const u = r.url(); if (rt === "document" || /\.json|\/svc\/shreddit\/(community-more|feeds|search)/.test(u)) console.log(T(), "RES", rt, r.status(), u.replace("https://www.reddit.com", "").slice(0, 80), (r.headers()["content-security-policy"] || "").slice(0, 70)); });
page.on("requestfailed", (r) => { if (/reddit\.com/.test(r.url())) console.log(T(), "FAILED", r.resourceType(), r.url().replace("https://www.reddit.com", "").slice(0, 70), (r.failure() || {}).errorText); });
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log(T(), "NAV", f.url().slice(0, 80)); });
page.on("pageerror", (e) => console.log(T(), "PAGEERR", String(e.message).slice(0, 160)));
await page.goto(url, { waitUntil: "commit", timeout: 45000 }).catch((e) => console.log("goto", String(e).slice(0, 100)));
let last = "";
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => ({ title: document.title.slice(0, 30), rebuilt: document.documentElement.classList.contains("orr-rebuilt"), shreddit: !!document.querySelector("shreddit-app"), challenge: /prove your humanity|verify|human/i.test((document.body && document.body.innerText || "").slice(0, 500)), bodies: document.querySelectorAll("body").length, text: (document.body && document.body.innerText || "").replace(/\s+/g, " ").slice(0, 60) })).catch((e) => ({ err: String(e).slice(0, 60) }));
  const k = JSON.stringify(s); if (k !== last) { console.log(T(), "STATE", k); last = k; }
}
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
