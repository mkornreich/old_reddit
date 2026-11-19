// Reddit's browser check leaves no trace in the address (2026-11-19). On a fresh visit
// Reddit's server answers with a quick JavaScript check that sends the browser on to the
// page again as ?solution=…&js_challenge=1&jsc_token=…&jsc_orig_r= — and Reddit's own page
// keeps that in its address, so copying the address copied it along. On a page the add-on
// shows, the address goes back to the page's own. Firefox (temporary add-on) or Chromium,
// logged out; each address opens in a FRESH profile (the check comes on a first visit):
//  - the page is rebuilt, its address is the one asked for (the page's own query and hash
//    kept), with none of the check's parameters;
//  - reloading it gives the rebuilt page again (no check loop).
// A visit Reddit didn't check, or answered with its block / CAPTCHA page, is reported as not tested.
//   node challenge-check.mjs <ext-dir> <out-dir> [<url> …]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, ...argUrls] = process.argv.slice(2);
const urls = argUrls.length ? argUrls : [
  "https://www.reddit.com/r/GTA/comments/1y0ag5r/gta_6_map/",
  "https://www.reddit.com/r/GTA/top/?t=week",
  "https://www.reddit.com/r/GTA/comments/1y0ag5r/gta_6_map/?sort=new",
  // (not /search: right after the check, Reddit answers a fresh logged-out search with its
  //  "blocked by network security" page, add-on or not — 2026-11-19)
];
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const CHECK_PARAMS = ["solution", "js_challenge", "jsc_token", "jsc_orig_r"];
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? "PASS " : "FAIL ") + msg); };

function rdpInstall(port, dir) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
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
async function launch() {
  const PORT = 6000 + Math.floor(Math.random() * 1000);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
  const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
  }) : await firefox.launchPersistentContext(profile, {
    headless: false, viewport: { width: 1400, height: 900 },
    args: ["-start-debugger-server", String(PORT)],
    firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false },
  });
  for (let i = 0; !CHROMIUM && i < 20; i++) { try { await rdpInstall(PORT, path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
  return { ctx, profile };
}

for (const [n, url] of urls.entries()) {
  const { ctx, profile } = await launch();
  const page = await ctx.newPage();
  let checked = false;
  page.on("request", (r) => { if (r.isNavigationRequest() && /[?&]js_challenge=1/.test(r.url())) checked = true; });
  const want = new URL(url);
  const tag = want.pathname + want.search;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  const rebuilt = await page.waitForSelector("html.orr-rebuilt #siteTable", { timeout: 40000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(4000);
  const here = new URL(page.url());
  console.log(`  ${tag}: checked by Reddit: ${checked}; address now ${here.href.slice(0, 140)}`);
  await page.screenshot({ path: path.join(outDir, `${n}.png`) });
  const blocked = await page.evaluate(() => /prove your humanity|blocked by network security/i.test(document.body ? document.body.innerText.slice(0, 3000) : "")).catch(() => false);
  if (!checked) console.log(`NOT TESTED ${tag}: Reddit didn't run its browser check on this visit`);
  else if (blocked && !rebuilt) console.log(`NOT TESTED ${tag}: Reddit answered with its block / CAPTCHA page`);
  else {
    ok(rebuilt, `${tag}: the page is rebuilt`);
    ok(!CHECK_PARAMS.some((k) => here.searchParams.has(k)), `${tag}: none of the check's parameters left in the address`);
    ok(here.pathname === want.pathname && [...want.searchParams].every(([k, v]) => here.searchParams.get(k) === v) && here.hash === want.hash,
      `${tag}: the address is the page's own (${here.pathname + here.search + here.hash})`);
    await page.reload({ waitUntil: "domcontentloaded" });
    const again = await page.waitForSelector("html.orr-rebuilt #siteTable", { timeout: 40000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(2000);
    const after = new URL(page.url());
    ok(again && after.pathname === want.pathname && !CHECK_PARAMS.some((k) => after.searchParams.has(k)), `${tag}: reloading it gives the rebuilt page again`);
  }
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
