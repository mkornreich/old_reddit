// Scroll with the pointer resting over the content (like a real mouse wheel / trackpad)
// in small steps, and count what pops up under the still pointer: hover cards, image
// previews, and the hover-card fetches they trigger. Firefox fires mouseover as the page
// moves under the pointer.   node hover-scroll.mjs firefox|chromium <ext-dir> <out-dir> <url>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [which, extDir, outDir, url] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
const ctx = which === "chromium"
  ? await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1400, height: 900 }, userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] })
  : await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: {
    "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false,
    "devtools.chrome.enabled": true, "xpinstall.signatures.required": false,
  },
});

// Minimal RDP client: messages are "<length>:<json>".
function rdpInstall(dir) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = "", step = 0;
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const c = buf.indexOf(":");
        if (c < 0) return;
        const len = parseInt(buf.slice(0, c), 10);
        if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.slice(c + 1, c + 1 + len));
        buf = buf.slice(c + 1 + len);
        if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
        else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
        else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error + ": " + msg.message)) : resolve(msg.addon); }
      }
    });
    sock.on("error", reject);
  });
}
let addon = null;
for (let i = 0; i < 20 && !addon && which !== "chromium"; i++) {
  try { addon = await rdpInstall(path.resolve(extDir)); } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); }
}
console.log("installed", addon && addon.id);

const page = await ctx.newPage();
const hoverFetches = [];
page.on("request", (r) => { if (/\/svc\/shreddit\/(user|community)-hover-card|about\.json/.test(r.url())) hoverFetches.push(r.url().replace("https://www.reddit.com", "").slice(0, 80)); });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".commentarea, #siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
// pointer resting over the left part of the content column, where author names / titles pass by
await page.mouse.move(110, 450);
let cardShows = 0, previewShows = 0, lastCard = "", lastPrev = "";
const sample = () => page.evaluate(() => {
  const c = document.getElementById("orr-hovercard"), p = document.getElementById("orr-hoverimg");
  return { card: c && c.style.display !== "none" && c.offsetParent !== null ? (c.innerText || "").slice(0, 40) : "", prev: p && p.style.display !== "none" ? (p.querySelector("img") || {}).src || "x" : "" };
});
for (let i = 0; i < 40; i++) {
  await page.mouse.wheel(0, 180);
  await page.waitForTimeout(450);
  const s = await sample();
  if (s.card && s.card !== lastCard) cardShows++;
  if (s.prev && s.prev !== lastPrev) previewShows++;
  lastCard = s.card; lastPrev = s.prev;
}
console.log(which, "→ hover cards popped up while scrolling:", cardShows, "| image previews:", previewShows, "| hover-card fetches:", hoverFetches.length);
await page.screenshot({ path: path.join(outDir, which + "-hover-scroll.png") });
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
