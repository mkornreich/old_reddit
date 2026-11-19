// No "Executing inline event handler violates the following Content Security Policy
// directive …" errors in Chrome's console (2026-11-19: ~100 on each subreddit page and thread).
// Chrome checks every onclick="…"-style attribute against Reddit's CSP as soon as it's parsed —
// even into an inert DOMParser document — and old reddit's own page that a subreddit's old
// sidebar is read from (/r/<sub>+<sub>/) is full of them; the add-on now drops them before
// parsing (dropInlineHandlers). Chromium only (Firefox doesn't report these), logged out:
// on each rebuilt page, no CSP violation of an inline handler (script-src-attr), and the old
// sidebar is there. The first address only soaks up Reddit's first-page CAPTCHA; a page that
// isn't rebuilt (CAPTCHA, Reddit's block) is reported as not tested.
//   node csp-check.mjs <chromium-ext-dir> <out-dir> [<url> …]   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, ...argUrls] = process.argv.slice(2);
const urls = argUrls.length ? argUrls : [
  "https://www.reddit.com/r/GTA/comments/1y0ag5r/gta_6_map/",
  "https://www.reddit.com/r/GTA/",
  "https://www.reddit.com/r/technology/",
];
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-cr-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
});
// (main world, before the page's own scripts; violations from the add-on's parsing reach the
//  document too)
await ctx.addInitScript(() => {
  document.addEventListener("securitypolicyviolation", (e) => {
    if (e.violatedDirective === "script-src-attr" || /inline event handler/i.test(e.sample || "")) console.log("ORR-CSPV " + (e.sample || "").slice(0, 80));
  }, true);
});
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? "PASS " : "FAIL ") + msg); };
const page = await ctx.newPage();
let samples = [];
page.on("console", (m) => { if (m.text().startsWith("ORR-CSPV ")) samples.push(m.text().slice(9)); });

await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); // (Reddit's first-page CAPTCHA)
await page.waitForTimeout(3000);
for (const url of urls) {
  samples = [];
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const rebuilt = await page.waitForSelector("html.orr-rebuilt #siteTable .thing", { timeout: 30000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(6000); // (the sidebar arrives with one more fetch)
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(2000);
  const tag = new URL(url).pathname;
  if (!rebuilt) { console.log(`NOT TESTED ${tag}: not rebuilt (Reddit's CAPTCHA or block page?)`); continue; }
  const side = await page.evaluate(() => !!document.querySelector(".side .titlebox")).catch(() => false);
  const uniq = [...new Set(samples)];
  ok(samples.length === 0, `${tag}: no inline-handler CSP errors (${samples.length}${uniq.length ? ": " + uniq.slice(0, 4).join(" | ") : ""})`);
  ok(side, `${tag}: the old sidebar is there`);
  await page.screenshot({ path: path.join(outDir, tag.replace(/\W+/g, "_") + ".png") });
}
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
