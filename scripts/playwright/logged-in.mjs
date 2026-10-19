// Logged-in features (issues #1 / #11) against a FAKE login — nothing reaches your
// Reddit account. Every write endpoint is intercepted and recorded, /api/me.json says
// you're "orr_test_user", and the thread / listing / subreddit JSON comes from saved
// fixtures. Clicks through: voting (+ undo, + a failing vote), vote weight, save,
// report, reply with live preview + big editor, a top-level comment, edit and delete
// of your own comment, keyboard shortcuts, join/leave, hide (+ undo) on a listing, the
// inbox (auto mark-read, reply, mark unread), your saved tab, and the logged-out view.
//   node logged-in.mjs <ext-dir> <out-dir> <fixtures-dir>
// fixtures-dir: thread.json (a /r/<sub>/comments/<id>/.json), listing.json (/r/<sub>/.json),
// about.json, rules.json — e.g. saved with rdp-eval.mjs from a logged-in Firefox window
// (firefox-loggedin.mjs). The thread's subreddit and post id are read from the fixture.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, fixDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const load = (f) => JSON.parse(fs.readFileSync(path.join(fixDir, f), "utf8"));
const thread = load("thread.json");
const listing = load("listing.json");
const about = load("about.json");
const rules = load("rules.json");
const ME = "orr_test_user";
const post = thread[0].data.children[0].data;
const SUB = post.subreddit;
const tops = thread[1].data.children.filter((c) => c.kind === "t1");
// Make one top-level comment yours (edit / delete) and start everything unvoted / unsaved.
const mine = tops[1].data;
mine.author = ME;
mine.body = "original text";
const walk = (d) => { d.likes = null; d.saved = false; (d.replies && d.replies.data ? d.replies.data.children : []).forEach((c) => c.kind === "t1" && walk(c.data)); };
post.likes = null; post.saved = false; tops.forEach((c) => walk(c.data));
listing.data.children.forEach((c) => { c.data.likes = null; c.data.saved = false; c.data.hidden = false; });
// …and one post in the listing is your own text post (edit it from the listing)
const minePost = listing.data.children[1].data;
Object.assign(minePost, { author: ME, is_self: true, selftext: "post body", selftext_html: '<div class="md"><p>post body</p></div>', post_hint: undefined });
about.data.user_is_subscriber = false;

const now = Math.floor(Date.now() / 1000);
const inbox = { kind: "Listing", data: { after: null, children: [
  { kind: "t1", data: { name: "t1_inb1", id: "inb1", was_comment: true, new: true, type: "comment_reply", author: "someone", subreddit: SUB, link_title: post.title,
    context: post.permalink + "inb1/?context=3", body: "a reply to you", body_html: '<div class="md"><p>a reply to you</p></div>', created_utc: now - 600, num_comments: 3, score: 2, likes: null, replies: "" } },
  { kind: "t4", data: { name: "t4_pm1", id: "pm1", was_comment: false, new: true, subject: "hello there", author: "pen_pal", dest: ME, body: "hi!", body_html: '<div class="md"><p>hi!</p></div>', created_utc: now - 3600, replies: "" } },
] } };
const saved = { kind: "Listing", data: { after: null, children: [
  { kind: "t3", data: Object.assign({}, listing.data.children[0].data, { saved: true }) },
  { kind: "t1", data: Object.assign({}, tops[0].data, { saved: true, link_title: post.title, link_permalink: post.permalink, replies: "" }) },
] } };

