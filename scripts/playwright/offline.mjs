// Offline check of the logged-out HTML parsers against saved Reddit HTML (no network).
// (a file with "search" in its name is a search results page / partial)
// Loads common.js + rebuild.js into a blank page and runs ORR_REBUILD's parsers.
//   node offline.mjs <repo-dir> <saved.html>...
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [repo, ...files] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage();
await page.route("https://www.reddit.com/orr-offline", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><head></head><body></body></html>" }));
await page.goto("https://www.reddit.com/orr-offline");
await page.addScriptTag({ content: "globalThis.chrome = { runtime: { getURL: (p) => p, sendMessage: () => Promise.resolve() }, storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} }, sync: { get: (k, cb) => cb && cb({}), set: () => {} }, onChanged: { addListener: () => {} } } };" });
for (const f of ["common.js", "rebuild.js"]) await page.addScriptTag({ content: fs.readFileSync(path.join(repo, f), "utf8") });
let fail = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + (info ? "  " + info : "")); if (!ok) fail++; };
const isSearch = (x) => /search/.test(path.basename(x));
for (const f of files.filter((x) => !/right_rail|hover_card/.test(path.basename(x)) && !isSearch(x))) {
  const html = fs.readFileSync(f, "utf8");
  const r = await page.evaluate((html) => {
    const R = globalThis.ORR_REBUILD;
    const doc = R.parseHtmlDoc(html);
    const posts = Array.from(doc.querySelectorAll("shreddit-post")).map(R.postFromShreddit).filter(Boolean);
    const linkId = posts[0] ? posts[0].name : "";
    const tree = R.commentsFromHtml(doc, linkId);
    let t1 = 0, more = 0, orphans = 0, maxDepth = 0;
    const walk = (kids, depth) => kids.forEach((c) => {
      if (c.kind === "more") { more++; return; }
      t1++; maxDepth = Math.max(maxDepth, depth);
      if (depth === 0 && c.data.parent_id !== linkId) orphans++;
      walk(c.data.replies.data.children, depth + 1);
    });
    walk(tree, 0);
    const html0 = tree[0] && tree[0].data ? tree[0].data.body_html || "" : "";
    return {
      posts: posts.length,
      first: posts[0] && { title: posts[0].title.slice(0, 50), score: posts[0].score, n: posts[0].num_comments, created: posts[0].created_utc, self: posts[0].is_self, hint: posts[0].post_hint || "", gallery: !!posts[0].is_gallery, video: !!posts[0].is_video, flair: posts[0].link_flair_text || "", thumb: (posts[0].thumbnail || "").slice(0, 60), selftext: (posts[0].selftext_html || "").slice(0, 80) },
      types: posts.reduce((a, p) => { const k = p.is_gallery ? "gallery" : p.is_video ? "video" : p.post_hint === "image" ? "image" : p.is_self ? "text" : "link"; a[k] = (a[k] || 0) + 1; return a; }, {}),
      badDates: posts.filter((p) => !(p.created_utc > 1.6e9)).length,
      multiNoBody: Array.from(doc.querySelectorAll("shreddit-post[post-type='multi_media']")).map(R.postFromShreddit).filter((p) => !p.is_self || (!p.selftext_html && (() => { const b = doc.getElementById(p.name + "-post-rtjson-content"); return b && (b.textContent.trim() || b.querySelector("img")); })())).length,
      emptyBodies: posts.filter((p) => p.selftext_html && !/<img\b/i.test(p.selftext_html) && !p.selftext_html.replace(/<[^>]*>|&nbsp;|\s/g, "")).length,
      mediaTextDropped: posts.filter((p) => !p.is_self && p.selftext_html && (() => { const ex = R.postExpando(p); return !ex || !/class="md"/.test(ex.html); })()).length,
      mediaWithText: posts.filter((p) => !p.is_self && p.selftext_html).length,
      awardImages: posts.filter((p) => p.preview && /snoovatar|snoo_assets/.test(JSON.stringify(p.preview))).length,
      t1, more, orphans, maxDepth,
      bodySample: html0.slice(0, 120),
      bodyUnsafe: /<script|on\w+=|javascript:/i.test(tree.map((c) => (c.data && c.data.body_html) || "").join("")),
      builtOk: (() => { try { return R.buildCommentTree(tree, linkId, Date.now()).length > 0 || !tree.length; } catch (e) { return String(e); } })(),
      itemOk: (() => { try { return posts.every((p) => R.buildItem(p, { expandoButton: true }).length > 0); } catch (e) { return String(e); } })(),
    };
  }, html);
  console.log("\n== " + path.basename(f));
  console.log(JSON.stringify(r));
  check("parses posts", r.posts > 0);
  check("dates parse", r.badDates === 0, "bad=" + r.badDates);
  check("no award icon as post image", r.awardImages === 0);
  check("builders accept parsed data", r.itemOk === true && r.builtOk === true, r.itemOk + "/" + r.builtOk);
  check("comment bodies sanitized", !r.bodyUnsafe);
  check("multi_media posts are self posts with their body", r.multiNoBody === 0);
  check("no empty post body (no empty expando)", r.emptyBodies === 0, "empty=" + r.emptyBodies);
  check("a media post's own text is shown with its media", r.mediaTextDropped === 0, r.mediaWithText + " media post(s) with text");
}
const sanit = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  const d = new DOMParser().parseFromString('<div id=x><p onclick="alert(1)">hi <a href="javascript:alert(1)">j</a> <a href="https://e.com/" style="x">ok</a><img src="http://x/a.png" onerror="alert(1)"><img src="https://i.redd.it/a.png" onerror="z"><script>alert(1)</script><span class="md-spoiler-text evil">s</span><faceplate-x><b>kept</b></faceplate-x></p></div>', "text/html");
  return R.cleanMd(d.getElementById("x"));
});
console.log("\ncleanMd:", sanit);
check("cleanMd strips handlers/js/script/http img", !/onclick|onerror|javascript:|<script|http:\/\/x|style=|evil/.test(sanit) && /<b>kept<\/b>/.test(sanit) && /https:\/\/i\.redd\.it\/a\.png/.test(sanit));
// Spoilers / screen-reader text / sidebar headings
const extra = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  const d = new DOMParser().parseFromString('<div id=x><p>a <spoiler-text>secret</spoiler-text> <faceplate-screen-reader-content>hidden</faceplate-screen-reader-content></p><h2>Rule</h2></div>', "text/html");
  return { normal: R.cleanMd(d.getElementById("x")), side: R.cleanMd(d.getElementById("x"), { headingsAsStrong: true }) };
});
check("cleanMd spoiler-text → md-spoiler-text, drops screen-reader text", /<span class="md-spoiler-text">secret<\/span>/.test(extra.normal) && !/hidden/.test(extra.normal) && /<h2>Rule<\/h2>/.test(extra.normal), extra.normal);
check("cleanMd headingsAsStrong", /<strong>Rule<\/strong>/.test(extra.side), extra.side);
// Optional fixtures, matched by file name: *right_rail* (sidebar), *_r_<sub>_.html (stickies), *type-video* (muxed MP4),
// *hover_card* (logged-out hover cards; "doesnotexist" in the name = expect null)
for (const f of files) {
  const html = fs.readFileSync(f, "utf8");
  const base = path.basename(f);
  if (/right_rail/.test(base)) {
    const r = await page.evaluate((html) => {
      const R = globalThis.ORR_REBUILD;
      const rail = R.railFromHtml(R.parseHtmlDoc(html));
      return rail && { name: rail.name, visitors: rail.weeklyVisitors, titles: rail.sections.map((s) => s.title), rulesLen: (rail.sections.find((s) => /rules/i.test(s.title)) || { html: "" }).html.length,
        unsafe: /<script|on\w+=|javascript:/i.test(JSON.stringify(rail)), built: R.buildRailSidebar(rail).length, apps: rail.sections.some((s) => /installed apps/i.test(s.title)) };
    }, html);
    console.log("\n== " + base + "\n" + JSON.stringify(r));
    check("rail parses header + rules", !!r && !!r.name && r.visitors > 0 && r.rulesLen > 100, r && r.titles.join(" | "));
    check("rail drops Installed Apps, sanitized", !!r && !r.apps && !r.unsafe && r.built > 0);
  }
  if (/_r_[A-Za-z0-9_]+_\.html$/.test(base)) {
    const s = await page.evaluate((html) => { const R = globalThis.ORR_REBUILD; return R.stickiesFromHtml(R.parseHtmlDoc(html)).map((d) => ({ name: d.name, title: d.title.slice(0, 40), score: d.score, n: d.num_comments, sticky: d.stickied, item: R.buildItem(d, {}).includes("stickied-tagline") })); }, html);
    console.log("\n== " + base + " stickies " + JSON.stringify(s));
    check("stickies parse + render as announcements", s.every((d) => /^t3_/.test(d.name) && d.title && d.sticky && d.item));
  }
  if (/hover_card/.test(base)) {
    const h = await page.evaluate(([html, isUser]) => { const R = globalThis.ORR_REBUILD; const doc = R.parseHtmlDoc(html); return isUser ? R.userHoverFromHtml(doc) : R.subHoverFromHtml(doc); }, [html, /user_hover_card/.test(base)]);
    console.log("\n== " + base + " hover " + JSON.stringify(h));
    if (/doesnotexist/.test(base)) check("hover card: missing user/sub → null", h === null);
    else if (/user_hover_card/.test(base)) check("user hover card: karma + cake day", !!h && h.postKarma > 0 && h.commentKarma > 0 && h.created > 1e9 && !!h.name);
    else check("sub hover card: weekly visitors + description", !!h && h.weeklyVisitors > 0 && h.weeklyContributions > 0 && h.description.length > 5 && !!h.name);
  }
  if (/type-video/.test(base)) {
    const v = await page.evaluate((html) => {
      const R = globalThis.ORR_REBUILD;
      const posts = Array.from(R.parseHtmlDoc(html).querySelectorAll("shreddit-post")).map(R.postFromShreddit);
      return posts.map((p) => ({ url: p.media && p.media.reddit_video.fallback_url.slice(0, 60), h: p.media && p.media.reddit_video.height, exp: R.postExpando(p) }))
        .map((x) => ({ url: x.url, h: x.h, type: x.exp && x.exp.type, dash: x.exp && /data-dash-url/.test(x.exp.html) }));
    }, html);
    console.log("\n== " + base + " video " + JSON.stringify(v));
    check("video uses packaged MP4 (≤720p, no dash)", v.every((x) => /^https:\/\/packaged-media\.redd\.it\//.test(x.url) && x.h <= 720 && x.type === "video" && !x.dash));
  }
}
// Logged-in markup + the comment editor's live markdown preview (issues #1/#11)
const li = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  const mdCases = [
    "**bold** *it* ~~del~~ super^script ^(two words) >!secret!< `a<b>`",
    "[ok](https://e.com/?a=1&b=2) [rel](/r/pics) [bad](javascript:alert(1)) [bad2](data:text/html,x) r/pics u/spez https://x.com/y.",
    "<script>alert(1)</script> <img src=x onerror=alert(1)> \" onmouseover=\"x &amp; &lt;b&gt;",
    "> quote **q**\n\n* one\n* two\n  * nested\n\n1. a\n2. b",
    "# H\n\n---\n\n    code <b>\n\n```\nfence <i>\n```",
    "| a | b |\n|:--|--:|\n| 1 | **2** |",
    "[x](https://e.com\" onclick=\"alert(1))  [y](javascript&#58;alert(1)) [z](  JaVaScRiPt:alert(1))",
  ];
  const ALLOWED = /^(P|BR|HR|A|EM|STRONG|DEL|SUP|CODE|PRE|BLOCKQUOTE|UL|OL|LI|H[1-6]|TABLE|THEAD|TBODY|TR|TH|TD|SPAN)$/;
  const out = mdCases.map((c) => R.mdPreview(c));
  const unsafe = out.filter((h) => {
    const d = new DOMParser().parseFromString("<div>" + h + "</div>", "text/html");
    return Array.from(d.body.querySelectorAll("*")).slice(1).some((el) =>
      !ALLOWED.test(el.tagName) ||
      Array.from(el.attributes).some((a) => /^on/i.test(a.name) || a.name === "style" || a.name === "src") ||
      (el.tagName === "A" && !/^(https?:\/\/|\/(?!\/))/i.test(el.getAttribute("href") || "")));
  });
  const item = (d) => R.buildItem(Object.assign({ name: "t3_a", id: "a", title: "t", author: "x", subreddit: "s", score: 10, num_comments: 1, created_utc: 1.7e9, permalink: "/r/s/comments/a/t/", url: "/r/s/comments/a/t/", is_self: true }, d), {});
  const comment = (d) => R.buildComment(Object.assign({ name: "t1_c", author: "y", score: 5, created_utc: 1.7e9, body_html: "<div class=\"md\"><p>hi</p></div>", permalink: "/r/s/comments/a/t/c/", subreddit: "s" }, d), {});
  const msg = R.buildMessage({ name: "t1_m", was_comment: true, new: true, type: "comment_reply", author: "z", subreddit: "s", link_title: "T", context: "/r/s/comments/a/t/m/?context=3", body_html: "<div class=\"md\"><p>r</p></div>", created_utc: 1.7e9, num_comments: 4, score: 2 }, {});
  const page = R.buildMessagesPage({ where: "unread", basePath: "/message/unread" }, { data: { children: [] } }, {});
  return {
    md: out, unsafe: unsafe.length,
    nested: /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/.test(out[3]),
    upvoted: /class="midcol likes"[^]*class="arrow upmod"/.test(item({ likes: true })) && /class="entry likes"/.test(item({ likes: true })),
    downvoted: /class="arrow downmod"/.test(comment({ likes: false })) && /class="score dislikes"/.test(comment({ likes: false })),
    unvoted: /class="midcol unvoted"/.test(item({ likes: null })) && !/login-required/.test(item({})),
    savedHidden: />unsave</.test(item({ saved: true })) && />unhide</.test(item({ hidden: true })) && />save</.test(item({})),
    lockedNoReply: !/orr-reply/.test(comment({ locked: true })) && /orr-reply/.test(comment({})),
    linkNoEdit: !/orr-edit/.test(item({ is_self: false })) && /orr-edit/.test(item({ is_self: true })),
    archivedPage: /archived post/.test(R.buildCommentsBody([{ data: { children: [{ kind: "t3", data: { name: "t3_a", title: "t", archived: true, subreddit: "s", permalink: "/r/s/comments/a/t/" } }] } }, { data: { children: [] } }]).inner),
    topForm: /orr-topform/.test(R.buildCommentsBody([{ data: { children: [{ kind: "t3", data: { name: "t3_a", title: "t", subreddit: "s", permalink: "/r/s/comments/a/t/" } }] } }, { data: { children: [] } }]).inner),
    ownTabs: /saved/.test(R.userTabmenuHtml({ name: "Me", section: "overview" }, "me")) && !/saved/.test(R.userTabmenuHtml({ name: "other", section: "overview" }, "me")),
    sidebarJoin: /subscribe-button[^]*option add active/.test(R.buildSidebar({ data: { name: "t5_x", display_name: "s", subscribers: 3, user_is_subscriber: false } }, null)) &&
      /option remove active/.test(R.buildSidebar({ data: { name: "t5_x", display_name: "s", subscribers: 3, user_is_subscriber: true } }, null)),
    message: /thing message new was-comment/.test(msg) && /href="\/r\/s\/comments\/a\/t\/m\/\?context=3"/.test(msg) && /full comments \(4\)/.test(msg) && />mark read</.test(msg) && /orr-msg-reply/.test(msg),
    msgPage: /tabmenu[^]*class="selected"><a class="choice" href="\/message\/unread\/">unread/.test(page.inner),
    commentBlock: (R.commentBlock({ data: { display_name: "x", user_is_banned: true } }) || {}).code === "banned" &&
      (R.commentBlock({ data: { display_name: "x", restrict_commenting: true } }) || {}).code === "restricted" &&
      R.commentBlock({ data: { display_name: "x", restrict_commenting: true, user_is_contributor: true } }) === null &&
      R.commentBlock({ data: { display_name: "x", user_is_banned: false } }) === null && R.commentBlock(null) === null,
  };
});
li.md.forEach((h, i) => console.log("md" + i + ": " + h));
check("markdown preview never emits handlers / script URLs / unknown tags", li.unsafe === 0, "unsafe=" + li.unsafe);
check("markdown preview: nested list", li.nested);
["upvoted", "downvoted", "unvoted", "savedHidden", "lockedNoReply", "linkNoEdit", "archivedPage", "topForm", "ownTabs", "sidebarJoin", "message", "msgPage", "commentBlock"]
  .forEach((k) => check("logged-in markup: " + k, li[k] === true));
