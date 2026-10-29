// A real screenshot of the native "exact time" tooltip: Firefox on the X display, the real
// pointer moved onto a "N hours ago" with xdotool, then the whole screen captured.
import "./hidden-display.mjs";
import { firefox } from "playwright";
import { execSync } from "node:child_process";
import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, out, url = "https://www.reddit.com/r/pics/"] = process.argv.slice(2);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-shot-"));
const PORT = 6000 + Math.floor(Math.random() * 1000);
const ctx = await firefox.launchPersistentContext(profile, Object.assign({ headless: false, viewport: { width: 1280, height: 760 }, args: ["--start-debugger-server=" + PORT],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false, "browser.shell.checkDefaultBrowser": false, "ui.tooltipDelay": 100 } },
  process.env.FFBIN ? { channel: "moz-firefox", executablePath: process.env.FFBIN } : {}));
const install = () => new Promise((resolve, reject) => { const sock = net.connect(PORT, "127.0.0.1"); let buf = Buffer.alloc(0), step = 0; const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); for (;;) { const c = buf.indexOf(58); if (c < 0) return; const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return; const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); } else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: path.resolve(extDir) }); } else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error)) : resolve(msg.addon); } } });
  sock.on("error", reject); });
for (let i = 0; i < 20; i++) { try { await install(); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link .tagline time", { timeout: 30000 });
await page.waitForTimeout(3000);
const pt = await page.evaluate(() => {
  const ts = Array.from(document.querySelectorAll("#siteTable > .thing.link .tagline time"));
  const t = ts.find((x) => { const r = x.getBoundingClientRect(); return r.top > 200 && r.bottom < innerHeight - 250; }) || ts[2];
  const r = t.getBoundingClientRect();
  return { x: Math.round(window.mozInnerScreenX + r.left + r.width / 2), y: Math.round(window.mozInnerScreenY + r.top + r.height / 2), title: t.title, text: t.textContent };
});
console.log(JSON.stringify(pt));
execSync(`xdotool mousemove ${pt.x - 3} ${pt.y}`); await page.waitForTimeout(300);
execSync(`xdotool mousemove ${pt.x} ${pt.y}`); await page.waitForTimeout(2500);
execSync(`import -window root ${out}`);
fs.writeFileSync(out + ".json", JSON.stringify(pt));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
