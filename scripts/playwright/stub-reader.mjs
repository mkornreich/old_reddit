// What a reader of a thread still has to click (issue #33, 2026-11-27): Firefox (temporary
// add-on) or Chromium (CHROMIUM=1), logged out. Opens a thread at the top and reads down
// it — STEP px, then a PAUSE ms pause — to the end. At every pause it notes each "load more
// comments" inside a thread that is on the screen and not loading: each one is a click the
// reader would have to make. Prints how many there were (and how many were already on the
// first screen when the page appeared), against the comments read and the stubs loaded.
// Before v3.17.26 every reply stub stayed a link; since v3.17.27 only the ones on screen at
// page load (or that you outrun) should.
//   node stub-reader.mjs <ext-dir> <out-dir> [<thread url> | /r/<sub>/]   (STEP=350 PAUSE=2000 MAXSTEPS=120)
//   (a subreddit: its hot page's post with the most comments)
// It reports; it doesn't pass or fail. A page that isn't rebuilt is reported as not tested.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
let url = argUrl || "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/";
const STEP = +(process.env.STEP || 350), PAUSE = +(process.env.PAUSE || 2000), MAXSTEPS = +(process.env.MAXSTEPS || 120);
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-sr-"));
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
    let buf = Buffer.alloc(0), step = 0;
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const c = buf.indexOf(58); if (c < 0) return;
        const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
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
let requests = 0;
page.on("request", (r) => { if (/\/svc\/shreddit\/more-comments\/|\/api\/morechildren/.test(r.url())) requests++; });
// the reply stubs on screen now that aren't loading (each gets an id the first time it's seen)
const look = () => page.evaluate(() => {
  window.__orrSeen = window.__orrSeen || 0;
  const onScreen = [];
  document.querySelectorAll(".commentarea .child a.orr-more").forEach((a) => {
    const r = a.getBoundingClientRect();
    if (r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && !a.dataset.orrLoading) {
      if (!a.dataset.orrReaderId) a.dataset.orrReaderId = String(++window.__orrSeen);
      onScreen.push(a.dataset.orrReaderId);
    }
  });
  return {
    onScreen,
    comments: document.querySelectorAll(".commentarea .thing.comment").length,
    stubsLeft: document.querySelectorAll(".commentarea .child a.orr-more").length,
    atEnd: scrollY + innerHeight >= document.documentElement.scrollHeight - 2,
    y: Math.round(scrollY),
  };
});

// a subreddit given instead (/r/AskReddit/): its hot page's post with the most comments
if (/^\/r\/[^/]+\/?$/.test(url)) {
  await page.goto("https://www.reddit.com" + url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForSelector("#siteTable .thing.link", { timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(2000);
  url = await page.evaluate(() => {
    const posts = Array.from(document.querySelectorAll("#siteTable .thing.link:not(.stickied)"))
      .map((p) => ({ c: parseInt(p.getAttribute("data-comments") || "0", 10), href: p.getAttribute("data-permalink") }))
      .filter((p) => p.href).sort((a, b) => b.c - a.c);
    return posts[0] ? location.origin + posts[0].href : null;
  });
  if (!url) { console.log("NOT TESTED: no thread found on that subreddit's page"); await ctx.close(); process.exit(0); }
}
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
const rebuilt = await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).then(() => true).catch(() => false);
if (!rebuilt) {
  console.log(`NOT TESTED ${url}: not rebuilt (Reddit's CAPTCHA or block page?)`);
} else {
  const first = await look(); // the first screen, as the page appears
  await page.screenshot({ path: path.join(outDir, "first-screen.png") });
  const firstIds = new Set(first.onScreen);
  const seen = new Set(first.onScreen);
  let worst = { n: first.onScreen.length, y: 0 }, steps = 0, last = first;
  await page.waitForTimeout(PAUSE);
  for (; steps < MAXSTEPS; steps++) {
    await page.evaluate((s) => window.scrollBy(0, s), STEP);
    await page.waitForTimeout(PAUSE);
    last = await look();
    last.onScreen.forEach((id) => seen.add(id));
    if (last.onScreen.length > worst.n) {
      worst = { n: last.onScreen.length, y: last.y };
      await page.screenshot({ path: path.join(outDir, "worst-screen.png") });
    }
    if (last.atEnd) break;
  }
  const later = [...seen].filter((id) => !firstIds.has(id)).length;
  console.log(`${url}`);
  console.log(`  read ${steps} steps of ${STEP}px, ${PAUSE} ms apart${last.atEnd ? ", to the end" : " (stopped before the end)"}`);
  console.log(`  comments: ${first.comments} at first → ${last.comments}; ${requests} "load more comments" requests`);
  console.log(`  links a reader met unloaded: ${seen.size} (${firstIds.size} on the first screen when the page appeared, ${later} later); most on one screen: ${worst.n}`);
  console.log(`  reply stubs left in the page at the end: ${last.stubsLeft}`);
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
