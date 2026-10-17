// Logged out: follow a thread's top-level "more comments" partial chain to the end and
// count comments by depth — how many top-level comments really exist, and what the
// last partial in the chain looks like.   node probe16.mjs <permalink>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const perma = process.argv[2];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-probe-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2000);
const out = await page.evaluate(async (perma) => {
  const ACC = "text/vnd.reddit.partial+html, text/html;q=0.9";
  const parse = (t) => { const d = new DOMParser().parseFromString(t, "text/html"); for (let i = 0; i < 25; i++) { const ts = d.querySelectorAll("template"); if (!ts.length) break; ts.forEach((x) => x.replaceWith(x.content)); } return d; };
  const depthCount = (d) => { const c = {}; d.querySelectorAll("shreddit-comment").forEach((e) => { const k = e.getAttribute("depth"); c[k] = (c[k] || 0) + 1; }); return c; };
  const topStub = (d) => d.querySelector("faceplate-partial#top-level-more-comments-partial") ||
    Array.from(d.querySelectorAll("faceplate-partial[src*='/more-comments/']")).find((p) => !p.closest("shreddit-comment") && /top-level=1/.test(p.getAttribute("src") || ""));
  const rootStubs = (d) => Array.from(d.querySelectorAll("faceplate-partial[src*='/more-comments/']")).filter((p) => !p.closest("shreddit-comment")).map((p) => (p.id || "") + " " + (p.getAttribute("src") || "").slice(0, 160));
  const steps = [];
  let d = parse(await (await fetch(perma, { credentials: "include", headers: { Accept: ACC } })).text());
  steps.push({ step: "page", depths: depthCount(d), rootStubs: rootStubs(d) });
  for (let i = 0; i < 40; i++) {
    const p = topStub(d);
    if (!p) break;
    const body = new URLSearchParams();
    const c = p.querySelector("input[name='cursor']");
    if (c) body.set("cursor", c.value);
    const r = await fetch(p.getAttribute("src"), { method: "POST", credentials: "include", headers: { Accept: ACC, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    d = parse(await r.text());
    steps.push({ step: i + 1, status: r.status, depths: depthCount(d), rootStubs: rootStubs(d) });
  }
  return steps;
}, perma);
for (const s of out) console.log(JSON.stringify(s));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
