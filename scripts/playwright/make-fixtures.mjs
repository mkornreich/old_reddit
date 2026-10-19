// Fixtures for logged-in.mjs without logging in: fetch a thread and its subreddit's
// listing the way the logged-out extension does (Reddit's HTML partials), turn them
// into the classic .json shapes with the extension's own parsers (postFromShreddit /
// commentsFromHtml), and add a plain about.json + rules.json for the subreddit.
//   node make-fixtures.mjs <repo-dir> <out-dir> <thread-path>
//   e.g. node make-fixtures.mjs ../.. ./li-fix /r/Salary/comments/1x5awcf/
// (A logged-in window can save the real .json instead — see rdp-eval.mjs.)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [repo, outDir, threadPath] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
const page = await ctx.newPage();
await page.goto("https://www.reddit.com" + threadPath, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2500);
const sub = (/^\/r\/([^/]+)\//.exec(threadPath) || [])[1];
const html = await page.evaluate(async ([threadPath, sub]) => {
  const get = async (u) => (await fetch(u, { credentials: "include", headers: { Accept: "text/vnd.reddit.partial+html, text/html;q=0.9" } })).text();
  let thread = await get(threadPath);
  // a link without the title slug gets a stub that redirects to the full URL
  const full = !/<shreddit-post/.test(thread) && /id="canonical-url-updater" value="https:\/\/www\.reddit\.com(\/r\/[^"]+)"/.exec(thread);
  if (full) thread = await get(full[1]);
  return { thread, listing: await get(`/svc/shreddit/community-more-posts/hot/?name=${sub}`) };
}, [threadPath, sub]);

// parse with the extension's own code, on a blank reddit.com page (nothing rebuilt)
const lab = await ctx.newPage();
await lab.route("https://www.reddit.com/orr-fixtures", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }));
await lab.goto("https://www.reddit.com/orr-fixtures");
await lab.addScriptTag({ content: "globalThis.chrome = { runtime: { getURL: (p) => p, sendMessage: () => Promise.resolve() }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} }, sync: { get: (k, cb) => cb && cb({}), set: () => {} }, onChanged: { addListener: () => {} } } };" });
for (const f of ["common.js", "rebuild.js"]) await lab.addScriptTag({ content: fs.readFileSync(path.join(repo, f), "utf8") });
const fx = await lab.evaluate(([html, sub]) => {
  const R = globalThis.ORR_REBUILD;
  const tdoc = R.parseHtmlDoc(html.thread);
  const post = Array.from(tdoc.querySelectorAll("shreddit-post")).map(R.postFromShreddit).filter(Boolean)[0];
  const tree = R.commentsFromHtml(tdoc, post.name);
  const fill = (c) => { if (c.kind !== "t1") return; c.data.subreddit = c.data.subreddit || post.subreddit; c.data.link_id = post.name; ((c.data.replies && c.data.replies.data && c.data.replies.data.children) || []).forEach(fill); };
  tree.forEach(fill);
  const posts = Array.from(R.parseHtmlDoc(html.listing).querySelectorAll("shreddit-post")).map(R.postFromShreddit).filter(Boolean);
  return {
    thread: [{ kind: "Listing", data: { children: [{ kind: "t3", data: post }] } }, { kind: "Listing", data: { children: tree } }],
    listing: { kind: "Listing", data: { after: null, children: posts.map((d) => ({ kind: "t3", data: d })) } },
    about: { kind: "t5", data: { name: "t5_fixture", display_name: post.subreddit || sub, display_name_prefixed: "r/" + (post.subreddit || sub), subscribers: 12345, user_is_subscriber: false, user_is_banned: false, public_description: "fixture" } },
    rules: { rules: ["Be civil", "No spam", "Stay on topic"].map((t) => ({ kind: "all", short_name: t, violation_reason: t, description: t })),
      site_rules: ["Spam", "Personal and confidential information", "Threatening, harassing, or inciting violence"] },
  };
}, [html, sub]);
for (const k of ["thread", "listing", "about", "rules"]) fs.writeFileSync(path.join(outDir, k + ".json"), JSON.stringify(fx[k]));
const tops = fx.thread[1].data.children.filter((c) => c.kind === "t1").length;
console.log(`r/${fx.about.data.display_name}: post ${fx.thread[0].data.children[0].data.name}, ${tops} top-level comments, ${fx.listing.data.children.length} listing posts → ${outDir}`);
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
process.exit(tops >= 3 && fx.listing.data.children.length >= 2 ? 0 : 1);
