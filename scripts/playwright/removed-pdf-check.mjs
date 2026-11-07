// Firefox (temporary add-on), logged out: a post its moderators removed shows "[removed]"
// as its text, like old reddit, not a blank post; and PDF links in a comment stay plain
// links (no window-tall frames — a reading list of PDFs used to be screens of empty boxes).
//   node removed-pdf-check.mjs <ext-dir> <out-dir>   (exits non-zero on failure)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
const ctx = await firefox.launchPersistentContext(profile, {
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
for (let i = 0; i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const REMOVED = "https://www.reddit.com/r/ApplyingToCollege/comments/cnwczp/a_comprehensive_list_of_essay_editing_tools/";
const PDFS = "https://www.reddit.com/r/FinancialCareers/comments/9fwrut/comment/e5zztvr/";
const fails = [];
const page = await ctx.newPage();

// 1) the moderators removed this post's text (the author later pasted it into a comment)
await page.goto(REMOVED, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);
const a = await page.evaluate(() => {
  const post = document.querySelector("#siteTable .thing.link");
  const md = post && post.querySelector(".expando .usertext-body .md");
  return { rebuilt: !!post, text: md ? md.textContent.trim() : null, visible: !!md && md.offsetParent !== null, comments: document.querySelectorAll(".commentarea .thing.comment").length };
});
console.log("removed post:", JSON.stringify(a));
if (!a.rebuilt) fails.push("removed post: page not rebuilt");
if (a.text !== "[removed]" || !a.visible) fails.push(`removed post: text ${JSON.stringify(a.text)} (visible ${a.visible}), want "[removed]"`);
if (!a.comments) fails.push("removed post: no comments");
await page.screenshot({ path: path.join(outDir, "removed.png") });

// 2) a comment that is a reading list of PDF links (http:// ones and one that refuses framing)
await page.goto(PDFS, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".commentarea .thing.comment", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const b = await page.evaluate(() => {
  const c = document.querySelector(".commentarea .thing.comment .usertext-body");
  if (!c) return null;
  const pdfLinks = Array.from(c.querySelectorAll("a[href]")).filter((x) => /\.pdf(\?|#|$)/i.test(x.getAttribute("href")));
  return { pdfLinks: pdfLinks.length, pdfFrames: c.querySelectorAll("iframe.orr-pdf").length, youtube: c.querySelectorAll("iframe[src*='youtube']").length, height: Math.round(c.getBoundingClientRect().height) };
});
console.log("PDF comment:", JSON.stringify(b));
if (!b) fails.push("PDF comment: not found");
else {
  if (b.pdfLinks < 3) fails.push(`PDF comment: only ${b.pdfLinks} PDF links (page changed?)`);
  if (b.pdfFrames) fails.push(`PDF comment: ${b.pdfFrames} PDF frames, want none`);
  if (b.youtube !== 1) fails.push(`PDF comment: ${b.youtube} YouTube players, want 1 (other media still expands)`);
  if (b.height > 1500) fails.push(`PDF comment: ${b.height}px tall`);
}
const el = await page.$(".commentarea .thing.comment");
if (el) await el.screenshot({ path: path.join(outDir, "pdf-comment.png") });

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? "FAIL\n  " + fails.join("\n  ") : "PASS");
process.exit(fails.length ? 1 : 0);
