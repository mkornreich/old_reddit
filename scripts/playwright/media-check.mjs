// Opening a Reddit picture shows the picture (2026-11-19: on r/GTA's map post, the lightbox's
// "open image ↗" landed back on the post — i.redd.it sends a page load of a picture to
// www.reddit.com/media?url=…, and Reddit's page there turns itself into the post; the add-on
// now shows just the picture there). Firefox (temporary add-on) or Chromium, logged out:
//  1. the thread's expanded picture → lightbox → "open image ↗": a new tab with just that
//     picture, fitted to the window, at /media?url=<the picture>, and it stays there;
//  2. a click there shows it full size (the clicked spot stays put), another fits it again;
//     reloading keeps the picture;
//  3. the post's title (a link to the picture) opens the picture in the tab; Back → the thread;
//  4. a preview.redd.it picture opened directly shows too;
//  5. a picture that's gone says so;
//  6. /media?url= with a picture from anywhere else is left to Reddit.
//   node media-check.mjs <ext-dir> <out-dir> [<thread url with a picture post>]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
const thread = argUrl || "https://www.reddit.com/r/GTA/comments/1y0ag5r/gta_6_map/";
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
const CHROMIUM = process.env.CHROMIUM === "1";
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
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? "PASS " : "FAIL ") + msg); };
const untested = (msg) => console.log("NOT TESTED " + msg);
const page = await ctx.newPage();
const captcha = (p) => p.evaluate(() => /prove your humanity|blocked by network security/i.test(document.body ? document.body.innerText.slice(0, 3000) : "")).catch(() => false);

// the thread, rebuilt (plain Chromium often gets Reddit's "Prove your humanity" on its first page: one more try)
async function openThread() {
  for (let i = 0; i < 2; i++) {
    await page.goto(thread, { waitUntil: "domcontentloaded", timeout: 45000 });
    const got = await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 30000 }).then(() => true).catch(() => false);
    if (got) { await page.waitForTimeout(2500); return true; }
    if (await captcha(page)) console.log("  (Reddit's CAPTCHA page)");
  }
  return false;
}

