// Combined r/a+b listings logged out (issue #31): Reddit serves them as old reddit's own
// HTML, which the extension now reads, so they rebuild with infinite scroll like any
// listing. Checks the rows (numbered, no repeats, times/authors), scrolling adds pages,
// the sort / time tabs work, and the previews old reddit loaded on demand — a text post's
// text, a gallery, a video — fill in when opened (an image shows straight away).
//   node multi-check.mjs <ext-dir> <out-dir> [multi-url] [--firefox]
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
const [extDir, outDir, url = "https://www.reddit.com/r/pics+AskReddit+videos+gaming+Android+interestingasfuck+earthporn+sysadmin/"] = args;
fs.mkdirSync(outDir, { recursive: true });
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
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const settle = async () => { await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500); };
const state = () => page.evaluate(() => {
  const things = Array.from(document.querySelectorAll("#siteTable > .thing.link"));
  const ids = things.map((t) => t.dataset.fullname);
  return {
    url: location.pathname + location.search, rebuilt: document.documentElement.classList.contains("orr-rebuilt") && !!document.getElementById("siteTable"),
    items: ids.length, unique: new Set(ids).size, subs: new Set(things.map((t) => t.dataset.subreddit)).size,
    ranks: things.slice(0, 30).map((t) => +t.querySelector(".rank").textContent),
    noTime: things.filter((t) => !t.querySelector(".tagline time")).length,
    noAuthor: things.filter((t) => !t.querySelector(".tagline .author") && !/ by \[deleted\]/.test(t.querySelector(".tagline").textContent)).length,
    lazy: things.filter((t) => t.getAttribute("data-orr-lazyexp")).map((t) => t.querySelector(".expando-button").className.replace(/expando-button|collapsed|expanded/g, "").trim()),
    images: things.filter((t) => t.querySelector(".expando img.preview")).length,
  };
});
const open = async (sel) => {
  const id = await page.evaluate((sel) => { const t = document.querySelector(sel); return t && t.id; }, sel);
  if (!id) return null;
  await page.locator(`#${id} > .entry > .expando-button`).scrollIntoViewIfNeeded();
  await page.click(`#${id} > .entry > .expando-button`);
  await page.waitForFunction((id) => { const t = document.getElementById(id); const v = t && t.getAttribute("data-orr-lazyexp"); return !v || v === "done"; }, id, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(800);
  return page.evaluate((id) => {
    const t = document.getElementById(id);
    const ex = t.querySelector(":scope > .entry > .expando");
    return { id, open: ex.style.display !== "none", state: t.getAttribute("data-orr-lazyexp"), text: ((ex.querySelector(".md") || {}).textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      video: !!ex.querySelector("video, .orr-video-fallback"), gallery: (ex.querySelector(".orr-gallery") || { dataset: {} }).dataset.n || 0, img: !!ex.querySelector("img"), msg: (ex.querySelector(".orr-lazy-msg") || {}).textContent || "" };
  }, id);
};

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await settle();
const s0 = await state();
console.log(JSON.stringify(s0));
await page.screenshot({ path: path.join(outDir, "multi-top.png") });
check("combined listing rebuilt in the old layout", s0.rebuilt && s0.items >= 20 && s0.subs >= 2, JSON.stringify({ items: s0.items, subs: s0.subs }));
check("numbered 1, 2, 3…; every row has a time and an author", s0.ranks.every((r, i) => r === i + 1) && !s0.noTime && !s0.noAuthor, JSON.stringify([s0.noTime, s0.noAuthor]));
// previews
const textPost = await open("#siteTable > .thing.link[data-orr-lazyexp='1'] > .entry > .expando-button.selftext");
const t1 = textPost ? null : await open("#siteTable > .thing.link[data-orr-lazyexp='1']:has(> .entry > .expando-button.selftext)");
const tp = textPost || t1;
console.log("text:", JSON.stringify(tp));
check("a text post's preview fills in its text", !tp || (tp.open && tp.state === "done" && tp.text.length > 10), JSON.stringify(tp));
const vp = await open("#siteTable > .thing.link[data-orr-lazyexp='1']:has(> .entry > .expando-button.video)");
console.log("video:", JSON.stringify(vp));
check("a video post's preview fills in a player", !vp || (vp.open && vp.state === "done" && vp.video), JSON.stringify(vp));
const gp = await open("#siteTable > .thing.link[data-orr-lazyexp='1']:has(> .entry > .expando-button.gallery)");
console.log("gallery:", JSON.stringify(gp));
check("a gallery's preview fills in its images", !gp || (gp.open && gp.state === "done" && +gp.gallery >= 1), JSON.stringify(gp));
const ip = await open("#siteTable > .thing.link:not([data-orr-lazyexp]):has(> .entry > .expando > .expando-container img.preview)");
console.log("image:", JSON.stringify(ip));
check("an image post's preview shows its image", !ip || (ip.open && ip.img), JSON.stringify(ip));
check("previews of each kind were tried", [tp, vp, gp, ip].filter(Boolean).length >= 2, JSON.stringify(s0.lazy));
await page.screenshot({ path: path.join(outDir, "multi-previews.png") });
// infinite scroll
await page.evaluate(() => window.scrollTo(0, 0));
await page.mouse.move(600, 500);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1500); await page.waitForTimeout(900); }
await page.waitForTimeout(2000);
const s1 = await state();
check("scrolling loads more pages, no post twice", s1.items >= s0.items + 20 && s1.unique === s1.items, `${s0.items} → ${s1.items} (${s1.unique} unique)`);
check("numbering carries on across pages", (await page.evaluate(() => Array.from(document.querySelectorAll("#siteTable > .thing.link .rank")).every((r, i) => +r.textContent === i + 1))));
// sort / time tabs
await page.evaluate(() => window.scrollTo(0, 0));
await page.click(".tabmenu a:text-is('top')");
await settle();
await page.click(".content a:text-is('past week')").catch(() => {});
await settle();
const s2 = await state();
check("top / past week tabs work", /\/top\/?/.test(s2.url) && /t=week/.test(s2.url) && s2.items >= 20, s2.url);
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
