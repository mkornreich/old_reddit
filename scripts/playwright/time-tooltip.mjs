// Issue #32: hovering a post's / comment's "N hours ago" shows the exact time in your own
// time zone, like old reddit ("Tue Oct 20 15:16:19 2026 EDT"). Checks every <time> in
// taglines has that tooltip — on a listing (also the posts infinite scroll adds), a thread
// reached by clicking in the page, and a profile — that it matches the <time>'s datetime in
// the browser's time zone, and that nothing covers it (the pointer reaches the <time>, so
// the browser shows its tooltip).
//   node time-tooltip.mjs <ext-dir> [--firefox]      FFBIN=<firefox binary> for a stock Firefox
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
const [extDir] = args;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const PORT = 6000 + Math.floor(Math.random() * 1000);
let ctx;
if (useFirefox) {
  ctx = await firefox.launchPersistentContext(profile, Object.assign({
    headless: false, viewport: { width: 1300, height: 900 }, args: ["--start-debugger-server=" + PORT],
    firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false, "browser.shell.checkDefaultBrowser": false },
  }, process.env.FFBIN ? { channel: "moz-firefox", executablePath: process.env.FFBIN } : {}));
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
    channel: "chromium", headless: false, viewport: { width: 1300, height: 900 }, timezoneId: "America/Los_Angeles",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
  });
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
}
const page = ctx.pages()[0] || (await ctx.newPage());
const errors = [];
// (not the CSP reports from Reddit's bot-check page: its default-src 'none' blocks the
// extension's first requests in Firefox before the real page loads — see challenge-flow.mjs;
// nor Firefox's note about one of Reddit's own images being broken)
page.on("pageerror", (e) => { if (!/\.announce is not a function|page’s settings blocked|Content-Security-Policy|Image corrupt or truncated/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
// every tagline <time>: has a title, and the title is its datetime in this browser's time zone
const times = () => page.evaluate(() => {
  const D = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n) => String(n).padStart(2, "0");
  const ts = Array.from(document.querySelectorAll(".tagline time"));
  const bad = ts.filter((t) => {
    const d = new Date(t.getAttribute("datetime"));
    const want = `${D[d.getDay()]} ${M[d.getMonth()]} ${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
    return !t.title || t.title.indexOf(want) !== 0;
  }).map((t) => t.textContent + " / " + t.title);
  // the first one on screen: nothing on top of it
  const vis = ts.find((t) => { const r = t.getBoundingClientRect(); return r.top > 60 && r.bottom < innerHeight - 20 && r.width > 0; });
  let reach = "none on screen";
  if (vis) { const r = vis.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); reach = el === vis || vis.contains(el) ? "yes" : "covered by " + (el && (el.tagName + "." + el.className)); }
  return { page: location.pathname.slice(0, 40), n: ts.length, bad, reach, sample: ts[0] ? ts[0].textContent + " → " + ts[0].title : "" };
});

await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const l0 = await times();
console.log(JSON.stringify(l0));
check("listing: every time has the exact local time as its tooltip", l0.n >= 20 && !l0.bad.length, JSON.stringify(l0.bad.slice(0, 3)));
check("listing: the pointer reaches the time (tooltip shows)", l0.reach === "yes", l0.reach);
await page.mouse.move(600, 500);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(900); }
await page.waitForTimeout(1500);
const l1 = await times();
check("…and on the posts infinite scroll added", l1.n > l0.n && !l1.bad.length, `${l0.n} → ${l1.n}, bad ${l1.bad.length}`);
// a thread, opened by clicking in the page
await page.evaluate(() => window.scrollTo(0, 0));
const href = await page.evaluate(() => { const a = Array.from(document.querySelectorAll("#siteTable > .thing.link a.comments")).find((x) => /\d+ comments/.test(x.textContent) && parseInt(x.textContent, 10) >= 5); return a && a.getAttribute("href"); });
if (href) {
  await page.evaluate((h) => { const a = Array.from(document.querySelectorAll("#siteTable > .thing.link a.comments")).find((x) => x.getAttribute("href") === h); a.scrollIntoView({ block: "center" }); }, href);
  await page.click(`#siteTable > .thing.link a.comments[href="${href}"]`);
  await page.waitForSelector(".commentarea .thing.comment", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const t = await times();
  console.log(JSON.stringify(t));
  check("thread: the post's and every comment's time has it", t.n >= 3 && !t.bad.length, JSON.stringify(t.bad.slice(0, 3)));
}
await page.goto("https://www.reddit.com/user/spez/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const u = await times();
check("profile: every time has it", u.n >= 5 && !u.bad.length, JSON.stringify(u.bad.slice(0, 3)));
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