// Email addresses: Reddit's own mailto: links survive cleanMd (they used to lose their href —
// blue text that went nowhere), plain-text addresses get linked, the preview links them too.
const mail = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  const d = new DOMParser().parseFromString('<div id=x><p><a href="mailto:security@namecheap.com" target="_blank">security@namecheap.com</a> ' +
    '<a href="javascript:alert(1)">j</a> <a href="mailto:&lt;script&gt;@x">bad</a> <a href="mailto:nobody">noat</a></p></div>', "text/html");
  const cleaned = R.cleanMd(d.getElementById("x"));
  const md = document.createElement("div");
  md.className = "md";
  md.innerHTML = '<p>write to a.b+c@ex-ample.co.uk, or <a href="https://e.com">x@y.com</a> or <code>e@f.com</code>; not foo@bar or @name</p>';
  document.body.appendChild(md);
  R.linkifyEmails(document.body);
  R.linkifyEmails(document.body); // twice: idempotent
  const links = Array.from(md.querySelectorAll("a")).map((a) => a.getAttribute("href"));
  md.remove();
  return { cleaned, links, preview: R.mdPreview("mail me@x.com or [support](mailto:help@y.org) not a@b") };
});
console.log("\nmail:", JSON.stringify(mail));
check("cleanMd keeps mailto: links, still drops script / malformed ones",
  /<a href="mailto:security@namecheap.com">security@namecheap.com<\/a>/.test(mail.cleaned) && !/javascript:|script|mailto:nobody/.test(mail.cleaned));
