// The comment sort bar ("sorted by: best · top · new · controversial · old · qa | collapse all")
// stays on one row when zoomed in (2026-11-13: on r/LosAngeles, whose style ends the comments
// short of the sidebar, "collapse all" wrapped at ~150% zoom — old reddit's 310px right margin
// took that room a second time). Firefox (temporary add-on) or Chromium, logged out. For each thread, at
// narrowing window widths (= browser zoom: 1100 is a 1600px window at ~145%):
//  - the bar is one row, nothing in it clipped, clear of the sidebar;
//  - its text keeps its normal size (13px) wherever it fits, and shrinks only where it can't;
//  - "collapse all" shows; with the add-on's font size at 150% / 200% it's still one row;
//  - with a sidebar reaching past it (no subreddit style), it keeps clear of it and stays put.
//   node sortbar-check.mjs <ext-dir> <out-dir> [<thread url or subreddit> …]   (CHROMIUM=1: Chromium build)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, ...argUrls] = process.argv.slice(2);
const urls = argUrls.length ? argUrls : [
  "https://www.reddit.com/r/LosAngeles/comments/1xvp4m0/lax_now_13_friday_2026/", // subreddit style, comments end short of the sidebar
];
const WIDTHS = (process.env.WIDTHS || "1400,1280,1100,960,860,800,640").split(",").map(Number);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
// CHROMIUM=1: Playwright's Chromium with the unpacked Chromium build (stage-ext.mjs without --firefox)
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
const page = await ctx.newPage();

// the bar's state: rows of text, clipped?, its font size, overlap with the sidebar, and
// whether its text would fit on one line at the normal size
const measure = () => page.evaluate(() => {
  const m = document.querySelector(".commentarea > .menuarea");
  if (!m) return null;
  const tops = new Set();
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3 && c.textContent.trim()) {
        const rg = document.createRange(); rg.selectNodeContents(c);
        for (const r of rg.getClientRects()) if (r.width) tops.add(Math.round(r.top + r.height / 2));
      } else if (c.nodeType === 1 && getComputedStyle(c).display !== "none") walk(c);
    }
  };
  walk(m);
  // tops within a few px are the same row (links and separators sit at slightly different y)
  const rows = [...tops].sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 4).length;
  const mr = m.getBoundingClientRect();
  const side = document.querySelector(".side");
  const sr = side && getComputedStyle(side).display !== "none" ? side.getBoundingClientRect() : null;
  const overlapsSide = !!(sr && sr.width && sr.top < mr.bottom && sr.bottom > mr.top && sr.left < mr.right && sr.right > mr.left);
  const cs = getComputedStyle(m);
  // what the normal size needs, measured the same way the add-on does
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font-size:small";
  m.childNodes.forEach((n) => probe.appendChild(n.cloneNode(true)));
  document.body.appendChild(probe); // (outside the bar: no font-size inherited from it)
  probe.style.fontFamily = cs.fontFamily;
  const need = parseFloat(getComputedStyle(probe).width);
  probe.remove();
  return {
    rows, fontSize: parseFloat(cs.fontSize), clipped: m.scrollWidth > m.clientWidth + 1,
    room: Math.round(parseFloat(cs.width)), need: Math.round(need), overlapsSide,
    left: Math.round(mr.left), right: Math.round(mr.right), sideLeft: sr ? Math.round(sr.left) : null,
    contentMarginRight: getComputedStyle(m.closest(".content")).marginRight,
    allShown: !m.querySelector(".orr-collapse-all-wrap").hidden,
  };
});

for (let url of urls) {
  await page.setViewportSize({ width: 1400, height: 900 });
  if (!url.includes("/comments/")) { // a subreddit: its first post with comments
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("#siteTable .thing.link a.comments", { timeout: 30000 });
    await page.waitForTimeout(1500);
    url = new URL(await page.evaluate(() => Array.from(document.querySelectorAll("#siteTable > .thing.link:not(.stickied) a.comments"))
      .find((a) => /\d/.test(a.textContent)).getAttribute("href")), url).href;
  }
  const tag = url.split("/comments/")[0].split("/r/")[1] || url;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector(".commentarea > .menuarea", { timeout: 30000 });
  await page.waitForTimeout(4000); // the subreddit's own style arrives after the page
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(500);
    const r = await measure();
    console.log(`  ${tag} @${w}: ${JSON.stringify(r)}`);
    if (!r) { ok(false, `${tag} @${w}: a sort bar`); continue; }
    const fits = r.need <= r.room;
    ok(r.rows === 1 && !r.clipped, `${tag} @${w}: the sort bar is one row, nothing clipped (rows ${r.rows})`);
    ok(!r.overlapsSide, `${tag} @${w}: the sort bar stays clear of the sidebar`);
    ok(fits ? r.fontSize === 13 : r.fontSize < 13 && r.fontSize >= 8,
      `${tag} @${w}: its text is ${fits ? "the normal size (it fits)" : "shrunk to fit"} (${r.fontSize}px; needs ${r.need}px, has ${r.room}px)`);
    if (w === WIDTHS[0]) ok(r.allShown, `${tag}: "collapse all" shows`);
    await page.locator(".commentarea > .menuarea").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, `${tag}-w${w}.png`) });
  }
  // a sidebar that reaches past the bar (a short post): without a subreddit style the comment
  // column runs under the sidebar, so the bar must keep clear of it by itself, and stay put
  // (not pushed down below the sidebar)
  for (const w of [1100, 800]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(400);
    const y0 = await page.evaluate(() => {
      const m = document.querySelector(".commentarea > .menuarea"), s = document.querySelector(".side");
      const top = m.getBoundingClientRect().top + scrollY;
      s.style.minHeight = (top + 400 - (s.getBoundingClientRect().top + scrollY)) + "px";
      return Math.round(top);
    });
    await page.waitForTimeout(500);
    const t = await measure();
    const y1 = await page.evaluate(() => Math.round(document.querySelector(".commentarea > .menuarea").getBoundingClientRect().top + scrollY));
    console.log(`  ${tag} tall sidebar @${w}: ${JSON.stringify(t)} top ${y0}→${y1}`);
    ok(t && t.rows === 1 && !t.clipped && !t.overlapsSide && Math.abs(y1 - y0) < 2,
      `${tag} @${w}, sidebar beside the bar: one row, clear of the sidebar, in place`);
    await page.locator(".commentarea > .menuarea").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, `${tag}-tallside-w${w}.png`) });
    await page.evaluate(() => { document.querySelector(".side").style.minHeight = ""; });
  }
  // the add-on's own font size setting (zooms the comment area): 150%, then 200% where the
  // bar can't fit at the normal size
  for (const [scale, w] of [[1.5, 1100], [2, 860]]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate((k) => {
      document.documentElement.style.setProperty("--orr-font-scale", String(k));
      document.documentElement.classList.add("orr-custom-font");
    }, scale);
    await page.waitForTimeout(600);
    const z = await measure();
    console.log(`  ${tag} font ${scale * 100}% @${w}: ${JSON.stringify(z)}`);
    ok(z && z.rows === 1 && !z.clipped && !z.overlapsSide, `${tag} @${w}: with font size ${scale * 100}%, the sort bar is one row, clear of the sidebar`);
    await page.locator(".commentarea > .menuarea").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, `${tag}-font${scale * 100}-w${w}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--orr-font-scale");
    document.documentElement.classList.remove("orr-custom-font");
  });
}

await ctx.close();
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