const writes = []; // every POST the extension made
let failNextVote = false;
let lastCommentText = "";
let loggedIn = true;
let banned = false; // banned from the thread's subreddit: about.json says so, comments get Reddit's "500 reddit broke!"
const json = (route, body, status) => route.fulfill({ status: status || 200, contentType: "application/json; charset=UTF-8", body: JSON.stringify(body) });
const fakeComment = (name, text, parent) => ({ kind: "t1", data: {
  name, id: name.slice(3), author: ME, body: text, body_html: '<div class="md"><p>' + text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]) + "</p></div>",
  score: 1, likes: true, created_utc: now, parent_id: parent, link_id: post.name, subreddit: SUB, permalink: post.permalink + name.slice(3) + "/", replies: "" } });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-pw-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  ignoreDefaultArgs: ["--enable-automation"],
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch (e) {} });
let commentSeq = 0;
await ctx.route(/^https:\/\/www\.reddit\.com\/(api|message|user|r)\//, async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const p = u.pathname;
  if (req.method() === "POST" && p.startsWith("/api/")) {
    const form = Object.fromEntries(new URLSearchParams(req.postData() || ""));
    writes.push({ path: p, form, modhashHeader: req.headers()["x-modhash"] || "" });
    if (p === "/api/vote" && failNextVote) { failNextVote = false; return json(route, { message: "Internal Server Error", error: 500 }, 500); }
    if (p === "/api/comment" && banned) return route.fulfill({ status: 500, contentType: "text/html; charset=UTF-8", body: "<html><head><title>reddit broke!</title></head></html>" });
    if (p === "/api/comment") {
      lastCommentText = form.text;
      const name = "t1_newc" + ++commentSeq;
      return json(route, { json: { errors: [], data: { things: [{ kind: "t1", data: { id: name, parent: form.thing_id, contentText: form.text } }] } } });
    }
    if (p === "/api/editusertext") return json(route, { json: { errors: [], data: { things: [{ kind: "t1", data: { id: form.thing_id } }] } } });
    return json(route, {});
  }
  if (p === "/api/me.json") return loggedIn
    ? json(route, { kind: "t2", data: { name: ME, modhash: "mh_test", link_karma: 10, comment_karma: 20, total_karma: 30, inbox_count: 2, has_mail: true } })
    : route.fulfill({ status: 403, contentType: "text/html", body: "<html>blocked</html>" });
  if (p === "/api/info.json") {
    const id = u.searchParams.get("id");
    if (id === mine.name) return json(route, { kind: "Listing", data: { children: [{ kind: "t1", data: Object.assign({}, mine, { body: writes.some((w) => w.path === "/api/editusertext") ? "edited text" : "original text", body_html: '<div class="md"><p>' + (writes.some((w) => w.path === "/api/editusertext") ? "edited text" : "original text") + "</p></div>" }) }] } });
    if (id === minePost.name) {
      const edited = writes.some((w) => w.path === "/api/editusertext" && w.form.thing_id === minePost.name);
      return json(route, { kind: "Listing", data: { children: [{ kind: "t3", data: Object.assign({}, minePost, edited ? { selftext: "new post body", selftext_html: '<div class="md"><p>new post body</p></div>' } : {}) }] } });
    }
    if (/^t1_newc/.test(id)) { const w = writes.filter((x) => x.path === "/api/comment").pop(); return json(route, { kind: "Listing", data: { children: [fakeComment(id, lastCommentText, w && w.form.thing_id)] } }); }
    return json(route, { kind: "Listing", data: { children: [] } });
  }
  if (p.startsWith("/message/") && p.endsWith(".json")) return json(route, p.startsWith("/message/sent") ? { kind: "Listing", data: { children: [] } } : inbox);
  if (p === `/user/${ME}/saved/.json`) return json(route, saved);
  if (p === `/user/${ME}/about.json`) return json(route, { kind: "t2", data: { name: ME, link_karma: 10, comment_karma: 20, created_utc: 1.6e9 } });
  if (p.toLowerCase() === `/r/${SUB.toLowerCase()}/about.json`) return json(route, banned ? Object.assign({}, about, { data: Object.assign({}, about.data, { user_is_banned: true }) }) : about);
  if (p.toLowerCase() === `/r/${SUB.toLowerCase()}/about/rules.json`) return json(route, rules);
  if (p.endsWith(".json") && p.indexOf("/comments/" + post.id) >= 0) return json(route, thread);
  if (p.toLowerCase() === `/r/${SUB.toLowerCase()}/.json`) return json(route, listing);
  return route.continue();
});

// This browser is really logged out to Reddit, and new Reddit's own scripts (still
// running under the rebuilt page) send a logged-out visitor of /message/… to /login —
// something a logged-in user never sees. Block that redirect so it can't race the test.
const loginRedirects = [];
await ctx.route(/^https:\/\/www\.reddit\.com\/login/, (route) => { loginRedirects.push(route.request().url().slice(0, 100)); return route.abort(); });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => { if (!/\.announce is not a function/.test(e.message)) errors.push(String(e.message).slice(0, 200)); });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const lastWrite = (p) => writes.filter((w) => w.path === p).pop();
const settle = (ms) => page.waitForTimeout(ms || 600);
const sel = (name) => `#thing_${name}`;