check("plain-text emails become mailto: links (not inside links / code)",
  JSON.stringify(mail.links) === JSON.stringify(["mailto:a.b+c@ex-ample.co.uk", "https://e.com"]), JSON.stringify(mail.links));
check("comment preview links emails", /<a href="mailto:me@x.com">me@x.com<\/a>/.test(mail.preview) && /<a href="mailto:help@y.org"[^>]*>support<\/a>/.test(mail.preview) && !/mailto:a@b/.test(mail.preview), mail.preview);
for (const f of files.filter((x) => /mailto:/.test(fs.readFileSync(x, "utf8")) && !/right_rail|hover_card/.test(path.basename(x)))) {
  const n = await page.evaluate((html) => {
    const R = globalThis.ORR_REBUILD;
    const doc = R.parseHtmlDoc(html);
    const post = Array.from(doc.querySelectorAll("shreddit-post")).map(R.postFromShreddit).filter(Boolean)[0];
    const tree = R.commentsFromHtml(doc, post ? post.name : "");
    const all = JSON.stringify([tree, post ? post.selftext_html || "" : ""]);
    return { src: (html.match(/href="mailto:[^"]+"/g) || []).length, kept: (all.match(/href=\\"mailto:[^"\\]+\\"/g) || []).length };
  }, fs.readFileSync(f, "utf8"));
  check("thread keeps its mailto: links: " + path.basename(f).slice(0, 50), n.kept >= n.src && n.src > 0, JSON.stringify(n));
}
// A thread link without its slug: Reddit's stub names the full URL; follow only the same post on reddit
const canon = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  const stub = (v) => R.parseHtmlDoc(`<div id="canonical-url-updater" value="${v}"></div>`);
  const p = "/r/Salary/comments/1x5awcf/";
  return [
    R.canonicalThreadPath(stub("https://www.reddit.com/r/Salary/comments/1x5awcf/software_engineer_x/"), p),
    R.canonicalThreadPath(stub("https://www.reddit.com/r/Salary/comments/1x5awcf/software_engineer_x/"), "/comments/1x5awcf/"),
    R.canonicalThreadPath(stub("https://www.reddit.com/r/Salary/comments/zzzzzz/other/"), p),
    R.canonicalThreadPath(stub("https://evil.example/r/Salary/comments/1x5awcf/x/"), p),
    R.canonicalThreadPath(stub("javascript:alert(1)"), p),
    R.canonicalThreadPath(R.parseHtmlDoc('<div id="shreddit-redirect"><ac-call method="location.replace(&quot;/r/Salary/comments/1x5awcf/slug_y/&quot;)"></ac-call></div>'), p),
    R.canonicalThreadPath(R.parseHtmlDoc("<p>nothing</p>"), p),
  ];
});
check("short thread links follow Reddit's redirect (same post, reddit only)",
  JSON.stringify(canon) === JSON.stringify(["/r/Salary/comments/1x5awcf/software_engineer_x/", "/r/Salary/comments/1x5awcf/software_engineer_x/", null, null, null, "/r/Salary/comments/1x5awcf/slug_y/", null]), JSON.stringify(canon));
