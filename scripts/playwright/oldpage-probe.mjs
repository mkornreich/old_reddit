// Which logged-out URLs still come back as old reddit's own server-rendered page? Opens the
// first URL (an old-reddit listing, e.g. /r/a+b/), then fetches the rest from it; TID in a URL
// = that listing's first post id. Found: /r/x+x/ = r/x's real old page (sidebar + style).
//   node oldpage-probe.mjs - <out-dir> <label> <listing-url> <path>…
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, label, ...urls] = process.argv.slice(2);
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
for (let i = 0; extDir !== "-" && !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
// which logged-out URLs still come back as old reddit's own server-rendered page?
const page = await ctx.newPage();
await page.goto(urls[0], { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
const tid = await page.evaluate(() => document.querySelector("#siteTable > .thing.link").getAttribute("data-fullname").slice(3));
const cands = urls.slice(1).map((u) => u.replace("TID", tid));
const res = await page.evaluate(async (cands) => {
  const out = [];
  for (const u of cands) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      const t = await r.text();
      out.push({ u, status: r.status, final: r.url.replace("https://www.reddit.com", ""), len: t.length,
        oldReddit: /id="header-bottom-left"/.test(t) && /class="[^"]*\bthing\b/.test(t), commentarea: /class="commentarea"/.test(t), side: /class="side"/.test(t), titlebox: /class="titlebox"/.test(t), shreddit: /<shreddit-app/.test(t) });
    } catch (e) { out.push({ u, err: String(e).slice(0, 80) }); }
  }
  return out;
}, cands);
console.log(JSON.stringify(res, null, 1));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
