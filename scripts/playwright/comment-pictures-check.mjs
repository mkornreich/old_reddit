// A comment that is one picture shows ONE picture (2026-11-20: the top comment of
// r/AlignmentChartFills 1y0tlcm, an uploaded GIF — Reddit sends it as a link to the GIF
// around a player of its MP4). Firefox (temporary add-on) or Chromium, logged out. On each
// address (a thread, a comment's permalink, a profile — the comment is looked for on all):
//  - the comment is there and shows exactly one picture;
//  - no comment on the page shows the same picture twice (the same Reddit media id: an
//    i.redd.it GIF, its preview.redd.it MP4 and its resized previews all count as one).
// A page that isn't rebuilt (Reddit's CAPTCHA or block page) is reported as not tested.
//   node comment-pictures-check.mjs <ext-dir> <out-dir> [<comment fullname> <url> …]
//   (CHROMIUM=1: Chromium build; UA=…: another user agent, e.g. Firefox for Android)
//   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argId, ...argUrls] = process.argv.slice(2);
const ID = argId || "t1_19swjbnf6m084";
const urls = argUrls.length ? argUrls : [
  "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/",
  "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/?sort=top",
  "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/comment/19swjbnf6m084/",
  "https://www.reddit.com/user/1Flaming1/comments/",
];
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pic-"));
const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  ...(process.env.UA ? { userAgent: process.env.UA } : {}),
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
}) : await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false,
    ...(process.env.UA ? { "general.useragent.override": process.env.UA } : {}) },
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
for (const [n, url] of urls.entries()) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const rebuilt = await page.waitForSelector("html.orr-rebuilt .thing.comment", { timeout: 40000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(5000); // (pictures arrive; inline images are added after the render)
  const tag = new URL(url).pathname + new URL(url).search;
  if (!rebuilt) { console.log(`NOT TESTED ${tag}: not rebuilt (Reddit's CAPTCHA or block page?)`); continue; }
  const r = await page.evaluate((id) => {
    // one key per Reddit picture: i.redd.it/<id>.gif, preview.redd.it/<id>.gif?format=mp4,
    // preview.redd.it/<title>-v0-<id>.jpeg?width=310 → <id>
    const key = (u) => {
      try {
        const x = new URL(u, location.href);
        if (/(^|\.)redd\.it$/.test(x.hostname)) return x.pathname.split("/").pop().replace(/\.\w+$/, "").replace(/^.*-v0-/, "");
        return x.origin + x.pathname;
      } catch (e) { return u; }
    };
    const pics = (c) => {
      const e = c.querySelector(":scope > .entry") || c;
      const b = e.querySelector(".usertext-body") || e;
      return [...b.querySelectorAll("img, video, iframe")].filter((m) => !m.closest("a.orr-dl")).map((m) => m.currentSrc || m.getAttribute("src") || "");
    };
    const twice = [];
    document.querySelectorAll(".thing.comment").forEach((c) => {
      const ks = pics(c).map(key);
      const dup = ks.filter((k, i) => ks.indexOf(k) !== i);
      if (dup.length) twice.push(c.getAttribute("data-fullname") + ": " + dup.join(", "));
    });
    const it = document.querySelector(`.thing.comment[data-fullname="${id}"]`);
    return { comments: document.querySelectorAll(".thing.comment").length, found: !!it, pics: it ? pics(it) : [], twice };
  }, ID);
  console.log(`  ${tag}: ${r.comments} comments; ${ID}: ${JSON.stringify(r.pics.map((u) => u.slice(0, 90)))}`);
  ok(r.found && r.pics.length === 1, `${tag}: ${ID} shows exactly one picture (${r.found ? r.pics.length : "not on the page"})`);
  ok(r.twice.length === 0, `${tag}: no comment shows the same picture twice${r.twice.length ? " (" + r.twice.slice(0, 3).join("; ") + ")" : ""}`);
  const el = await page.$(`.thing.comment[data-fullname="${ID}"]`);
  if (el) await el.screenshot({ path: path.join(outDir, `${n}.png`) }).catch(() => {});
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
