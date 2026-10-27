// The extension in Firefox posing as Firefox for Android (Reddit serves mobile markup).
import "./hidden-display.mjs";
import { firefox } from "playwright";
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, outDir, ...urls] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const PORT = 6000 + Math.floor(Math.random() * 1000);
const UA = process.env.UA || "Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0";
const ctx = await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 412, height: 900 }, args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false, "general.useragent.override": UA },
});
const install = () => new Promise((resolve, reject) => {
  const sock = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0), step = 0;
  const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); for (;;) { const c = buf.indexOf(58); if (c < 0) return; const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return; const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); } else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: path.resolve(extDir) }); } else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); } } });
  sock.on("error", reject);
});
for (let i = 0; i < 20; i++) { try { await install(); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 140)));
for (const [i, u] of urls.entries()) {
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log("nav error", String(e).slice(0, 100)));
  await page.waitForSelector("#siteTable .thing, .commentarea", { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => ({ url: location.pathname.slice(0, 50), rebuilt: document.documentElement.classList.contains("orr-rebuilt"), touch: document.documentElement.classList.contains("orr-touch-ua"),
    things: document.querySelectorAll("#siteTable > .thing.link").length, comments: document.querySelectorAll(".commentarea .thing.comment").length, more: document.querySelectorAll(".commentarea .morecomments, a.orr-more").length,
    native: !!document.querySelector("shreddit-app") && !document.documentElement.classList.contains("orr-rebuilt"), title: document.title.slice(0, 40), sw: document.documentElement.scrollWidth }));
  console.log(JSON.stringify(r));
  await page.screenshot({ path: path.join(outDir, "android-" + i + ".png") });
}
console.log("errors", JSON.stringify(errors.slice(0, 5)));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