// Logged-out search results (*search* in the file name): new Reddit's search page or its
// /svc/shreddit/…/search/ partial → t3 data (no <shreddit-post> there), plus the next page
let searchThumbs = 0;
for (const f of files.filter(isSearch)) {
  const r = await page.evaluate((html) => {
    const R = globalThis.ORR_REBUILD;
    const { posts, next } = R.searchPostsFromHtml(R.parseHtmlDoc(html));
    return {
      n: posts.length, next: next && next.replace(/cursor=.*/, "cursor=…"),
      first: posts[0] && { name: posts[0].name, title: posts[0].title.slice(0, 50), sub: posts[0].subreddit, by: posts[0].author, score: posts[0].score, comments: posts[0].num_comments, thumb: (posts[0].thumbnail || "").slice(0, 40) },
      bad: posts.filter((p) => !/^t3_[a-z0-9]+$/.test(p.name) || !/^\/(r|user)\/[^/]+\/comments\/[a-z0-9]+\//.test(p.permalink) || !p.title || !p.subreddit || !p.author || !(p.created_utc > 1.1e9)).map((p) => p.name),
      counted: posts.filter((p) => p.score > 0 || p.num_comments > 0).length,
      thumbs: posts.filter((p) => p.thumbnail).length,
      items: (() => { try { return posts.map((p) => R.buildItem(p, { showSub: true, expandoButton: true })).join(""); } catch (e) { return "ERR " + e; } })(),
      page: R.buildSearchPage({ data: { children: posts.map((d) => ({ kind: "t3", data: d })), after: next } }, { params: { q: "x" } }).inner.length,
    };
  }, fs.readFileSync(f, "utf8"));
  console.log("\n== " + path.basename(f));
  console.log(JSON.stringify(Object.assign({}, r, { items: r.items.length })));
  check("search results parse", r.n >= 3 && !r.bad.length, JSON.stringify(r.bad));
  check("search results carry vote / comment counts", r.counted >= r.n / 2, r.counted + " of " + r.n);
  searchThumbs += r.thumbs;
  check("search results build (no empty domain)", /class="thing /.test(r.items) && !/\(<a href="\/domain\/\/">/.test(r.items) && r.page > 0);
  check("search results continue on a partial", !!r.next && /^\/svc\/shreddit\/(r\/[^/]+\/)?search\/\?/.test(r.next), r.next);
}
if (files.some(isSearch)) check("search results carry thumbnails", searchThumbs > 0, searchThumbs + " thumbnails");
// Search-result hover peek: a thread page read only up to its post's end (how fetchPostOnly
// stops early) gives the same post; the peek shows its text / picture / link, escaped
for (const f of files.filter((x) => !isSearch(x) && /\/comments\/|_comments_/.test(path.basename(x)))) {
  const r = await page.evaluate((html) => {
    const R = globalThis.ORR_REBUILD;
    const end = html.indexOf("</shreddit-post>");
    if (end < 0) return null;
    const full = R.postFromShreddit(R.parseHtmlDoc(html).querySelector("shreddit-post"));
    const cut = R.postFromShreddit(R.parseHtmlDoc(html.slice(0, end + 16)).querySelector("shreddit-post"));
    const peek = R.postPeekHtml(R.postPeekParts(cut));
    return {
      same: JSON.stringify(full) === JSON.stringify(cut), kb: Math.round(end / 1024), of: Math.round(html.length / 1024),
      text: !!cut.selftext_html, peekText: /class="orr-peek-text"/.test(peek), img: /class="orr-peek-media"/.test(peek), peek: peek.slice(0, 100),
    };
  }, fs.readFileSync(f, "utf8"));
  if (!r) continue;
  console.log("\n== peek " + path.basename(f).slice(0, 60) + "  " + JSON.stringify(r));
  check("a thread page cut at its post's end parses to the same post", r.same, r.kb + " of " + r.of + " KB");
  check("the peek shows the post's text when it has one", r.peekText === r.text);
}
const peeks = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  return [
    R.postPeekHtml(null),
    R.postPeekHtml(R.postPeekParts({ is_self: true, url: "https://www.reddit.com/r/a/comments/x/y/" })),
    R.postPeekHtml(R.postPeekParts({ is_self: false, url: "https://example.com/a?b=<i>", preview: { images: [{ source: { url: "https://external-preview.redd.it/p.jpg?a=1&b=2" } }] } })),
    R.postPeekHtml(R.postPeekParts({ is_self: false, url: "https://i.redd.it/x.png", preview: { images: [{ source: { url: "javascript:alert(1)" } }] } })),
    R.postPeekHtml(R.postPeekParts({ is_gallery: true, url: "https://www.reddit.com/gallery/x", gallery_data: { items: [{ media_id: "m0" }, { media_id: "m1" }] }, media_metadata: { m0: { s: { u: "https://i.redd.it/a.jpg" } } } })),
  ];
});
check("peek: nothing / link / escaping / no script URLs / gallery",
  /couldn't load/.test(peeks[0]) && /no description/.test(peeks[1]) &&
  /example\.com\/a\?b=&lt;i&gt;/.test(peeks[2]) && /src="https:\/\/external-preview\.redd\.it\/p\.jpg\?a=1&amp;b=2"/.test(peeks[2]) &&
  !/javascript:/.test(peeks[3]) && /no description/.test(peeks[3]) && /2 images/.test(peeks[4]) && /i\.redd\.it\/a\.jpg/.test(peeks[4]), JSON.stringify(peeks));
