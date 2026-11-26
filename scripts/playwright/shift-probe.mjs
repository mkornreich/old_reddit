// Probe: what above the comments grows in a thread's first seconds and moves them down
// (issue #35, 2026-11-26: an app post's box went 0 → 32px at 4 s in Chromium). Logged out:
// scrolls to where the comments begin, then every 200 ms for 8 s prints the scroll position
// and the top+height of the header, the post, its expando, the comment area and the first
// comment, whenever any of them changed.
//   node shift-probe.mjs <ext-dir> <out-dir> [<thread url>]   (CHROMIUM=1: Chromium build)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
const url = argUrl || "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/";
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-jump-"));
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
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).catch(() => {});
await page.evaluate(() => { const c = document.querySelector(".commentarea .thing.comment"); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 40); });
const t0 = Date.now();
let prev = null;
for (let i = 0; i < 40; i++) {
  const snap = await page.evaluate(() => {
    const h = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return Math.round(r.top + scrollY) + "+" + Math.round(r.height); };
    return { y: Math.round(scrollY), header: h("#header"), post: h("#siteTable"), expando: h("#siteTable .expando"), infobar: h(".infobar, .orr-infobar"), area: h(".commentarea"), menu: h(".commentarea > .menuarea, .commentarea .menuarea"), form: h(".commentarea > form, .commentarea .usertext"), panes: [...document.querySelectorAll(".commentarea > *")].slice(0, 6).map((e) => e.tagName + "." + (e.className || "").toString().split(" ")[0] + ":" + Math.round(e.getBoundingClientRect().height)).join(" "), first: h(".commentarea .thing.comment"), sub: !!document.getElementById("orr-sub-css") };
  });
  const s = JSON.stringify(snap);
  if (s !== prev) console.log(((Date.now() - t0) / 1000).toFixed(2) + "s", s);
  prev = s;
  await page.waitForTimeout(200);
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
