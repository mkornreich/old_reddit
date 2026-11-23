// Probe: the "load more comments" stubs of a rebuilt thread (issue #33). For each address,
// logged out: how many comments are on the page (and how many are top-level), the top-level
// stubs (at the end of the thread), the stubs INSIDE threads (more replies to a comment)
// with the more-comments partial each would load, and how many more-comments POSTs the page
// has made so far. Firefox (temporary add-on) or Chromium.
//   node stub-probe.mjs <ext-dir> <out-dir> <thread url> [<thread url> …]
//   (CHROMIUM=1: Chromium build; UA=…: another user agent)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, ...urls] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-stub-"));
const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  ...(process.env.UA ? { userAgent: process.env.UA } : {}),
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
}) : await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false,
    ...(process.env.UA ? { "general.useragent.override": process.env.UA } : {}) },
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
let posts = [];
page.on("request", (r) => { if (r.method() === "POST" && /more-comments/.test(r.url())) posts.push(r.url().slice(0, 170)); });
for (const u of urls) {
  posts = [];
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => {
    const stubs = [...document.querySelectorAll(".commentarea a.orr-more")];
    return {
      comments: document.querySelectorAll(".commentarea .thing.comment").length,
      top: document.querySelectorAll(".commentarea .nestedlisting > .thing.comment").length,
      stubsTop: stubs.filter((a) => !a.closest(".child")).map((a) => a.textContent + " " + (a.getAttribute("data-partial") || "").slice(0, 120)),
      stubsNested: stubs.filter((a) => a.closest(".child")).map((a) => a.textContent.trim() + " | " + (a.getAttribute("data-partial") || "").slice(0, 150)),
    };
  });
  console.log("==", u, "\n comments", r.comments, "top", r.top, "\n top stubs", JSON.stringify(r.stubsTop), "\n nested stubs", r.stubsNested.length);
  r.stubsNested.slice(0, 5).forEach((s) => console.log("   ", s));
  console.log(" more-comments POSTs so far:", posts.length, posts.slice(0, 2));
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
