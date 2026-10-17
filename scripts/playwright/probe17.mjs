// Logged out: what multi_media (text + inline image) posts look like in subreddit listing
// feeds: body text, images in the body, <object> embeds, media-slot images.   node probe17.mjs
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"] });
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(2000);
console.log(JSON.stringify(await page.evaluate(async () => {
  const out = [];
  for (const sub of ["mildlyinfuriating", "lowereastside", "gaming", "nyc", "AskNYC"]) {
    const t = await (await fetch(`/svc/shreddit/community-more-posts/hot/?name=${sub}`, { headers: { Accept: "text/vnd.reddit.partial+html" } })).text();
    const d = new DOMParser().parseFromString(t, "text/html");
    d.querySelectorAll("shreddit-post[post-type='multi_media']").forEach((p) => {
      const body = p.querySelector(`[id="${p.id}-post-rtjson-content"]`) || p.querySelector("shreddit-post-text-body");
      const media = p.querySelector("[slot='post-media-container']"); const obj = body && body.querySelector("object");
      out.push({ sub, id: p.id, title: p.getAttribute("post-title").slice(0, 40),
        bodyText: body ? body.textContent.replace(/\s+/g, " ").trim().slice(0, 60) : null, bodyImgs: body ? body.querySelectorAll("img").length : null,
        bodyTags: body ? Array.from(new Set(Array.from(body.querySelectorAll("*")).map((e) => e.tagName.toLowerCase()))).slice(0, 8) : null,
        mediaImgs: media ? Array.from(media.querySelectorAll("img")).map((i) => (i.getAttribute("src") || i.getAttribute("data-lazy-src") || "").slice(0, 60)).slice(0, 3) : null,
        objectHtml: obj ? obj.outerHTML.replace(/\s+/g, " ").slice(0, 400) : null, primary: !!p.querySelector("img[data-post-media-primary]"), gallery: !!p.querySelector("gallery-carousel") });
    });
  }
  return out;
}), null, 1));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
