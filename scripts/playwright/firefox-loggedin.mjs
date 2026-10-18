// Logged-in Firefox check in a stock Firefox build (e.g. your own Developer Edition), driven
// over WebDriver BiDi. Opens a window on Reddit's login page and waits for YOU to log in
// there, then installs the extension (temporary add-on via the Remote Debugging Protocol)
// and scrolls a page step by step like firefox-scroll.mjs, logging items, "load more"
// stubs, scroll jumps, page/console errors and Reddit API calls. The profile is temporary
// and deleted afterwards.
//   node firefox-loggedin.mjs <firefox-binary> <ext-dir> <out-dir> <url> [steps]
//   FF_PRIVATE=1  permanent private browsing (a profile set to "never remember history")
//   NO_LOGIN=1    skip the login wait and keep the window off the desktop (logged-out run)
//   KEEP_OPEN=1   after the run, leave the window open (for rdp-*.mjs) until you close it
// The browser also listens on the printed RDP port, so rdp-scroll.mjs / rdp-eval.mjs can
// keep testing in the same logged-in window.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.NO_LOGIN) await import("./hidden-display.mjs");
const { firefox } = await import("playwright");
const [ffBin, extDir, outDir, url, stepsArg] = process.argv.slice(2);
const STEPS = parseInt(stepsArg || "16", 10);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ffl-"));
// Private windows only run add-ons allowed there ("Run in Private Windows").
if (process.env.FF_PRIVATE) fs.writeFileSync(path.join(profile, "extension-preferences.json"), JSON.stringify({ "old-reddit-redirect@extension.local": { permissions: ["internal:privateBrowsingAllowed"], origins: [] } }));
const ctx = await firefox.launchPersistentContext(profile, {
  // a "moz-*" channel = a stock Firefox driven over WebDriver BiDi
  channel: "moz-firefox", executablePath: ffBin, headless: false, viewport: { width: 1400, height: 900 },
  args: ["--start-debugger-server=" + PORT], // (one arg: Playwright takes a bare "6123" for a URL)
  firefoxUserPrefs: {
    "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false,
    "devtools.chrome.enabled": true, "xpinstall.signatures.required": false,
    "browser.shell.checkDefaultBrowser": false,
    ...(process.env.FF_PRIVATE ? { "browser.privatebrowsing.autostart": true } : {}),
  },
});
const cleanup = async () => { await ctx.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); };

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

const page = ctx.pages()[0] || (await ctx.newPage());
// In private browsing Playwright can't see the login cookie (it lives in the private
// jar), so also ask the page: new Reddit marks <shreddit-app user-logged-in="true">.
const loggedIn = async () => (await ctx.cookies("https://www.reddit.com")).some((c) => c.name === "reddit_session") ||
  (await page.evaluate(() => { const a = document.querySelector("shreddit-app"); return !!a && a.getAttribute("user-logged-in") === "true"; }).catch(() => false));
if (!process.env.NO_LOGIN) {
  await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  console.log("waiting for you to log in to Reddit in the Firefox window (15 min max)…");
  const until = Date.now() + 15 * 60 * 1000;
  while (!(await loggedIn())) {
    if (Date.now() > until) { console.log("no login after 15 minutes — giving up"); await cleanup(); process.exit(2); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("logged in");
  await new Promise((r) => setTimeout(r, 3000));
}
// Install after logging in, so the extension can't get in the way of Reddit's login page.
let addon = null;
for (let i = 0; i < 20 && !addon; i++) {
  try { addon = await rdpInstall(path.resolve(extDir)); } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); }
}
console.log("installed", addon && addon.id, "(RDP port " + PORT + ")");

const errors = [], consoleErr = [], failed = [], api = {};
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 200)); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErr.push(m.type() + ": " + m.text().slice(0, 200)); });
page.on("response", (r) => {
  const u = r.url();
  if (!/^https:\/\/(www|oauth)\.reddit\.com\//.test(u)) return;
  const k = r.status() + " " + r.request().method() + " " + u.replace(/^https:\/\/[^/]+/, "").replace(/\?.*/, "").replace(/\/comments\/[a-z0-9]+\/[^/]*/, "/comments/…").slice(0, 70);
  if (/\.json|\/api\/|\/svc\/shreddit\//.test(u)) api[k] = (api[k] || 0) + 1;
  if (r.status() >= 400 && !/\/api\/me/.test(u)) failed.push(k);
});
page.on("requestfailed", (r) => failed.push("FAILED " + r.method() + " " + r.url().slice(0, 120) + " " + ((r.failure() || {}).errorText || "")));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link, .commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const snap = () => page.evaluate(() => ({
  rebuilt: !!document.querySelector("#siteTable, .commentarea"),
  user: (document.querySelector("#header-bottom-right .user a") || {}).textContent || "",
  y: Math.round(scrollY), h: document.documentElement.scrollHeight,
  comments: document.querySelectorAll(".commentarea .thing.comment").length,
  stubs: document.querySelectorAll(".commentarea .morecomments a, a.orr-more").length,
  loading: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => a.dataset.orrLoading).map((a) => a.textContent.slice(0, 40)),
  failedStubs: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => /failed|rate-limited/.test(a.textContent)).map((a) => a.textContent.slice(0, 60)),
}));
const rows = [];
let prev = await snap();
rows.push({ step: 0, ...prev });
await page.screenshot({ path: path.join(outDir, "scroll-00.png") });
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.move(700, 450);
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
console.log("console", JSON.stringify(consoleErr.slice(0, 20)));
console.log("failed", JSON.stringify(failed.slice(0, 20)));
console.log("api", JSON.stringify(api));
await page.screenshot({ path: path.join(outDir, "scroll-end.png") });
if (process.env.KEEP_OPEN) {
  console.log("keeping the window open — RDP port " + PORT + "; close the window to finish");
  await new Promise((r) => ctx.on("close", r));
}
await cleanup();