// ---- a thread, logged in ----
await page.goto("https://www.reddit.com" + post.permalink, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".commentarea", { timeout: 30000 });
await page.waitForSelector("html.orr-logged-in", { timeout: 10000 }).catch(() => {});
await settle(1500);
const st0 = await page.evaluate(([postName, mineName]) => {
  const vis = (el) => !!el && getComputedStyle(el.closest("li") || el).display !== "none";
  const p = document.getElementById("thing_" + postName);
  const m = document.getElementById("thing_" + mineName);
  return {
    user: (document.querySelector("#header-bottom-right .user a") || {}).textContent,
    loggedIn: document.documentElement.classList.contains("orr-logged-in"),
    postSave: vis(p.querySelector(".orr-save")), postHide: vis(p.querySelector(".orr-hide")), postReport: vis(p.querySelector(".orr-report")),
    postEdit: vis(p.querySelector(".orr-edit")),
    mineEdit: vis(m.querySelector(":scope > .entry .orr-edit")), mineDelete: vis(m.querySelector(":scope > .entry .orr-delete")), mineReport: vis(m.querySelector(":scope > .entry .orr-report")),
    topForm: !!document.querySelector(".orr-topform form.orr-editor textarea"),
    replyLinks: document.querySelectorAll(".commentarea .orr-reply").length,
  };
}, [post.name, mine.name]);
console.log(JSON.stringify(st0));
check("logged in: header shows the user", st0.user === ME && st0.loggedIn);
check("post: save / hide / report shown, edit not (not yours)", st0.postSave && st0.postHide && st0.postReport && !st0.postEdit);
check("your comment: edit / delete, no report", st0.mineEdit && st0.mineDelete && !st0.mineReport);
check("comment box + reply links", st0.topForm && st0.replyLinks > 10);

// ---- voting ----
const postScore = () => page.evaluate((n) => { const t = document.getElementById("thing_" + n); return { cls: t.querySelector(":scope > .midcol").className, up: t.querySelector(":scope > .midcol > .arrow").className, score: t.querySelector(":scope > .midcol > .score").textContent }; }, post.name);
const before = await postScore();
await page.click(`${sel(post.name)} > .midcol > .arrow.up`);
await settle();
const up1 = await postScore();
const v1 = lastWrite("/api/vote");
check("upvote post: arrow + score + request", /likes/.test(up1.cls) && /upmod/.test(up1.up) && +up1.score === +before.score + 1 &&
  v1 && v1.form.id === post.name && v1.form.dir === "1" && v1.form.uh === "mh_test" && v1.modhashHeader === "mh_test", JSON.stringify([before, up1, v1]));
