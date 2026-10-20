// Logged out, Reddit's feeds send an image / gallery / video post without its text even
// when it has some (only the post's own page carries it). Opening such a post's preview in
// a listing must add the text under the media — fetched once, only the top of the post's
// page — and a media post with no text gets nothing extra. Also: links inside a feed post's
// text (Reddit nests them in <object>s) keep their words.
//   node media-text.mjs <ext-dir> <out-dir> <listing-url> <t3_id with text> [--firefox]
//   e.g. node media-text.mjs ./ext ./out https://www.reddit.com/r/BoyDinnerDiaries/ t3_1xa0mrz
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
const [extDir, outDir, url, postId] = args;
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
const errors = [], threadReqs = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
page.on("request", (r) => { if (/\/comments\/[a-z0-9]+\//.test(r.url()) && r.resourceType() === "fetch") threadReqs.push(r.url().replace("https://www.reddit.com", "").slice(0, 70)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const expandoOf = (id) => page.evaluate((id) => {
  const t = document.getElementById("thing_" + id);
  const ex = t && t.querySelector(":scope > .entry > .expando");
  return t && { open: !!ex && ex.style.display !== "none", media: !!(ex && ex.querySelector("img, video, .orr-gallery")), textcheck: t.getAttribute("data-orr-textcheck"),
    text: ((ex && ex.querySelector(".orr-post-text")) || { textContent: "" }).textContent.replace(/\s+/g, " ").trim().slice(0, 90) };
}, id);
const toggle = async (id) => {
  await page.locator(`#thing_${id} > .entry > .expando-button`).scrollIntoViewIfNeeded();
  await page.click(`#thing_${id} > .entry > .expando-button`);
};

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2500);
const before = await expandoOf(postId);
check(`${postId} is listed, marked for its text`, !!before && before.textcheck === "1", JSON.stringify(before));
if (before) {
  await toggle(postId);
  await page.waitForFunction((id) => { const t = document.getElementById("thing_" + id); return t && t.getAttribute("data-orr-textcheck") === "done"; }, postId, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  const open1 = await expandoOf(postId);
  await page.screenshot({ path: path.join(outDir, "media-text.png") });
  const box = page.locator(`#thing_${postId} .orr-post-text`);
  if (await box.count()) { await box.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(outDir, "media-text-body.png") }); }
  console.log(JSON.stringify(open1));
  check("opening its preview adds the post's text under the media", open1.open && open1.media && open1.text.length > 20, JSON.stringify(open1));
  const n = threadReqs.length;
  await toggle(postId); await page.waitForTimeout(300); await toggle(postId); await page.waitForTimeout(1500);
  const open2 = await expandoOf(postId);
  check("closing and reopening: the text once, no second fetch", threadReqs.length === n && n === 1 &&
    (await page.locator(`#thing_${postId} .orr-post-text`).count()) === 1 && open2.open, JSON.stringify({ threadReqs }));
}
// another media post in the listing, with no text: nothing added (at most one fetch)
const other = await page.evaluate((id) => { const t = Array.from(document.querySelectorAll("#siteTable > .thing.link[data-orr-textcheck='1']")).find((x) => x.dataset.fullname !== id); return t && t.dataset.fullname; }, postId);
if (other) {
  await toggle(other);
  await page.waitForFunction((id) => { const t = document.getElementById("thing_" + id); return t && t.getAttribute("data-orr-textcheck") === "done"; }, other, { timeout: 20000 }).catch(() => {});
  const o = await expandoOf(other);
  console.log("other:", other, JSON.stringify(o));
  check("another media post's preview opens (text only if it has some)", o.open && o.media && o.textcheck === "done", JSON.stringify(o));
}
// links inside a feed post's text keep their words (Reddit wraps them in <object>s)
const linkWords = await page.evaluate(() => {
  const links = Array.from(document.querySelectorAll("#siteTable .expando .md a[href]"));
  return { links: links.length, empty: links.filter((a) => !a.textContent.trim() && !a.querySelector("img")).length };
});
check("links in listed posts' text keep their words", linkWords.empty === 0, JSON.stringify(linkWords));
check("no page errors", !errors.length, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
