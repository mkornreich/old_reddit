// A thread's post and first comment as the add-on shows them (2026-11-28, r/mit 1vbuvby: a video
// uploaded into a comment came with Reddit's "Sorry, something went wrong when loading this
// video.", a blurred poster and "View in app" under it, fixed in v3.17.31). Firefox (temporary
// add-on) or Chromium (CHROMIUM=1), logged out. Prints the post's expando and the first
// comment's body HTML, plays the comment's video (muted) and reports whether it ran; saves
// Reddit's own HTML of the thread as <out-dir>/thread.html (it holds Reddit's per-visitor ids:
// never commit it) and a screenshot at the comment. WARM=<url> opens that first (Reddit's
// first-visit browser check). It reports; no pass or fail.
//   WARM=https://www.reddit.com/ node video-probe.mjs <ext-dir> <out-dir> <thread url>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [extDir, outDir, url] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-vp-"));
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
page.on("console", (m) => { if (/orr|Classic/i.test(m.text())) console.log("console:", m.text().slice(0, 200)); });
if (process.env.WARM) { await page.goto(process.env.WARM, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 40000 }).catch(() => {}); await page.waitForTimeout(2000); }
await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(4000);
const raw = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include" }); return { status: r.status, text: await r.text() }; }, url);
fs.writeFileSync(path.join(outDir, "thread.html"), raw.text);
console.log("raw status", raw.status, raw.text.length);
const info = await page.evaluate(() => {
  const t = document.querySelector("#siteTable .thing.link");
  const ex = t && t.querySelector(".expando");
  return { cls: t && t.className, expando: ex ? ex.innerHTML.slice(0, 3000) : null,
    videos: [...document.querySelectorAll("#siteTable video")].map((v) => ({ src: v.currentSrc || v.src, rs: v.readyState, err: v.error && v.error.code, w: v.videoWidth })),
    imgs: [...document.querySelectorAll("#siteTable .expando img")].map((i) => i.src.slice(0, 120)),
    text: ex ? ex.innerText.slice(0, 500) : null };
});
console.log(JSON.stringify(info, null, 1));
const cm = await page.evaluate(async () => {
  const md = document.querySelector(".commentarea .comment .md");
  const v = document.querySelector(".commentarea video");
  if (v) { v.muted = true; try { await v.play(); } catch (e) {} await new Promise((r) => setTimeout(r, 4000)); }
  return { md: md ? md.innerHTML.slice(0, 2500) : null, text: md ? md.innerText : null,
    imgs: [...document.querySelectorAll(".commentarea img")].map((i) => i.alt + " " + i.src.slice(0, 80)),
    video: v && { src: (v.currentSrc || v.src).slice(0, 100), rs: v.readyState, err: v.error && v.error.code, w: v.videoWidth, t: v.currentTime, dash: v.getAttribute("data-dash-url") } };
});
console.log(JSON.stringify(cm, null, 1));
await page.evaluate(() => { const c = document.querySelector(".commentarea .comment"); if (c) c.scrollIntoView(); });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, "shot.png") });
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
