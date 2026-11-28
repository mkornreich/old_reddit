// A first visit to a subreddit with its own style (2026-11-28): when do the page's own fetch,
// old reddit's page for the subreddit, its stylesheet and its header picture arrive, against
// when the page shows (SHOWN), takes the style (THEMED) and has the header picture in — and
// where the post is at each (any change after SHOWN is the page jumping). Until v3.17.30 the
// style came with the sidebar after the page showed: on r/AskReddit the post moved 72→132.
// Firefox (temporary add-on) or Chromium (CHROMIUM=1), logged out, fresh profile. WARM=<url>
// opens that first (Reddit's front page: passes Reddit's first-visit browser check, which
// otherwise runs on the page measured). It reports; no pass or fail.
//   WARM=https://www.reddit.com/ node theme-probe.mjs <ext-dir> <url>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [extDir, url] = process.argv.slice(2);
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-tp-"));
const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"] })
  : await firefox.launchPersistentContext(profile, { headless: false, viewport: { width: 1400, height: 900 }, args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false } });
function rdpInstall(dir) { return new Promise((resolve, reject) => { const sock = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0), step = 0;
  const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); for (;;) { const c = buf.indexOf(58); if (c < 0) return; const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
    const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); } else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
    else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); } } }); sock.on("error", reject); }); }
for (let i = 0; !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const page = await ctx.newPage();
if (process.env.WARM) { // pass Reddit's first-visit browser check elsewhere first (no subreddit look there)
  await page.goto(process.env.WARM, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(3000); await page.goto("about:blank");
}
const t0 = Date.now(); const ev = [];
const kind = (u) => /\+\w+\/?$|%2B/.test(u) && /\/r\//.test(u) ? "oldsub" : /\.css(\?|$)|stylesheet/.test(u) ? "css" : /thumbs\.redditmedia|styles\.redditmedia|redditstatic.*header/.test(u) ? "img" : /\/comments\//.test(u) && !/more-comments/.test(u) ? "thread" : null;
page.on("request", (r) => { const k = kind(r.url()); if (k) ev.push([Date.now() - t0, k + " start", r.url().slice(0, 90)]); });
page.on("response", (r) => { if (kind(r.url()) === "oldsub") ev.push([Date.now() - t0, "oldsub resp", r.status() + " " + (r.headers()["location"] || "") + " " + (r.headers()["content-type"] || "")]); });
page.on("requestfinished", (r) => { const k = kind(r.url()); if (k) ev.push([Date.now() - t0, k + " end", r.url().slice(0, 90)]); });
await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
let shown = null, themed = null, imgDone = null, y0 = null;
for (let i = 0; i < 400; i++) {
  const s = await page.evaluate(() => { const p = document.querySelector("html.orr-rebuilt #siteTable .thing.link"); const vis = p && getComputedStyle(p).visibility === "visible" && p.getBoundingClientRect().height > 0;
    const img = document.querySelector("#header-img-a img"); return { vis, y: p ? Math.round(p.getBoundingClientRect().top) : null, themed: document.documentElement.classList.contains("orr-substyle"), img: !!(img && img.complete && img.naturalWidth), iw: img && img.naturalWidth, ih: img && img.naturalHeight }; }).catch(() => ({}));
  if (s.vis && shown == null) { shown = Date.now() - t0; y0 = s.y; ev.push([shown, "SHOWN", "post at y=" + s.y]); }
  if (s.themed && themed == null) { themed = Date.now() - t0; ev.push([themed, "THEMED", "post at y=" + s.y]); }
  if (s.img && imgDone == null) { imgDone = Date.now() - t0; ev.push([imgDone, "HEADER IMG", `post at y=${s.y} img ${s.iw}x${s.ih}`]); }
  if (shown != null && themed != null && imgDone != null) break;
  await page.waitForTimeout(25);
}
await page.waitForTimeout(1500);
const yEnd = await page.evaluate(() => { const p = document.querySelector("#siteTable .thing.link"); return p ? Math.round(p.getBoundingClientRect().top) : "no post: " + document.documentElement.className.slice(0, 60) + " / " + document.title.slice(0, 60); });
ev.push([Date.now() - t0, "END", "post at y=" + yEnd]);
ev.sort((a, b) => a[0] - b[0]).forEach((e) => console.log(String(e[0]).padStart(6), e[1].padEnd(12), e[2]));
const hdr = await page.evaluate(() => { const i = document.querySelector("#header-img-a img"); return i && { src: i.src, w: i.getAttribute("width"), h: i.getAttribute("height") }; });
console.log("header:", JSON.stringify(hdr));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
