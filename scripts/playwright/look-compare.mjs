// Look check against REAL old reddit: per URL, where each listing row's rank / votes /
// thumbnail / text start (a thumbnail column that moves row to row = "wobbly"), thumbnail
// sizes, the fonts of a row's parts, the header and sidebar, plus screenshots. Run it twice:
// extDir "-" (no extension) on pages Reddit still serves as old reddit's own HTML — a combined
// /r/a+b/ listing, or /r/x+x/ for one subreddit's real page with its own style and old sidebar
// — and with the extension on the same (or the plain /r/x/) URL; compare <out>/<label>.json.
//   node look-compare.mjs <ext-dir|-> <out-dir> <label> <url>…   (CHROMIUM=1: Chromium build)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, label, ...urls] = process.argv.slice(2);
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
    let buf = "", step = 0;
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const c = buf.indexOf(":"); if (c < 0) return;
        const len = parseInt(buf.slice(0, c), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.slice(c + 1, c + 1 + len)); buf = buf.slice(c + 1 + len);
        if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
        else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
        else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error + ": " + msg.message)) : resolve(msg.addon); }
      }
    });
    sock.on("error", reject);
  });
}
for (let i = 0; extDir !== "-" && !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
// look-compare: per URL, where each listing row's rank / votes / thumbnail / text start, and
// the fonts of the parts of a row and the page. extDir "-" = no extension (real old reddit
// where Reddit serves it, e.g. a combined r/a+b listing).
const out = [];
for (const url of urls) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const m = await page.evaluate(() => {
    const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height) }; };
    const F = (el) => { if (!el) return null; const s = getComputedStyle(el); return `${s.fontSize} ${s.fontWeight} ${s.fontFamily.slice(0, 50)} lh=${s.lineHeight} color=${s.color}`; };
    const rows = Array.from(document.querySelectorAll("#siteTable > .thing.link")).filter((t) => t.offsetParent).slice(0, 25).map((t) => {
      const rank = t.querySelector(":scope > .rank"), mid = t.querySelector(":scope > .midcol"), th = t.querySelector(":scope > .thumbnail"), en = t.querySelector(":scope > .entry");
      const img = th && th.querySelector("img");
      return { rank: rank && rank.textContent, rankR: R(rank), rankStyle: rank && rank.getAttribute("style"), mid: R(mid), midStyle: mid && mid.getAttribute("style"),
        score: (t.querySelector(".midcol .score.unvoted") || t.querySelector(".midcol .score") || {}).textContent,
        th: R(th), thCls: th && th.className.replace(/\s*may-blank\s*/, " ").trim(), img: R(img), imgAttr: img && [img.getAttribute("width"), img.getAttribute("height")], entry: R(en), rowH: R(t).h };
    });
    const first = document.querySelector("#siteTable > .thing.link");
    const q = (s) => first && first.querySelector(s);
    return {
      href: location.href, rebuilt: document.documentElement.classList.contains("orr-rebuilt"),
      htmlFont: F(document.documentElement), bodyFont: F(document.body),
      fonts: { title: F(q("a.title")), domain: F(q(".domain")), tagline: F(q(".tagline")), author: F(q(".tagline .author")), buttons: F(q(".flat-list.buttons a")), score: F(q(".midcol .score.unvoted") || q(".midcol .score")), rank: F(q(".rank")),
        tab: F(document.querySelector(".tabmenu a")), sideTitle: F(document.querySelector(".side .titlebox h1, .side h1")), sideText: F(document.querySelector(".side .md, .side .usertext-body")), srbar: F(document.querySelector("#sr-header-area a")),
        sideH1: F(document.querySelector(".side .titlebox h1")), sideP: F(document.querySelector(".side .md p")), sideH: F(document.querySelector(".side .md h1, .side .md h2, .side .md h3, .side .md h4, .side h2, .side h3")),
        sideNum: F(document.querySelector(".side .subscribers .number, .side .titlebox .number, .side .subscribers")), sideLi: F(document.querySelector(".side .md li, .side li")) },
      sideHtml: (document.querySelector(".side") || {}).innerText ? document.querySelector(".side").innerText.replace(/\s+/g, " ").slice(0, 600) : null,
      rows,
    };
  });
  out.push({ url, ...m });
  const name = label + "-" + url.replace(/^https:\/\/www\.reddit\.com\/?/, "").replace(/[^a-z0-9]+/gi, "_").replace(/_$/, "");
  await page.screenshot({ path: path.join(outDir, name + ".png") });
  await page.screenshot({ path: path.join(outDir, name + "-side.png"), clip: { x: 1000, y: 0, width: 400, height: 900 } });
  await page.close();
}
fs.writeFileSync(path.join(outDir, label + ".json"), JSON.stringify(out, null, 1));
console.log(label, out.map((o) => `${o.url} rebuilt=${o.rebuilt} rows=${o.rows.length}`).join("\n"));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