// Logged-out search URL: posts only, old reddit's sort / time / restrict_sr mapped onto new Reddit's
const spath = await page.evaluate(() => {
  const R = globalThis.ORR_REBUILD;
  return [
    R.htmlSearchPath({ sub: null }, { q: "Gemma 5 LLM capabilities", sort: "relevance", t: "all" }),
    R.htmlSearchPath({ sub: "LocalLLaMA" }, { q: "gemma", sort: "top", t: "week", restrict_sr: true }),
    R.htmlSearchPath({ sub: "LocalLLaMA" }, { q: "gemma", sort: "new", t: "all", restrict_sr: false }),
    R.htmlSearchPath({ sub: "../x" }, { q: "a&b", restrict_sr: true }),
  ];
});
check("logged-out search paths", JSON.stringify(spath) === JSON.stringify([
  "/svc/shreddit/search/?q=Gemma+5+LLM+capabilities&type=posts",
  "/svc/shreddit/r/LocalLLaMA/search/?q=gemma&type=posts&sort=top&t=week",
  "/svc/shreddit/search/?q=gemma&type=posts&sort=new",
  "/svc/shreddit/search/?q=a%26b&type=posts",
]), JSON.stringify(spath));
const dates = await page.evaluate(() => [globalThis.ORR_REBUILD.isoToUtc("2026-10-14T19:20:16.991000+0000"), globalThis.ORR_REBUILD.isoToUtc("2026-10-14T10:28:29.199Z")]);
check("isoToUtc", dates[0] === Date.UTC(2026, 9, 14, 19, 20, 16, 991) / 1000 && dates[1] === Date.UTC(2026, 9, 14, 10, 28, 29, 199) / 1000, JSON.stringify(dates));
console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
await browser.close();
process.exit(fail ? 1 : 0);
