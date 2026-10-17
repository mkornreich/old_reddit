// Firefox scroll check: install the extension (temporary add-on), open a page and
// scroll down step by step, logging what changes — items, "load more" stubs, page
// height, scroll position jumps, page/console errors, failed requests.
//   node firefox-scroll.mjs <ext-dir> <out-dir> <url> [steps]
//   FF_PRIVATE=1 runs it in permanent private browsing (browser.privatebrowsing.autostart),
//   like a profile set to "never remember history".
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, url, stepsArg] = process.argv.slice(2);
const STEPS = parseInt(stepsArg || "14", 10);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
// Private windows only run add-ons the user allowed there; grant it like the "Run in
// Private Windows" switch does (Firefox migrates this file into its permission store).
if (process.env.FF_PRIVATE) fs.writeFileSync(path.join(profile, "extension-preferences.json"), JSON.stringify({ "old-reddit-redirect@extension.local": { permissions: ["internal:privateBrowsingAllowed"], origins: [] } }));
const ctx = await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: {
    "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false,
    "devtools.chrome.enabled": true, "xpinstall.signatures.required": false,
    ...(process.env.FF_PRIVATE ? { "browser.privatebrowsing.autostart": true } : {}),
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
const errors = [], consoleErr = [], failed = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 200)); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErr.push(m.type() + ": " + m.text().slice(0, 200)); });
page.on("response", (r) => { if (r.status() >= 400 && /reddit\.com/.test(r.url()) && !/\.json|\/api\/me/.test(r.url())) failed.push(r.status() + " " + r.request().method() + " " + r.url().replace("https://www.reddit.com", "").slice(0, 120)); });
page.on("requestfailed", (r) => failed.push("FAILED " + r.method() + " " + r.url().slice(0, 120) + " " + ((r.failure() || {}).errorText || "")));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link, .commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const snap = () => page.evaluate(() => ({
  rebuilt: !!document.querySelector("#siteTable, .commentarea"), y: Math.round(scrollY), h: document.documentElement.scrollHeight,
  comments: document.querySelectorAll(".commentarea .thing.comment").length,
  stubs: document.querySelectorAll("a.orr-more").length,
  loading: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => a.dataset.orrLoading).map((a) => a.textContent.slice(0, 40)),
  failedStubs: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => /failed|rate-limited/.test(a.textContent)).map((a) => a.textContent.slice(0, 60)),
  videos: document.querySelectorAll("video").length, iframes: document.querySelectorAll("iframe").length,
}));
const rows = [];
let prev = await snap();
rows.push({ step: 0, ...prev });
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(1500);
  const s = await snap();
  rows.push({ step: i, ...s, jump: s.y - prev.y < 0 ? "UP " + (s.y - prev.y) : "" });
  prev = s;
  if (i % 4 === 0) await page.screenshot({ path: path.join(outDir, `scroll-${String(i).padStart(2, "0")}.png`) });
}
await page.waitForTimeout(3000);
rows.push({ step: "end", ...(await snap()) });
for (const r of rows) console.log(JSON.stringify(r));
console.log("pageerrors", JSON.stringify(errors));
console.log("console", JSON.stringify(consoleErr.slice(0, 15)));
console.log("failed", JSON.stringify(failed.slice(0, 15)));
await page.screenshot({ path: path.join(outDir, "scroll-end.png") });
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
