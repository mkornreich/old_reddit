// Post videos still play (2026-11-28, after v3.17.31 stopped splicing Reddit's error-state
// templates in): a subreddit's first two video posts (from its hot feed) open in Firefox
// (temporary add-on, logged out); for each, the post's media, whether its video plays (muted)
// and whether Reddit's "went wrong" / "View in app" text shows anywhere. It reports; no pass or fail.
//   node video-posts.mjs <ext-dir> https://www.reddit.com/r/<sub>/
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox } from "playwright";
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, url] = process.argv.slice(2);
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pp-"));
const ctx = await firefox.launchPersistentContext(profile, { headless: false, viewport: { width: 1400, height: 900 }, args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false } });
function rdpInstall(dir) { return new Promise((resolve, reject) => { const sock = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0), step = 0;
  const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); for (;;) { const c = buf.indexOf(58); if (c < 0) return; const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
    const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); } else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
    else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); } } }); sock.on("error", reject); }); }
for (let i = 0; i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(2000);
const links = await page.evaluate(async (u) => {
  const name = /\/r\/([^/]+)/.exec(u)[1];
  const r = await fetch("/svc/shreddit/community-more-posts/hot/?name=" + name, { credentials: "include" });
  const d = new DOMParser().parseFromString(await r.text(), "text/html");
  return [...d.querySelectorAll("shreddit-post[post-type='video']")].map((p) => p.getAttribute("permalink")).slice(0, 2);
}, url);
console.log("video posts:", links);
for (const l of links) {
  await page.goto("https://www.reddit.com" + l, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const r = await page.evaluate(async () => {
    const post = document.querySelector("#siteTable .thing.link");
    const v = post && post.querySelector("video");
    if (v) { v.muted = true; try { await v.play(); } catch (e) {} await new Promise((r) => setTimeout(r, 3000)); }
    const media = post ? [...post.querySelectorAll(".expando img, .expando video, .expando iframe")].map((m) => m.tagName + " " + (m.currentSrc || m.src || "").slice(0, 70)) : [];
    return { media, playing: v ? { rs: v.readyState, t: v.currentTime, err: v.error && v.error.code } : null,
      wrong: /went wrong|View in app/i.test(document.body.innerText), comments: document.querySelectorAll(".thing.comment").length };
  });
  console.log(l.slice(0, 70), JSON.stringify(r));
}
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
