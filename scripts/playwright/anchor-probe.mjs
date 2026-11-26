// Probe: does the browser keep what's on screen in place (scroll anchoring) when content is
// added above it on the rebuilt page? (issue #35, 2026-11-26.) Logged out: scrolls a comment
// near the top of the screen, adds a 100px block above it (in the comment list, then before
// the post), and prints how far the browser scrolled to make up for it and how far the
// comment moved (0 = anchoring held), plus the overflow-anchor / overflow styles on the way.
//   node anchor-probe.mjs <ext-dir> <out-dir> [<thread url>]   (CHROMIUM=1: Chromium build)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
const url = argUrl || "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/";
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-jump-"));
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
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(8000);
const res = await page.evaluate(async () => {
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const c = [...document.querySelectorAll(".commentarea .thing.comment")][3];
  window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 200);
  await frame();
  const out = {};
  const probe = async (label, where) => {
    const before = { y: scrollY, top: c.getBoundingClientRect().top };
    const d = document.createElement("div"); d.style.height = "100px"; d.className = "orr-anchor-test";
    where(d);
    await frame();
    out[label] = { scrollDelta: Math.round(scrollY - before.y), moved: Math.round(c.getBoundingClientRect().top - before.top) };
    d.remove(); await frame();
  };
  await probe("above, in the comment list", (d) => document.querySelector(".commentarea .thing.comment").before(d));
  await probe("above, before the post", (d) => document.querySelector("#siteTable").before(d));
  const cs = getComputedStyle(document.documentElement), bs = getComputedStyle(document.body);
  out.styles = { htmlAnchor: cs.overflowAnchor, bodyAnchor: bs.overflowAnchor, htmlOverflow: cs.overflow, bodyOverflow: bs.overflow, htmlScrollBehavior: cs.scrollBehavior, bodyDisplay: bs.display, bodyPosition: bs.position, contentAnchor: getComputedStyle(document.querySelector(".content")).overflowAnchor };
  // which ancestors of the comment break anchoring candidates (positioned / transformed / overflow)
  const chain = [];
  for (let e = c; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.position !== "static" || s.transform !== "none" || s.overflowAnchor === "none" || !/visible/.test(s.overflow)) chain.push(e.tagName + "." + String(e.className).split(" ")[0] + " pos=" + s.position + " ov=" + s.overflow + " oa=" + s.overflowAnchor); }
  out.chain = chain;
  return out;
});
console.log(JSON.stringify(res, null, 1));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