await page.click(`${sel(post.name)} > .midcol > .arrow.upmod`);
await settle();
const up0 = await postScore();
check("click again: vote taken back (dir 0)", /unvoted/.test(up0.cls) && +up0.score === +before.score && lastWrite("/api/vote").form.dir === "0", JSON.stringify(up0));
const c0 = tops[0].data;
await page.click(`${sel(c0.name)} > .midcol > .arrow.down`);
await settle();
const down = await page.evaluate((n) => { const t = document.getElementById("thing_" + n); return { cls: t.querySelector(":scope > .entry").className, pts: t.querySelector(":scope > .entry .tagline .score").textContent, badge: (t.querySelector(":scope > .entry .tagline .orr-uservotes") || {}).textContent || "" }; }, c0.name);
check("downvote comment: points - 1, request dir -1", /dislikes/.test(down.cls) && down.pts.startsWith(String(c0.score - 1) + " ") && lastWrite("/api/vote").form.dir === "-1", JSON.stringify(down));
check("vote weight badge after the author", down.badge === "[-1]", down.badge);
failNextVote = true;
const c2 = tops[2].data;
await page.click(`${sel(c2.name)} > .midcol > .arrow.up`);
await settle(900);
const failed = await page.evaluate((n) => ({ cls: document.getElementById("thing_" + n).querySelector(":scope > .midcol").className, toast: (document.getElementById("orr-toast") || {}).textContent || "" }), c2.name);
check("a failed vote is undone and explained", /unvoted/.test(failed.cls) && /couldn't vote/.test(failed.toast), JSON.stringify(failed));

// ---- save ----
await page.click(`${sel(post.name)} .orr-save`);
await settle();
const savedTxt = await page.textContent(`${sel(post.name)} .orr-save`);
check("save post", savedTxt === "unsave" && lastWrite("/api/save") && lastWrite("/api/save").form.id === post.name, savedTxt);
await page.click(`${sel(post.name)} .orr-save`);
await settle();
check("unsave post", (await page.textContent(`${sel(post.name)} .orr-save`)) === "save" && !!lastWrite("/api/unsave"));

// ---- report (a post, then a comment) ----
await page.click(`${sel(post.name)} .orr-report`);
await page.waitForSelector(`${sel(post.name)} form.orr-reportform input[name='orr-reason']`, { timeout: 8000 }).catch(() => {});
check("report form opens on a post", !!(await page.$(`${sel(post.name)} form.orr-reportform .orr-rf-cancel`)));
await page.click(`${sel(post.name)} form.orr-reportform .orr-rf-cancel`).catch(() => {});
await page.click(`${sel(c0.name)} > .entry .orr-report`);
await page.waitForSelector(`${sel(c0.name)} form.orr-reportform input[name='orr-reason']`, { timeout: 8000 });
const rf = await page.evaluate((n) => Array.from(document.querySelectorAll(`#thing_${n} form.orr-reportform .orr-rf-opt`)).map((l) => l.textContent.trim()).slice(0, 3), c0.name);
check("report form lists the subreddit's rules", rf.length === 3 && rf[0] === (rules.rules[0].violation_reason || rules.rules[0].short_name), JSON.stringify(rf));
await page.click(`${sel(c0.name)} form.orr-reportform .orr-rf-opt input`);
await page.click(`${sel(c0.name)} form.orr-reportform .orr-rf-submit`);
await settle(800);
const rep = lastWrite("/api/report");
check("report sent with the rule", rep && rep.form.thing_id === c0.name && rep.form.rule_reason === rf[0] && rep.form.reason === rf[0] && rep.form.sr_name === SUB, JSON.stringify(rep && rep.form));
check("report link says reported", (await page.textContent(`${sel(c0.name)} > .entry .orr-report`)) === "reported");

// ---- reply with preview + big editor ----
await page.click(`${sel(c0.name)} > .entry .orr-reply`);
const replyBox = `${sel(c0.name)} > .child > form.orr-editor textarea`;
await page.waitForSelector(replyBox);
await page.fill(replyBox, "**hello** from the test");
await settle(200);
const pv = await page.innerHTML(`${sel(c0.name)} > .child > form.orr-editor .orr-ed-preview`);
check("live preview renders markdown", /<strong>hello<\/strong> from the test/.test(pv), pv);
await page.click(`${sel(c0.name)} > .child > form.orr-editor .orr-ed-big`);
const big = await page.evaluate((n) => { const f = document.querySelector(`#thing_${n} > .child > form.orr-editor`); const r = f.getBoundingClientRect(); return { on: f.classList.contains("orr-bigedit"), w: Math.round(r.width), pos: getComputedStyle(f).position }; }, c0.name);
await page.screenshot({ path: path.join(outDir, "big-editor.png") });
check("big editor opens full-size", big.on && big.pos === "fixed" && big.w > 1000, JSON.stringify(big));
await page.keyboard.press("Escape");
await page.focus(replyBox);
await page.keyboard.press("Control+Enter");
await page.waitForSelector(`${sel(c0.name)} > .child > #thing_t1_newc1`, { timeout: 8000 }).catch(() => {});
const reply = await page.evaluate((n) => { const t = document.querySelector(`#thing_${n} > .child > #thing_t1_newc1`); return t && { author: t.getAttribute("data-author"), up: t.querySelector(":scope > .midcol > .arrow").className, body: t.querySelector(":scope > .entry .usertext-body").textContent.trim(), formGone: !document.querySelector(`#thing_${n} > .child > form.orr-editor`), mine: t.classList.contains("orr-mine") }; }, c0.name);
const cw = lastWrite("/api/comment");
check("reply posted and shown under the comment", cw && cw.form.thing_id === c0.name && cw.form.text === "**hello** from the test" && cw.form.api_type === "json" &&
  reply && reply.author === ME && /upmod/.test(reply.up) && reply.body === "**hello** from the test" && reply.formGone && reply.mine, JSON.stringify([cw && cw.form, reply]));

// ---- top-level comment ----
await page.fill(".orr-topform textarea", "a new top-level comment");
await page.click(".orr-topform button.save");
await page.waitForSelector(".commentarea > .sitetable > #thing_t1_newc2", { timeout: 8000 }).catch(() => {});
const top = await page.evaluate(() => ({ first: (document.querySelector(".commentarea > .sitetable > .thing") || {}).id, boxEmpty: document.querySelector(".orr-topform textarea").value === "" }));
check("top-level comment posted first, box cleared", top.first === "thing_t1_newc2" && top.boxEmpty && lastWrite("/api/comment").form.thing_id === post.name, JSON.stringify(top));

// ---- edit + delete your own comment ----
await page.click(`${sel(mine.name)} > .entry .orr-edit`);
const editBox = `${sel(mine.name)} > .entry > form.orr-editor[data-kind='edit'] textarea`;
await page.waitForSelector(editBox, { timeout: 8000 });
check("edit box holds your markdown", (await page.inputValue(editBox)) === "original text");
await page.fill(editBox, "edited text");
await page.click(`${sel(mine.name)} > .entry > form.orr-editor button.save`);
await settle(900);
const ed = await page.evaluate((n) => ({ body: document.querySelector(`#thing_${n} > .entry > .usertext-body`).textContent.trim(), shown: getComputedStyle(document.querySelector(`#thing_${n} > .entry > .usertext-body`)).display !== "none", form: !!document.querySelector(`#thing_${n} form.orr-editor`) }), mine.name);
const ew = lastWrite("/api/editusertext");
check("edit saved and shown", ew && ew.form.thing_id === mine.name && ew.form.text === "edited text" && ed.body === "edited text" && ed.shown && !ed.form, JSON.stringify([ew && ew.form, ed]));
await page.click(`${sel(mine.name)} > .entry .orr-delete`);
check("delete asks first", !!(await page.$(`${sel(mine.name)} > .entry .orr-del-confirm`)) && !lastWrite("/api/del"));
await page.click(`${sel(mine.name)} > .entry .orr-del-yes`);
await settle(800);
const del = await page.evaluate((n) => ({ body: document.querySelector(`#thing_${n} > .entry > .usertext-body`).textContent.trim(), author: !!document.querySelector(`#thing_${n} > .entry .tagline a.author`) }), mine.name);
check("delete sent, comment shows [deleted]", lastWrite("/api/del") && lastWrite("/api/del").form.id === mine.name && del.body === "[deleted]" && !del.author, JSON.stringify(del));

// ---- keyboard: j (select), a (upvote), s (save), r (reply) ----
await page.evaluate(() => { window.scrollTo(0, 0); if (document.activeElement) document.activeElement.blur(); });
const nVotes = writes.filter((w) => w.path === "/api/vote").length;
await page.keyboard.press("j");
const wasUp = await page.evaluate(() => document.querySelector(".thing.orr-kb-sel > .midcol").classList.contains("likes")); // (your new comment starts upvoted)
await page.keyboard.press("a");
await settle();
const kv = lastWrite("/api/vote");
const selName = await page.evaluate(() => (document.querySelector(".thing.orr-kb-sel") || {}).id);
check("keyboard a votes on the selected comment", writes.filter((w) => w.path === "/api/vote").length === nVotes + 1 && kv.form.dir === (wasUp ? "0" : "1") && "thing_" + kv.form.id === selName, JSON.stringify([selName, wasUp, kv.form]));
await page.keyboard.press("s");
await settle();
check("keyboard s saves it", "thing_" + lastWrite("/api/save").form.id === selName);
await page.keyboard.press("r");
await settle(300);
check("keyboard r opens a reply box", await page.evaluate(() => { const t = document.querySelector(".thing.orr-kb-sel"); return !!t.querySelector(":scope > .child > form.orr-editor") && document.activeElement.tagName === "TEXTAREA"; }));
await page.keyboard.press("Escape");

// ---- join / leave ----
await page.waitForSelector(".side .subscribe-button", { timeout: 10000 }).catch(() => {});
const subBefore = await page.textContent(".side .subscribers .number").catch(() => "");
await page.click(".side .subscribe-button .option.add.active");
await settle();
const sw = lastWrite("/api/subscribe");
const subAfter = await page.evaluate(() => ({ leave: document.querySelector(".side .subscribe-button .option.remove").classList.contains("active"), n: document.querySelector(".side .subscribers .number").textContent }));
check("join: request + button flips", sw && sw.form.action === "sub" && sw.form.sr === about.data.name && subAfter.leave && subAfter.n !== subBefore, JSON.stringify([sw && sw.form, subBefore, subAfter]));
await page.click(".side .subscribe-button .option.remove.active");
await settle();
check("leave", lastWrite("/api/subscribe").form.action === "unsub");
await page.screenshot({ path: path.join(outDir, "thread.png") });

// ---- banned from the subreddit: a refused reply says why; a fresh load says so up front ----
banned = true;
await page.click(`${sel(c2.name)} > .entry .orr-reply`);
const banBox = `${sel(c2.name)} > .child > form.orr-editor textarea`;
await page.waitForSelector(banBox);
await page.fill(banBox, "will this post?");
await page.click(`${sel(c2.name)} > .child > form.orr-editor button.save`);
await settle(1500);
const banState = (n) => page.evaluate((n) => ({
  status: n ? ((document.querySelector(`#thing_${n} > .child > form.orr-editor .status`) || {}).textContent || "") : "",
  note: (document.querySelector(".commentarea > .orr-closed-note") || {}).textContent || "",
  topForm: !!document.querySelector(".orr-topform form"),
  replyShown: Array.from(document.querySelectorAll(".commentarea .orr-reply")).some((a) => getComputedStyle(a.closest("li")).display !== "none"),
}), n);
const rb = await banState(c2.name);
check("a refused comment says you're banned (Reddit's 500)", /banned from r\//.test(rb.status) && /banned/.test(rb.note) && !rb.topForm && !rb.replyShown, JSON.stringify(rb));
check("…and keeps what you typed", (await page.inputValue(banBox).catch(() => "")) === "will this post?");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".commentarea", { timeout: 30000 });
await page.waitForSelector(".commentarea > .orr-closed-note", { timeout: 10000 }).catch(() => {});
const pb = await banState(null);
check("banned: the thread says so up front — no comment box, no reply links", /banned from r\//.test(pb.note) && !pb.topForm && !pb.replyShown, JSON.stringify(pb));
banned = false;

// ---- listing: hide + undo ----
await page.goto(`https://www.reddit.com/r/${SUB}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 });
await page.waitForSelector("html.orr-logged-in", { timeout: 10000 }).catch(() => {});
const first = await page.evaluate(() => document.querySelector("#siteTable > .thing.link").getAttribute("data-fullname"));
await page.click(`${sel(first)} .orr-hide`);
await settle();
const hid = await page.evaluate((n) => getComputedStyle(document.getElementById("thing_" + n)).display, first);
check("hide takes the post off the listing", hid === "none" && lastWrite("/api/hide").form.id === first);
await page.click("#orr-toast a");
await settle();
check("undo brings it back", (await page.evaluate((n) => getComputedStyle(document.getElementById("thing_" + n)).display, first)) !== "none" && lastWrite("/api/unhide").form.id === first);
// your own text post: edit (from the listing) shown, report not
const mp = await page.evaluate((n) => { const t = document.getElementById("thing_" + n); const vis = (a) => !!a && getComputedStyle(a.closest("li")).display !== "none"; return { mine: t.classList.contains("orr-mine"), edit: vis(t.querySelector(".orr-edit")), del: vis(t.querySelector(".orr-delete")), report: vis(t.querySelector(".orr-report")) }; }, minePost.name);
check("your post: edit + delete shown, report hidden", mp.mine && mp.edit && mp.del && !mp.report, JSON.stringify(mp));
await page.click(`${sel(minePost.name)} .orr-edit`);
const postEditBox = `${sel(minePost.name)} form.orr-editor[data-kind='edit'] textarea`;
await page.waitForSelector(postEditBox, { timeout: 8000 }).catch(() => {});
check("post edit box holds the post's markdown", (await page.inputValue(postEditBox).catch(() => "")) === "post body");
await page.fill(postEditBox, "new post body");
await page.click(`${sel(minePost.name)} form.orr-editor button.save`);
await settle(900);
const pe = await page.evaluate((n) => { const t = document.getElementById("thing_" + n); const b = t.querySelector(".expando .usertext-body"); return { body: b && b.textContent.trim(), shown: !!b && b.offsetParent !== null, form: !!t.querySelector("form.orr-editor") }; }, minePost.name);
check("post edit saved and shown", lastWrite("/api/editusertext").form.thing_id === minePost.name && pe.body === "new post body" && pe.shown && !pe.form, JSON.stringify(pe));

// ---- inbox ----
await page.click("#mail");
await page.waitForSelector(".messages-page .thing.message", { timeout: 15000 }).catch(() => {});
await settle(800);
const ib = await page.evaluate(() => ({ url: location.pathname, items: document.querySelectorAll(".thing.message").length, tabs: Array.from(document.querySelectorAll(".tabmenu li")).map((l) => l.textContent).join("|"),
  marks: Array.from(document.querySelectorAll(".orr-markread")).map((a) => a.textContent) }));
const rm = lastWrite("/api/read_message");
check("inbox rebuilt from the mail icon", ib.url === "/message/inbox/" && ib.items === 2 && /comment replies/.test(ib.tabs), JSON.stringify(ib));
check("opening the inbox marks what it shows read", rm && rm.form.id === "t1_inb1,t4_pm1" && ib.marks.every((m) => m === "mark unread"), JSON.stringify([rm && rm.form, ib.marks]));
await page.click("#thing_t4_pm1 .orr-markread");
await settle();
check("mark unread", lastWrite("/api/unread_message") && lastWrite("/api/unread_message").form.id === "t4_pm1");
await page.click("#thing_t4_pm1 .orr-reply");
await page.fill("#thing_t4_pm1 form.orr-editor textarea", "thanks!");
await page.click("#thing_t4_pm1 form.orr-editor button.save");
await settle(800);
check("reply to a message", lastWrite("/api/comment").form.thing_id === "t4_pm1" && /has been sent/.test(await page.textContent("#thing_t4_pm1 .orr-sent-note").catch(() => "")));
await page.screenshot({ path: path.join(outDir, "inbox.png") });

// ---- your saved tab ----
await page.goto(`https://www.reddit.com/user/${ME}/saved/`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#siteTable .thing", { timeout: 20000 }).catch(() => {});
await settle(800);
const sv = await page.evaluate(() => ({ tabs: Array.from(document.querySelectorAll(".tabmenu li")).map((l) => (l.classList.contains("selected") ? "*" : "") + l.textContent).join("|"),
  things: document.querySelectorAll("#siteTable > .thing").length, unsave: Array.from(document.querySelectorAll("#siteTable .orr-save")).map((a) => a.textContent) }));
check("saved tab: your private tabs + saved items", /\*saved/.test(sv.tabs) && /upvoted/.test(sv.tabs) && /hidden/.test(sv.tabs) && sv.things === 2 && sv.unsave.every((t) => t === "unsave"), JSON.stringify(sv));

// ---- logged out: no account buttons, arrows nudge to log in, nothing sent ----
loggedIn = false;
const nWrites = writes.length;
const page2 = await ctx.newPage();
await page2.goto("https://www.reddit.com" + post.permalink, { waitUntil: "domcontentloaded", timeout: 45000 });
await page2.waitForSelector(".commentarea", { timeout: 30000 });
await page2.waitForTimeout(1500);
const lo = await page2.evaluate((n) => ({ li: document.documentElement.classList.contains("orr-logged-in"), save: getComputedStyle(document.querySelector(`#thing_${n} .orr-save`).closest("li")).display, form: !!document.querySelector(".orr-topform form") }), post.name);
await page2.click(`${sel(post.name)} > .midcol > .arrow.up`);
await page2.waitForTimeout(600);
const nudge = await page2.evaluate(() => (document.getElementById("orr-toast") || {}).textContent || "");
check("logged out: buttons hidden, no comment box", !lo.li && lo.save === "none" && !lo.form, JSON.stringify(lo));
check("logged out: an arrow asks you to log in, sends nothing", /log in to vote/.test(nudge) && writes.length === nWrites, nudge);

check("no page errors", errors.length === 0, JSON.stringify(errors));
if (loginRedirects.length) console.log("(blocked new Reddit's own /login redirects: " + loginRedirects.length + ")");
console.log("writes:", writes.map((w) => w.path + " " + (w.form.id || w.form.thing_id || w.form.action || "")).join(" | "));
await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : "ALL PASS");
process.exit(fail ? 1 : 0);
