// Logged-out search: new Reddit refuses search.json, so the extension reads its search
// results partials instead. Checks a search URL is rebuilt with full result rows (title,
// time, author, subreddit, votes, comments), that scrolling adds pages without repeats,
// that the sort / time links work, and that a subreddit search stays in that subreddit.
//   node search-check.mjs <ext-dir> <out-dir> [search-url] [--firefox]
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
const [extDir, outDir, url = "https://www.reddit.com/search/?q=Gemma+5+LLM+capabilities"] = args;
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
const settle = async () => { await page.waitForSelector("#siteTable .thing.link, #siteTable .thing", { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(2500); };
const state = () => page.evaluate(() => {
  const things = Array.from(document.querySelectorAll("#siteTable > .thing.link"));
  const ids = things.map((t) => t.dataset.fullname);
  const row = (t) => t && {
    title: t.querySelector("a.title").textContent.slice(0, 50),
    tagline: t.querySelector(".tagline").textContent.replace(/\s+/g, " ").trim().slice(0, 90),
    score: t.querySelector(".midcol .score.unvoted, .midcol .score").textContent,
    comments: t.querySelector("a.comments").textContent,
    domain: !!t.querySelector(".title .domain"),
  };
  return {
    url: location.pathname + location.search, rebuilt: !!document.querySelector("#siteTable"),
    items: ids.length, unique: new Set(ids).size, subs: Array.from(new Set(things.map((t) => t.dataset.subreddit))),
    noTime: things.filter((t) => !t.querySelector(".tagline time")).length,
    noAuthor: things.filter((t) => !t.querySelector(".tagline .author") && !/ by \[deleted\]/.test(t.querySelector(".tagline").textContent)).length,
    ranks: things.slice(0, 30).map((t) => +t.querySelector(".rank").textContent),
    thumbs: things.filter((t) => t.querySelector("a.thumbnail img")).length,
    first: row(things[0]), noResults: /No results/.test((document.getElementById("siteTable") || {}).textContent || ""),
    y: Math.round(scrollY),
  };
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await settle();
const s0 = await state();
await page.screenshot({ path: path.join(outDir, "search-top.png") });
console.log(JSON.stringify(s0));
check("search page rebuilt with results", s0.rebuilt && s0.items >= 7, s0.items + " results");
check("every result has a time and an author (or [deleted])", !s0.noTime && !s0.noAuthor, JSON.stringify([s0.noTime, s0.noAuthor]));
check("results are numbered 1, 2, 3…", s0.ranks.every((r, i) => r === i + 1), JSON.stringify(s0.ranks));
check("no empty \"()\" domain", s0.first && !s0.first.domain);
await page.mouse.move(600, 500);
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(900); }
await page.waitForTimeout(2000);
const s1 = await state();
console.log(JSON.stringify(s1));
check("scrolling loads more results", s1.items > s0.items, s0.items + " → " + s1.items);
check("no result shown twice", s1.unique === s1.items, s1.unique + " unique of " + s1.items);
await page.screenshot({ path: path.join(outDir, "search-scrolled.png") });

// sort: top, then time: this week
await page.evaluate(() => window.scrollTo(0, 0));
await page.click(".content .menuarea a:text-is('top')");
await settle();
await page.click(".content .menuarea a:text-is('past week')").catch(async () => { await page.click(".content .menuarea a:has-text('week')"); });
await settle();
const s2 = await state();
console.log(JSON.stringify(s2));
check("sort / time links work", /sort=top/.test(s2.url) && /t=week/.test(s2.url) && s2.items >= 7 && s2.first && s2.first.title !== (s0.first && s0.first.title), s2.url);

// a subreddit search limited to that subreddit
await page.goto("https://www.reddit.com/r/LocalLLaMA/search/?q=gemma&restrict_sr=on", { waitUntil: "domcontentloaded", timeout: 45000 });
await settle();
const s3 = await state();
console.log(JSON.stringify(s3));
check("subreddit search stays in the subreddit", s3.items >= 7 && s3.subs.length === 1 && /^LocalLLaMA$/i.test(s3.subs[0]), JSON.stringify(s3.subs));
await page.screenshot({ path: path.join(outDir, "search-sub.png") });
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
