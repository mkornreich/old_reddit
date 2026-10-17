// Firefox: which requests does the page's Content-Security-Policy block for the
// extension? Prints the document's CSP connect-src and every CSP console message.
//   node firefox-csp.mjs <ext-dir> <out-dir> <url>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, url] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
const ctx = await firefox.launchPersistentContext(profile, {
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
for (let i = 0; i < 20 && !addon; i++) {
  try { addon = await rdpInstall(path.resolve(extDir)); } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); }
}
console.log("installed", addon && addon.id);

const page = await ctx.newPage();
const csp = [];
page.on("console", (m) => { if (/Content-Security-Policy|CSP/i.test(m.text())) csp.push(m.text()); });
const reqs = [];
page.on("response", (r) => { const u = r.url(); if (/\.json|\/svc\/shreddit\/(more-comments|community-more-posts|profiles|feeds)/.test(u)) reqs.push(r.status() + " " + r.request().method() + " " + u.replace("https://www.reddit.com", "").slice(0, 90)); });
const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
const h = resp ? await resp.allHeaders() : {};
const policy = h["content-security-policy"] || "";
console.log("document CSP connect-src:", (policy.match(/connect-src[^;]*/) || ["(none)"])[0].slice(0, 400));
console.log("document CSP default-src:", (policy.match(/default-src[^;]*/) || ["(none)"])[0].slice(0, 200));
await page.waitForTimeout(8000);
console.log("rebuilt:", await page.evaluate(() => !!document.getElementById("siteTable")));
console.log("requests:", JSON.stringify(reqs, null, 1));
console.log("CSP messages:"); for (const m of csp.slice(0, 6)) console.log("  ", m.slice(0, 600));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
