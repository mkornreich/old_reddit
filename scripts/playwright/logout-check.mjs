// Logout against a FAKE login — nothing reaches a real Reddit account. /api/me.json says
// you're logged in until the extension logs out; its logout request (new Reddit's own:
// a JSON POST to /svc/shreddit/account/logout carrying the csrf_token cookie) is
// intercepted and checked — method, JSON body with the token, a same-origin Origin — and
// answered OK; then the page must come back logged out (a "login" link, no account
// buttons). Also: a refused logout keeps you logged in and says so; logging out from a
// page that needs a login (your inbox) lands on the front page.
//   node logout-check.mjs <ext-dir> [listing-url] [--firefox]
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
const [extDir, url = "https://www.reddit.com/r/sysadmin/"] = args;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const PORT = 6000 + Math.floor(Math.random() * 1000);
let ctx;
if (useFirefox) {
  ctx = await firefox.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1300, height: 900 }, args: ["-start-debugger-server", String(PORT)],
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
    channel: "chromium", headless: false, viewport: { width: 1300, height: 900 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ignoreDefaultArgs: ["--enable-automation"],
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
  });
  await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
}
const ME = "orr_test_user", CSRF = "csrf_fake_0123";
await ctx.addCookies([{ name: "csrf_token", value: CSRF, domain: ".reddit.com", path: "/", secure: true, sameSite: "Strict" }]);
let loggedIn = true, refuse = false;
const logouts = [];
await ctx.route(/^https:\/\/www\.reddit\.com\/api\/me\.json/, (route) => loggedIn
  ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "t2", data: { name: ME, modhash: "mh_test", link_karma: 1, comment_karma: 2, total_karma: 3, inbox_count: 0 } }) })
  : route.fulfill({ status: 403, contentType: "text/html", body: "<html>blocked</html>" }));
await ctx.route(/^https:\/\/www\.reddit\.com\/svc\/shreddit\/account\/logout/, (route) => {
  const req = route.request();
  let body = null;
  try { body = JSON.parse(req.postData() || "null"); } catch (e) { body = req.postData(); }
  const h = req.headers();
  logouts.push({ method: req.method(), type: h["content-type"] || "", origin: h["origin"] || "", body });
  if (refuse) return route.fulfill({ status: 400, contentType: "text/plain", body: "Internal Server Error" });
  loggedIn = false;
  return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
});
// (the inbox page: an empty one, so a logged-in visit renders)
await ctx.route(/^https:\/\/www\.reddit\.com\/message\/[a-z]+\/?\.json/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "Listing", data: { after: null, children: [] } }) }));
await ctx.route(/^https:\/\/www\.reddit\.com\/login/, (route) => route.abort()); // (new Reddit's own logged-out redirect)
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const header = () => page.evaluate(() => ({
  url: location.pathname,
  user: (document.querySelector("#header-bottom-right .user a") || {}).textContent || "",
  logout: !!document.getElementById("logout"),
  login: !!document.querySelector("#header-bottom-right a.login-link, #header-bottom-right a[href^='/login']"),
  loggedInClass: document.documentElement.classList.contains("orr-logged-in"),
  toast: (document.getElementById("orr-toast") || {}).textContent || "",
}));
const waitHeader = async () => { await page.waitForSelector("#header-bottom-right", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500); };

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await waitHeader();
const h0 = await header();
check("fake login: your name and a logout link", h0.user === ME && h0.logout, JSON.stringify(h0));

// a refused logout: still logged in, and it says so
refuse = true;
await page.click("#logout");
await page.waitForTimeout(1500);
const h1 = await header();
check("a refused logout keeps you logged in and says so", h1.user === ME && h1.logout && /couldn't log out/.test(h1.toast), JSON.stringify(h1));
refuse = false;

// logout
const nav = page.waitForEvent("framenavigated", { timeout: 15000 }).catch(() => null);
await page.click("#logout");
await nav;
await waitHeader();
const h2 = await header();
const lo = logouts[logouts.length - 1] || {};
console.log("logout request:", JSON.stringify(lo));
check("logout sends new Reddit's request: JSON POST with the csrf_token", lo.method === "POST" && /application\/json/.test(lo.type) && lo.body && lo.body["0"] === "1" && lo.body.csrf_token === CSRF, JSON.stringify(lo));
check("…from the page's own origin", !lo.origin || lo.origin === "https://www.reddit.com", lo.origin);
check("the page comes back logged out", new URL(url).pathname === h2.url && !h2.user && !h2.logout && h2.login && !h2.loggedInClass, JSON.stringify(h2));

// from a page that needs a login: the front page
// (reached in-page, from the mail icon: this browser isn't really logged in, so loading
// /message/inbox/ directly gets Reddit's own redirect to /login before the extension runs)
loggedIn = true;
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await waitHeader();
await page.click("#header-bottom-right #mail");
await page.waitForSelector(".messages-page, #siteTable", { timeout: 20000 }).catch(() => {});
await waitHeader();
const inInbox = (await header()).url;
const nav2 = page.waitForEvent("framenavigated", { timeout: 15000 }).catch(() => null);
await page.click("#logout").catch(() => {});
await nav2;
await waitHeader();
const h3 = await header();
check("logging out of your inbox lands on the front page", /^\/message\/inbox/.test(inInbox) && h3.url === "/" && !h3.user, JSON.stringify({ inInbox, h3 }));
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
