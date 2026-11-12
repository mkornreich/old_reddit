// Old reddit markup probe (pair with look-compare.mjs): the first rows' HTML, the <head> style
// old reddit adds to size the rank / vote columns for the page, thumbnail <img> sizes, flair
// colors, and where the header's logo, page name and tabs sit.
//   node markup-probe.mjs <ext-dir|-> <out-dir> <label> <url>
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
// markup probe: the first rows' HTML, <head> styles that size the rank / vote columns, and the header
const page = await ctx.newPage();
await page.goto(urls[0], { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const m = await page.evaluate(() => {
  const styles = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).filter((t) => /rank|midcol/.test(t)).map((t) => t.replace(/\s+/g, " ").slice(0, 400));
  const rows = Array.from(document.querySelectorAll("#siteTable > .thing.link")).slice(0, 2).map((t) => t.outerHTML.replace(/\s+/g, " ").slice(0, 3000));
  const imgs = Array.from(document.querySelectorAll("#siteTable > .thing.link .thumbnail img")).slice(0, 6).map((i) => [i.getAttribute("width"), i.getAttribute("height"), i.naturalWidth, i.naturalHeight, i.getAttribute("style"), getComputedStyle(i).objectFit, i.src.slice(0, 90)]);
  const hdr = document.getElementById("header-bottom-left");
  const hb = (sel) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), disp: s.display, pos: s.position, font: s.fontSize + " " + s.fontWeight + " " + s.fontVariant + " " + s.textTransform }; };
  return { styles, rows, imgs, header: hdr ? hdr.outerHTML.replace(/\s+/g, " ").slice(0, 1500) : null,
    boxes: { header: hb("#header"), hbl: hb("#header-bottom-left"), logo: hb("#header-img"), logoLink: hb("#header-img-a"), pagename: hb(".pagename"), tabmenu: hb("#header .tabmenu"), srheader: hb("#sr-header-area") },
    flair: (() => { const f = document.querySelector("#siteTable .linkflairlabel"); if (!f) return null; const s = getComputedStyle(f); return [f.className, s.backgroundColor, s.border, s.borderRadius, s.fontSize, s.color, s.padding]; })(),
    qa: Array.from(document.querySelectorAll("#siteTable > .thing.link:first-child .tagline a.orr-qa")).map((a) => Math.round(a.getBoundingClientRect().width) + "px op=" + getComputedStyle(a).opacity) };
});
fs.writeFileSync(path.join(outDir, label + "-markup.json"), JSON.stringify(m, null, 1));
console.log(JSON.stringify({ styles: m.styles, imgs: m.imgs, boxes: m.boxes, flair: m.flair, qa: m.qa }, null, 1));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
