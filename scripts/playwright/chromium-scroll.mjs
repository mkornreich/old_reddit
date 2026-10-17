// Chromium twin of firefox-scroll.mjs: scroll a page step by step and log items, stubs,
// height, jumps, errors and failed requests.   node chromium-scroll.mjs <ext-dir> <out-dir> <url> [steps]
import "./hidden-display.mjs";
import { chromium } from "playwright";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [extDir, outDir, url, stepsArg] = process.argv.slice(2);
const STEPS = parseInt(stepsArg || "14", 10);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
const errors = [], consoleErr = [], failed = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 200)); });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErr.push(m.type() + ": " + m.text().slice(0, 200)); });
page.on("response", (r) => { if (r.status() >= 400 && /reddit\.com/.test(r.url()) && !/\.json|\/api\/me/.test(r.url())) failed.push(r.status() + " " + r.request().method() + " " + r.url().replace("https://www.reddit.com", "").slice(0, 120)); });
page.on("requestfailed", (r) => failed.push("FAILED " + r.method() + " " + r.url().slice(0, 120) + " " + ((r.failure() || {}).errorText || "")));
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link, .commentarea", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(4000);
const snap = () => page.evaluate(() => ({
  y: Math.round(scrollY), h: document.documentElement.scrollHeight,
  comments: document.querySelectorAll(".commentarea .thing.comment").length,
  stubs: document.querySelectorAll("a.orr-more").length,
  loading: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => a.dataset.orrLoading).map((a) => a.textContent.slice(0, 40)),
  failedStubs: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => /failed|rate-limited/.test(a.textContent)).map((a) => a.textContent.slice(0, 60)),
  videos: document.querySelectorAll("video").length, iframes: document.querySelectorAll("iframe").length,
}));
const rows = [];
let prev = await snap();
rows.push({ step: 0, ...prev });
for (let i = 1; i <= STEPS; i++) {
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(1500);
  const s = await snap();
  rows.push({ step: i, ...s, jump: s.y - prev.y < 0 ? "UP " + (s.y - prev.y) : "" });
  prev = s;
  if (i % 4 === 0) await page.screenshot({ path: path.join(outDir, `scroll-${String(i).padStart(2, "0")}.png`) });
}
await page.waitForTimeout(3000);
rows.push({ step: "end", ...(await snap()) });
for (const r of rows) console.log(JSON.stringify(r));
console.log("pageerrors", JSON.stringify(errors));
console.log("console", JSON.stringify(consoleErr.slice(0, 15)));
console.log("failed", JSON.stringify(failed.slice(0, 15)));
await page.screenshot({ path: path.join(outDir, "scroll-end.png") });
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
