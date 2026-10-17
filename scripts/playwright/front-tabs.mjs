// Logged-out front page + r/all sort tabs actually sort (PR #30): for each tab, the
// rebuilt listing's post ages; plus tab tooltips, the default tab, and infinite scroll.
//   node front-tabs.mjs <ext-dir> <out-dir>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 160)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const look = async (p) => {
  await page.goto("https://www.reddit.com" + p, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const now = Date.now() / 1000;
    const ages = Array.from(document.querySelectorAll("#siteTable .thing.link")).map((t) => (now - +t.dataset.created) / 3600).filter((h) => h >= 0).sort((a, b) => a - b);
    const tabs = Array.from(document.querySelectorAll(".tabmenu li")).map((li) => (li.classList.contains("selected") ? "*" : "") + li.innerText.trim() + (li.querySelector("a[title]") ? "" : "(no title)"));
    return { n: ages.length, newest: ages.length ? +ages[0].toFixed(1) : null, oldest: ages.length ? +ages[ages.length - 1].toFixed(1) : null, median: ages.length ? +ages[Math.floor(ages.length / 2)].toFixed(1) : null, tabs: tabs.join(" ") };
  });
};
const r = {};
for (const p of ["/", "/hot/", "/new/", "/top/?t=hour", "/controversial/", "/r/all/", "/r/all/new/"]) { r[p] = await look(p); console.log(p.padEnd(16), JSON.stringify(r[p])); }
check("front page defaults to the 'best' tab", /^\*best/.test(r["/"].tabs), r["/"].tabs);
check("every tab has a tooltip", !/no title/.test(r["/"].tabs));
check("'new' really is newest (median < 1h)", r["/new/"].median != null && r["/new/"].median < 1, JSON.stringify(r["/new/"]));
check("'top / past hour' is within ~1.5h", r["/top/?t=hour"].oldest != null && r["/top/?t=hour"].oldest < 1.5, JSON.stringify(r["/top/?t=hour"]));
check("'new' differs from 'hot'", r["/new/"].median !== r["/hot/"].median);
check("r/all rebuilt with the same tabs (best default)", r["/r/all/"].n > 0 && /best/.test(r["/r/all/"].tabs), r["/r/all/"].tabs);
// infinite scroll on the front page
await look("/");
const before = await page.locator("#siteTable .thing.link").count();
for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 6000); await page.waitForTimeout(1200); }
await page.waitForTimeout(2500);
const after = await page.locator("#siteTable .thing.link").count();
check("front page infinite scroll", after > before, `${before} → ${after}`);
check("no page errors", errors.length === 0, JSON.stringify(errors));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