// the picture page: what's on it
const mediaState = (p) => p.evaluate(() => {
  const img = document.getElementById("orr-media-img");
  const r = img && img.getBoundingClientRect();
  const hit = img && document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  return {
    url: location.href, title: document.title, media: document.documentElement.classList.contains("orr-media"),
    src: img && img.getAttribute("src"), loaded: !!(img && img.complete && img.naturalWidth),
    natural: img ? [img.naturalWidth, img.naturalHeight] : null, rect: r ? [r.left, r.top, r.width, r.height].map(Math.round) : null,
    view: [innerWidth, innerHeight], scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    onTop: hit === img, redditPost: !!document.querySelector("shreddit-post, #siteTable, shreddit-app"),
    full: document.documentElement.classList.contains("orr-media-full"), cursor: img && getComputedStyle(img).cursor,
  };
});
const waitLoaded = (p) => p.waitForFunction(() => { const i = document.getElementById("orr-media-img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 30000 }).catch(() => {});
const mediaUrl = (src) => "https://www.reddit.com/media?url=" + encodeURIComponent(src);

if (!(await openThread())) {
  untested("the thread didn't rebuild (CAPTCHA?) — nothing tested");
} else {
  // 1. the lightbox's "open image ↗"
  const pic = page.locator("#siteTable .thing.link .expando img.preview").first();
  if (!(await pic.isVisible().catch(() => false))) {
    await page.locator("#siteTable .thing.link .expando-button").first().click();
    await page.waitForTimeout(1500);
  }
  await pic.click();
  await page.waitForSelector("#orr-lightbox #orr-lb-open", { timeout: 10000 });
  const href = await page.getAttribute("#orr-lb-open", "href");
  console.log("  open image ↗ →", href);
  const [tab] = await Promise.all([ctx.waitForEvent("page", { timeout: 20000 }), page.click("#orr-lb-open")]);
  await tab.waitForLoadState("domcontentloaded").catch(() => {});
  await tab.waitForFunction(() => location.pathname === "/media" && document.documentElement.classList.contains("orr-media"), null, { timeout: 30000 }).catch(() => {});
  await waitLoaded(tab);
  await tab.waitForTimeout(6000); // Reddit's page under it moves the address to the post as it loads
  let s = await mediaState(tab);
  console.log("  new tab:", JSON.stringify(s));
  const file = href.split("/").pop().split("?")[0];
  ok(s.media && s.loaded && s.src === href && s.onTop && !s.redditPost, `"open image ↗": a new tab shows just the picture (${s.natural && s.natural.join("×")})`);
  ok(s.url === mediaUrl(href), `…its address is the picture's own (/media?url=…), still after Reddit's page loaded (${s.url.slice(0, 90)})`);
  ok(s.title.includes(file) && /×/.test(s.title), `…the tab's title names the picture ("${s.title}")`);
  const big = s.natural && (s.natural[0] > s.view[0] || s.natural[1] > s.view[1]);
  if (big) ok(s.rect[2] <= s.view[0] + 1 && s.rect[3] <= s.view[1] + 1 && s.cursor === "zoom-in", `…a picture bigger than the window is fitted to it (${s.rect.slice(2).join("×")} in ${s.view.join("×")}), click to zoom`);
  await tab.screenshot({ path: path.join(outDir, "1-open-image.png") });

  // 2. click: full size, the clicked spot under the pointer; again: fitted
  if (big) {
    const at = [s.rect[0] + s.rect[2] * 0.7, s.rect[1] + s.rect[3] * 0.3];
    await tab.mouse.click(at[0], at[1]);
    await tab.waitForTimeout(600);
    const f = await mediaState(tab);
    const spot = await tab.evaluate(([x, y]) => { const r = document.getElementById("orr-media-img").getBoundingClientRect(); return [(x - r.left) / r.width, (y - r.top) / r.height]; }, at);
    console.log("  full size:", JSON.stringify(f), "spot", spot.map((v) => v.toFixed(3)).join(","));
    ok(f.full && f.rect[2] === f.natural[0] && f.rect[3] === f.natural[1] && f.scroll[1] > f.view[1] && f.cursor === "zoom-out",
      `a click shows it at full size (${f.rect.slice(2).join("×")}), scrollable`);
    ok(Math.abs(spot[0] - 0.7) < 0.02 && Math.abs(spot[1] - 0.3) < 0.02, `…with the clicked spot still under the pointer (${spot.map((v) => v.toFixed(3)).join(", ")})`);
    await tab.screenshot({ path: path.join(outDir, "2-full-size.png") });
    await tab.mouse.click(at[0], at[1]);
    await tab.waitForTimeout(600);
    const b = await mediaState(tab);
    ok(!b.full && b.rect[3] <= b.view[1] + 1 && b.rect[2] <= b.view[0] + 1, "…another click fits it to the window again");
  } else untested("zoom: the picture fits the window");
  await tab.reload({ waitUntil: "domcontentloaded" });
  await tab.waitForFunction(() => document.documentElement.classList.contains("orr-media"), null, { timeout: 30000 }).catch(() => {});
  await waitLoaded(tab);
  await tab.waitForTimeout(4000);
  s = await mediaState(tab);
  ok(s.media && s.loaded && s.url === mediaUrl(href), "reloading the picture's page keeps the picture");
  await tab.close();
  await page.keyboard.press("Escape");

  // 3. the title (a link to the picture) in the same tab; Back → the thread
  const titleHref = await page.getAttribute("#siteTable .thing.link a.title", "href");
  if (/^https:\/\/(i|preview)\.redd\.it\//.test(titleHref || "")) {
    await page.click("#siteTable .thing.link a.title");
    await page.waitForFunction(() => location.pathname === "/media" && document.documentElement.classList.contains("orr-media"), null, { timeout: 30000 }).catch(() => {});
    await waitLoaded(page);
    await page.waitForTimeout(4000);
    s = await mediaState(page);
    ok(s.media && s.loaded && s.src === titleHref && s.url === mediaUrl(titleHref), `the post's title opens the picture (${s.url.slice(0, 80)})`);
    await page.goBack({ waitUntil: "domcontentloaded" });
    const back = await page.waitForSelector("html.orr-rebuilt #siteTable .thing.link", { timeout: 30000 }).then(() => true).catch(() => false);
    // (the path: a fresh profile's first page keeps Reddit's browser-check extras in its address)
    ok(back && new URL(page.url()).pathname === new URL(thread).pathname, `…and Back goes to the thread (${page.url().slice(0, 80)})`);
  } else untested(`title link isn't a picture: ${titleHref}`);

  // 4. a preview.redd.it picture opened directly
  const prev = await page.evaluate(() => {
    const i = Array.from(document.querySelectorAll("img")).find((x) => /^https:\/\/preview\.redd\.it\//.test(x.src) && x.naturalWidth);
    return i && i.src;
  }).catch(() => null);
  if (prev) {
    await page.goto(prev, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForFunction(() => document.documentElement.classList.contains("orr-media"), null, { timeout: 30000 }).catch(() => {});
    await waitLoaded(page);
    await page.waitForTimeout(3000);
    s = await mediaState(page);
    ok(s.media && s.loaded && s.src === prev, `a preview.redd.it picture opened as a page shows (${prev.slice(0, 70)}…)`);
    await page.screenshot({ path: path.join(outDir, "4-preview.png") });
  } else untested("no preview.redd.it picture on the thread");

  // 5. a picture that's gone: says so (Reddit answers with its own small "it was probably
  // deleted" picture, which shows like any other; with nothing to show, the add-on's message)
  await page.goto(mediaUrl("https://i.redd.it/orrgone0000000.jpeg"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(6000);
  const gone = await page.evaluate(() => {
    const i = document.getElementById("orr-media-img");
    return { media: document.documentElement.classList.contains("orr-media"), msg: (document.querySelector(".orr-media-error") || {}).textContent || "", natural: i && i.complete ? [i.naturalWidth, i.naturalHeight] : null };
  }).catch(() => ({}));
  ok(gone.media && (/couldn't be loaded/.test(gone.msg) || (gone.natural && gone.natural[0] > 0 && gone.natural[0] < 400)),
    `a picture that's gone says so (${gone.msg ? `"${gone.msg}"` : "Reddit's own " + (gone.natural || []).join("×") + " picture"})`);
  await page.screenshot({ path: path.join(outDir, "5-gone.png") });

  // 6. any other picture address on /media: Reddit's page, untouched
  await page.goto("https://www.reddit.com/media?url=" + encodeURIComponent("https://example.com/a.jpg"), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const other = await page.evaluate(() => ({ media: document.documentElement.classList.contains("orr-media"), img: !!document.getElementById("orr-media-img") })).catch(() => ({}));
  ok(!other.media && !other.img, "/media?url= with a picture from elsewhere is left to Reddit");
}

await ctx.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
