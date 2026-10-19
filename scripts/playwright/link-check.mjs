// What the links in a rebuilt page's post / comment / sidebar text point to: counts by
// scheme, the mailto: links, and "dead" links — an <a> with no href, which old reddit's
// CSS still paints blue (how emails looked before their mailto: href was kept).
//   node link-check.mjs <ext-dir> <url> [--firefox]
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
const [extDir, url] = args;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const PORT = 6000 + Math.floor(Math.random() * 1000);
let ctx;
if (useFirefox) {
  ctx = await firefox.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1400, height: 900 }, args: ["-start-debugger-server", String(PORT)],
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
    channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
  });
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
}
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing, .commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const r = await page.evaluate(() => {
  const links = Array.from(document.querySelectorAll(".md a"));
  const schemes = {};
  links.forEach((a) => { const h = a.getAttribute("href"); const k = h == null ? "(no href)" : (/^([a-z][a-z0-9+.-]*):/i.exec(h) || [null, h.startsWith("/") ? "/" : "other"])[1].toLowerCase(); schemes[k] = (schemes[k] || 0) + 1; });
  return {
    rebuilt: !!document.querySelector("#siteTable, .commentarea"),
    schemes,
    mailto: links.filter((a) => /^mailto:/i.test(a.getAttribute("href") || "")).map((a) => a.textContent + " → " + a.getAttribute("href")),
    dead: links.filter((a) => !a.hasAttribute("href")).map((a) => a.textContent.trim().slice(0, 60)).slice(0, 10),
  };
});
console.log(JSON.stringify(r, null, 1));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(r.rebuilt && !r.dead.length ? 0 : 1);
