"use strict";

// EXPERIMENTAL "rebuild" mode: on a subreddit / front-page LISTING route, throw
// away new Reddit's DOM and render OLD Reddit's real frontend from the JSON API,
// styled by the bundled archived stylesheet (vendor/oldreddit.bundled.css).
//
// Data path: same-origin `fetch(path + '/.json', {credentials:'include'})`, which
// rides the logged-in user's reddit_session cookie. Logged-out users get 403
// (Reddit deprecated unauthenticated .json in 2026) — on ANY non-200 we fall back
// and let new Reddit render, never leaving the page blank.
//
// Pure builders are exposed on globalThis.ORR_REBUILD for unit testing.

(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const ORR = globalThis.ORR;

  // ---------- pure helpers (testable) ----------------------------------

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Relative age like old reddit ("5 hours ago"), from a unix seconds timestamp.
  function formatAge(createdUtc, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    let s = Math.max(0, Math.floor(now / 1000 - createdUtc));
    const units = [
      ["year", 31536000],
      ["month", 2592000],
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
      ["second", 1],
    ];
    for (const [name, secs] of units) {
      if (s >= secs || name === "second") {
        const n = Math.floor(s / secs);
        return `${n} ${name}${n === 1 ? "" : "s"} ago`;
      }
    }
    return "just now";
  }

  function thumbnailHtml(d, permalink) {
    const t = d.thumbnail;
    if (t && /^https?:\/\//.test(t) && !d.over_18) {
      const w = d.thumbnail_width || 70;
      const h = d.thumbnail_height || 70;
      return `<a class="thumbnail may-blank" href="${esc(permalink)}"><img src="${esc(t)}" width="${esc(w)}" height="${esc(h)}" alt=""></a>`;
    }
    const cls = d.is_self ? "self" : d.over_18 ? "nsfw" : "default";
    return `<a class="thumbnail ${cls} may-blank" href="${esc(permalink)}"></a>`;
  }

  // Build one old-reddit listing item (.thing.link) from a post's `data` object.
  function buildItem(d, opts) {
    opts = opts || {};
    const permalink = d.permalink || "/comments/" + (d.id || "");
    const linkHref = d.is_self ? permalink : d.url || permalink;
    const scoreHidden = d.score_hidden || d.hide_score;
    const score = scoreHidden ? "&bull;" : esc(d.score);
    const comments = d.num_comments === 1 ? "1 comment" : `${esc(d.num_comments || 0)} comments`;
    const iso = new Date((d.created_utc || 0) * 1000).toISOString();
    const toSub = opts.showSub
      ? ` to <a href="/r/${esc(d.subreddit)}/" class="subreddit hover">r/${esc(d.subreddit)}</a>`
      : "";
    const oddeven = opts.odd ? "odd" : "even";
    const nsfw = d.over_18 ? "over18" : "";
    // On a comments page the post shows its self-text expanded.
    const expando =
      opts.expandText && d.is_self && d.selftext_html
        ? `<div class="expando"><div class="usertext-body">${d.selftext_html}</div></div>`
        : "";

    return (
      `<div class="thing id-${esc(d.name)} ${oddeven} ${nsfw} link" id="thing_${esc(d.name)}"` +
      ` data-fullname="${esc(d.name)}" data-permalink="${esc(permalink)}" data-subreddit="${esc(d.subreddit)}"` +
      ` data-author="${esc(d.author)}" data-domain="${esc(d.domain)}" data-nsfw="${d.over_18 ? "true" : "false"}">` +
      `<span class="rank">${esc(opts.rank || "")}</span>` +
      `<div class="midcol unvoted">` +
      `<div class="arrow up login-required" role="button" aria-label="upvote"></div>` +
      `<div class="score unvoted" title="${esc(d.score)}">${score}</div>` +
      `<div class="arrow down login-required" role="button" aria-label="downvote"></div>` +
      `</div>` +
      thumbnailHtml(d, permalink) +
      `<div class="entry unvoted">` +
      `<div class="top-matter">` +
      `<p class="title">` +
      `<a class="title may-blank" href="${esc(linkHref)}" tabindex="1">${esc(d.title)}</a>` +
      ` <span class="domain">(<a href="/domain/${esc(d.domain)}/">${esc(d.domain)}</a>)</span>` +
      `</p>` +
      `<p class="tagline">submitted <time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time>` +
      ` by <a href="/user/${esc(d.author)}" class="author may-blank">${esc(d.author)}</a>${toSub}</p>` +
      `<ul class="flat-list buttons">` +
      `<li class="first"><a href="${esc(permalink)}" class="bylink comments may-blank">${comments}</a></li>` +
      `<li class="share"><a class="post-sharing-button" href="${esc(permalink)}">share</a></li>` +
      `</ul>` +
      `</div>` +
      expando +
      `</div><div class="clearleft"></div></div>`
    );
  }

  const TABS = [
    ["hot", ""],
    ["new", "new"],
    ["rising", "rising"],
    ["controversial", "controversial"],
    ["top", "top"],
  ];

  function tabmenuHtml(route) {
    const base = route.scope === "front" ? "" : "/r/" + route.sub;
    const lis = TABS.map(([name, seg]) => {
      const href = base + "/" + (seg ? seg + "/" : "");
      const sel = route.sort === name ? " selected" : "";
      return `<li class="${sel}"><a class="choice" href="${href}">${name}</a></li>`;
    }).join("");
    return `<ul class="tabmenu">${lis}</ul>`;
  }

  function navButtonsHtml(route, listing, count, t) {
    const tq = t ? "&t=" + t : "";
    const parts = [];
    if (listing.before) {
      parts.push(
        `<a href="${route.basePath}/?count=${count}&before=${esc(listing.before)}${tq}" rel="prev nofollow">&lsaquo; prev</a>`
      );
    }
    if (listing.after) {
      parts.push(
        `<a href="${route.basePath}/?count=${count}&after=${esc(listing.after)}${tq}" rel="next nofollow">next &rsaquo;</a>`
      );
    }
    if (!parts.length) return "";
    return `<div class="nav-buttons"><span class="nextprev">view more: ${parts.join(" ")}</span></div>`;
  }

  // The old-reddit "links from:" time filter, shown on top/controversial listings.
  const TIMES = [
    ["hour", "past hour"],
    ["day", "past 24 hours"],
    ["week", "past week"],
    ["month", "past month"],
    ["year", "past year"],
    ["all", "all time"],
  ];

  function timeMenuHtml(route, currentT) {
    const t = currentT || "day"; // reddit's default for top/controversial
    const links = TIMES.map(([val, label]) => {
      const sel = val === t;
      return `<a href="${route.basePath}/?t=${val}"${sel ? ' style="font-weight:bold;text-decoration:underline"' : ""}>${label}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    return `<div class="menuarea" style="padding:5px 5px 5px 10px;font-size:small">links from: ${links}</div>`;
  }

  // Build the full old-reddit page body (className + innerHTML) for a listing.
  function buildBody(route, json, opts) {
    opts = opts || {};
    const listing = (json && json.data) || {};
    const children = (listing.children || []).filter((c) => c.kind === "t3");
    const showSub = route.scope === "front" || route.sub === "all" || route.sub === "popular";
    const startRank = (opts.startCount || 0) + 1;

    const items = children
      .map((c, i) =>
        buildItem(c.data, { rank: startRank + i, odd: i % 2 === 0, showSub, nowMs: opts.nowMs })
      )
      .join("");

    const count = (startRank - 1) + children.length;
    const pageName = route.scope === "front" ? "reddit.com" : "r/" + route.sub;
    const headerLink = route.scope === "front" ? "/" : "/r/" + route.sub + "/";

    const inner =
      `<div id="header" role="banner"><div id="header-bottom-left">` +
      `<span class="pagename redditname"><a href="${headerLink}">${esc(pageName)}</a></span>` +
      tabmenuHtml(route) +
      `</div></div>` +
      `<div class="side"></div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      (route.sort === "top" || route.sort === "controversial" ? timeMenuHtml(route, opts.t) : "") +
      `<div id="siteTable" class="sitetable linklisting">` +
      (items || `<div class="thing">Nothing here.</div>`) +
      `</div>` +
      navButtonsHtml(route, listing, count, opts.t) +
      `</div>`;

    return { className: `listing-page ${route.sort}-page`, inner };
  }

  function formatNumber(n) {
    if (n == null || isNaN(n)) return "0";
    try {
      return Number(n).toLocaleString("en-US");
    } catch (e) {
      return String(n);
    }
  }

  // Build old reddit's right sidebar (.side) from /about.json + /about/rules.json.
  // description_html / rule description_html are Reddit's own sanitized markdown
  // HTML (fetched with raw_json=1) and are inserted as-is, like old reddit did.
  function buildSidebar(about, rules) {
    const d = (about && about.data) || {};
    const dn = d.display_name || "";
    const name = d.display_name_prefixed || (dn ? "r/" + dn : "");

    let html = '<div class="spacer"><div class="titlebox">';
    html += `<h1 class="redditname"><a class="hover" href="/r/${esc(dn)}/">${esc(name)}</a></h1>`;
    html += `<div class="subscribers"><span class="number">${formatNumber(d.subscribers)}</span> <span class="word">readers</span></div>`;
    const online = d.active_user_count != null ? d.active_user_count : d.accounts_active;
    if (online != null)
      html += `<div class="users-online"><span class="number">${formatNumber(online)}</span> <span class="word">users here now</span></div>`;
    if (d.description_html) html += `<div class="usertext-body"><div class="md">${d.description_html}</div></div>`;
    else if (d.public_description)
      html += `<div class="usertext-body"><div class="md"><p>${esc(d.public_description)}</p></div></div>`;
    html += "</div></div>";

    const list = (rules && rules.rules) || [];
    if (list.length) {
      html += '<div class="spacer"><div class="sidecontentbox"><div class="title"><h1>Rules</h1></div>';
      html += '<div class="content"><ol class="rules-list" style="padding-left:0;list-style:none">';
      list.forEach((r, i) => {
        html += `<li class="rule" style="margin:0 0 8px 0"><b>${i + 1}. ${esc(r.short_name || "")}</b>`;
        if (r.description_html) html += `<div class="md">${r.description_html}</div>`;
        else if (r.description) html += `<div class="rule-desc">${esc(r.description)}</div>`;
        html += "</li>";
      });
      html += "</ol></div></div></div>";
    }
    return html;
  }

  // ---------- comments page builders (testable) ------------------------

  const COMMENT_SORTS = ["best", "top", "new", "controversial", "old", "qa"];

  function commentSortMenuHtml(permalink, currentSort) {
    const cur = currentSort || "best";
    const links = COMMENT_SORTS.map((s) => {
      const sel = s === cur;
      return `<a href="${esc(permalink)}?sort=${s}"${sel ? ' style="font-weight:bold;text-decoration:underline"' : ""}>${s}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    return `<div class="menuarea" style="padding:5px 10px;font-size:small">sorted by: ${links}</div>`;
  }

  function childrenOf(replies) {
    if (replies && replies.data && Array.isArray(replies.data.children)) return replies.data.children;
    return [];
  }

  function buildMore(d, linkId) {
    const count = d.count || 0;
    if (!d.children || !d.children.length) {
      return `<div class="morecomments"><a href="#" class="orr-more" data-link="${esc(linkId)}" data-parent="${esc(d.parent_id || "")}">continue this thread &rarr;</a></div>`;
    }
    return (
      `<div class="morecomments"><a href="#" class="orr-more" data-link="${esc(linkId)}"` +
      ` data-children="${esc(d.children.join(","))}" data-count="${esc(count)}">` +
      `load more comments (${esc(count)} ${count === 1 ? "reply" : "replies"})</a></div>`
    );
  }

  function buildComment(d, opts) {
    opts = opts || {};
    const pts = d.score_hidden ? "score hidden" : `${esc(d.score)} point${d.score === 1 ? "" : "s"}`;
    const bodyHtml = d.body_html ? d.body_html : d.body ? `<div class="md"><p>${esc(d.body)}</p></div>` : "";
    const iso = new Date((d.created_utc || 0) * 1000).toISOString();
    const kids = childrenOf(d.replies);
    const childHtml = kids.length ? buildCommentTree(kids, opts.linkId, opts.nowMs) : "";
    return (
      `<div class="thing comment id-${esc(d.name)}" id="thing_${esc(d.name)}" data-fullname="${esc(d.name)}" data-author="${esc(d.author)}">` +
      `<span class="rank"></span>` +
      `<div class="midcol unvoted"><div class="arrow up login-required" role="button" aria-label="upvote"></div>` +
      `<div class="arrow down login-required" role="button" aria-label="downvote"></div></div>` +
      `<div class="entry unvoted">` +
      `<p class="tagline"><a href="/user/${esc(d.author)}" class="author may-blank">${esc(d.author)}</a>` +
      ` <span class="score unvoted">${pts}</span> ` +
      `<time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time></p>` +
      `<div class="usertext-body">${bodyHtml}</div>` +
      `<ul class="flat-list buttons"><li class="first"><a href="${esc(d.permalink || "")}" class="bylink">permalink</a></li></ul>` +
      `</div>` +
      `<div class="child">${childHtml}</div>` +
      `<div class="clearleft"></div></div>`
    );
  }

  function buildCommentTree(children, linkId, nowMs) {
    return (children || [])
      .map((c) => {
        if (c.kind === "t1") return buildComment(c.data, { linkId, nowMs });
        if (c.kind === "more") return buildMore(c.data, linkId);
        return "";
      })
      .join("");
  }

  // Build the full old-reddit comments page from the [post, comments] JSON array.
  function buildCommentsBody(data, opts) {
    opts = opts || {};
    const postListing = data && data[0] && data[0].data;
    const commentsListing = data && data[1] && data[1].data;
    const post = postListing && postListing.children && postListing.children[0] && postListing.children[0].data;
    const comments = (commentsListing && commentsListing.children) || [];
    const linkId = post ? post.name : "";
    const sub = post ? post.subreddit : opts.sub || "";
    const permalink = post ? post.permalink : opts.permalink || "";

    const postHtml = post ? buildItem(post, { rank: "", showSub: false, expandText: true, nowMs: opts.nowMs }) : "";
    const treeHtml = buildCommentTree(comments, linkId, opts.nowMs);

    const inner =
      `<div id="header" role="banner"><div id="header-bottom-left">` +
      `<span class="pagename redditname"><a href="/r/${esc(sub)}/">r/${esc(sub)}</a></span>` +
      `<ul class="tabmenu"><li class="selected"><a class="choice" href="${esc(permalink)}">comments</a></li></ul>` +
      `</div></div>` +
      `<div class="side"></div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      `<div id="siteTable" class="sitetable">${postHtml}</div>` +
      `<div class="commentarea">` +
      commentSortMenuHtml(permalink, opts.sort) +
      `<div class="sitetable nestedlisting">${treeHtml || '<div class="thing">No comments yet.</div>'}</div>` +
      `</div></div>`;

    return { className: "comments-page", inner, sub, linkId };
  }

  // ---------- user profile builders (testable) -------------------------

  const USER_TABS = ["overview", "submitted", "comments", "gilded"];

  function userTabmenuHtml(route) {
    const lis = USER_TABS.map((name) => {
      const href = "/user/" + route.name + (name === "overview" ? "/" : "/" + name + "/");
      const sel = route.section === name ? " selected" : "";
      return `<li class="${sel}"><a class="choice" href="${href}">${name}</a></li>`;
    }).join("");
    return `<ul class="tabmenu">${lis}</ul>`;
  }

  // A comment as shown on a user page: with "on <post> in r/<sub>" context.
  function buildUserComment(d, opts) {
    opts = opts || {};
    const pts = d.score_hidden ? "score hidden" : `${esc(d.score)} point${d.score === 1 ? "" : "s"}`;
    const bodyHtml = d.body_html ? d.body_html : d.body ? `<div class="md"><p>${esc(d.body)}</p></div>` : "";
    const iso = new Date((d.created_utc || 0) * 1000).toISOString();
    const linkPermalink = d.permalink || d.link_permalink || "";
    const sub = d.subreddit || "";
    return (
      `<div class="thing comment id-${esc(d.name)}" id="thing_${esc(d.name)}" data-fullname="${esc(d.name)}">` +
      `<div class="midcol unvoted"><div class="arrow up login-required" role="button"></div>` +
      `<div class="score unvoted">${esc(d.score)}</div><div class="arrow down login-required" role="button"></div></div>` +
      `<div class="entry unvoted">` +
      `<p class="tagline"><a href="/user/${esc(d.author)}" class="author">${esc(d.author)}</a> ` +
      `<span class="score unvoted">${pts}</span> <time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time> ` +
      `on <a href="${esc(linkPermalink)}" class="bylink">${esc(d.link_title || "a post")}</a> ` +
      `in <a href="/r/${esc(sub)}/" class="subreddit">r/${esc(sub)}</a></p>` +
      `<div class="usertext-body">${bodyHtml}</div>` +
      `<ul class="flat-list buttons"><li class="first"><a href="${esc(linkPermalink)}" class="bylink">permalink</a></li></ul>` +
      `</div><div class="clearleft"></div></div>`
    );
  }

  function buildUserPage(route, json, opts) {
    opts = opts || {};
    const listing = (json && json.data) || {};
    const children = listing.children || [];
    const startRank = (opts.startCount || 0) + 1;
    const items = children
      .map((c, i) => {
        if (c.kind === "t3") return buildItem(c.data, { rank: startRank + i, odd: i % 2 === 0, showSub: true, nowMs: opts.nowMs });
        if (c.kind === "t1") return buildUserComment(c.data, { nowMs: opts.nowMs });
        return "";
      })
      .join("");
    const count = (startRank - 1) + children.length;
    const inner =
      `<div id="header" role="banner"><div id="header-bottom-left">` +
      `<span class="pagename redditname"><a href="/user/${esc(route.name)}/">${esc(route.name)}</a></span>` +
      userTabmenuHtml(route) +
      `</div></div>` +
      `<div class="side"></div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      `<div id="siteTable" class="sitetable">` +
      (items || '<div class="thing">Nothing here.</div>') +
      `</div>` +
      navButtonsHtml({ basePath: route.basePath }, listing, count, null) +
      `</div>`;
    return { className: "profile-page", inner };
  }

  function buildUserSidebar(about) {
    const d = (about && about.data) || {};
    const name = d.name || "";
    const cake = d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : "";
    let html = '<div class="spacer"><div class="titlebox">';
    html += `<h1 class="redditname"><a class="hover" href="/user/${esc(name)}/">u/${esc(name)}</a></h1>`;
    html += `<div class="karma"><span class="number">${formatNumber(d.link_karma)}</span> post karma</div>`;
    html += `<div class="karma comment-karma"><span class="number">${formatNumber(d.comment_karma)}</span> comment karma</div>`;
    if (cake) html += `<div class="bottom">cake day <span class="date">${esc(cake)}</span></div>`;
    html += "</div></div>";
    return html;
  }

  globalThis.ORR_REBUILD = {
    esc, formatAge, thumbnailHtml, buildItem, tabmenuHtml, navButtonsHtml, timeMenuHtml, buildBody,
    formatNumber, buildSidebar, commentSortMenuHtml, childrenOf, buildMore, buildComment, buildCommentTree, buildCommentsBody,
    userTabmenuHtml, buildUserComment, buildUserPage, buildUserSidebar,
  };

  // ---------- runtime driver -------------------------------------------

  const CSS_URL = api.runtime.getURL("vendor/oldreddit.bundled.css");
  const GUARD_ID = "orr-rebuild-guard";
  const CSS_ID = "orr-rebuild-css";
  const cache = new Map(); // jsonUrl -> { json, t }
  const CACHE_TTL = 60000;
  let active = false; // rebuild currently owns the page
  let wired = false;

  function hideGuard() {
    if (document.getElementById(GUARD_ID)) return;
    const s = document.createElement("style");
    s.id = GUARD_ID;
    s.textContent = "html{visibility:hidden!important}";
    (document.head || document.documentElement).appendChild(s);
  }
  function unhideGuard() {
    const s = document.getElementById(GUARD_ID);
    if (s) s.remove();
  }

  async function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    let text = "";
    try {
      const res = await fetch(CSS_URL);
      text = await res.text();
    } catch (e) {
      /* ignore — page still renders, just unstyled */
    }
    const style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = text;
    (document.head || document.documentElement).appendChild(style);
  }

  function jsonUrlFor(route, params) {
    const q = new URLSearchParams({ raw_json: "1", limit: "25" });
    if (params.after) {
      q.set("after", params.after);
      q.set("count", params.count || "25");
    } else if (params.before) {
      q.set("before", params.before);
      q.set("count", params.count || "25");
    }
    if ((route.sort === "top" || route.sort === "controversial") && params.t) q.set("t", params.t);
    return location.origin + route.basePath + "/.json?" + q.toString();
  }

  async function fetchListing(route, params) {
    const url = jsonUrlFor(route, params);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
    const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    cache.set(url, { json, t: Date.now() });
    return json;
  }

  function replaceBody(body, title) {
    const fresh = document.createElement("body");
    fresh.className = body.className;
    fresh.innerHTML = body.inner;
    if (document.body) document.documentElement.replaceChild(fresh, document.body);
    else document.documentElement.appendChild(fresh);
    document.documentElement.classList.add("orr-rebuilt");
    try {
      document.title = title;
    } catch (e) {
      /* ignore */
    }
  }

  function renderInto(route, json, params) {
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    const body = buildBody(route, json, { startCount, t: params.t });
    const sub = route.scope === "front" ? "reddit" : "r/" + route.sub;
    replaceBody(body, sub + " — old reddit");
    loadSidebar(route); // async, fills .side when about/rules arrive
  }

  const aboutCache = new Map(); // sub (lowercase) -> { v, t }
  const ABOUT_TTL = 300000; // 5 min

  async function fetchAboutRules(sub) {
    const key = sub.toLowerCase();
    const hit = aboutCache.get(key);
    if (hit && Date.now() - hit.t < ABOUT_TTL) return hit.v;
    const base = location.origin + "/r/" + encodeURIComponent(sub);
    const get = (u) =>
      fetch(u, { credentials: "include", headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    const [about, rules] = await Promise.all([
      get(base + "/about.json?raw_json=1"),
      get(base + "/about/rules.json?raw_json=1"),
    ]);
    const v = { about, rules };
    aboutCache.set(key, { v, t: Date.now() });
    return v;
  }

  async function loadSidebar(route) {
    if (!route || route.scope !== "sub") return;
    const sub = route.sub;
    // No single sidebar for aggregate/multireddit listings.
    if (!sub || sub === "all" || sub === "popular" || /[+\-]/.test(sub)) return;
    let v;
    try {
      v = await fetchAboutRules(sub);
    } catch (e) {
      return;
    }
    if (!v || !v.about || !v.about.data) return;
    const side = document.querySelector(".side");
    if (side) side.innerHTML = buildSidebar(v.about, v.rules);
  }

  function renderError(status) {
    const st = document.getElementById("siteTable");
    const msg =
      status === 403
        ? "Old Reddit Skin: the Reddit JSON API returned 403 (are you logged in? Reddit blocks logged-out .json). Turn off Rebuild mode to use normal Reddit."
        : "Old Reddit Skin: couldn't load this page from the Reddit API (" + status + ").";
    if (st) st.innerHTML = `<div class="thing"><div class="entry"><p>${esc(msg)}</p></div></div>`;
  }

  async function loadListing(url, firstLoad) {
    const route = ORR.isListingRoute(url);
    if (!route) return;
    const params = {
      after: url.searchParams.get("after"),
      before: url.searchParams.get("before"),
      count: url.searchParams.get("count"),
      t: url.searchParams.get("t"),
    };
    hideGuard();
    // Safety: if the fetch hangs on first load, never leave the page blank —
    // reveal new Reddit after a timeout.
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let json;
    try {
      json = await fetchListing(route, params);
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) {
        // Never blank the page: let new Reddit render instead.
        active = false;
        unhideGuard();
      } else {
        renderError(err.status || 0);
        unhideGuard();
      }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    renderInto(route, json, params);
    active = true;
    unhideGuard();
  }

  async function loadComments(url, firstLoad) {
    const cr = ORR.isCommentsRoute(url);
    if (!cr) return;
    const sort = url.searchParams.get("sort");
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let data;
    try {
      const q = new URLSearchParams({ raw_json: "1", limit: "200" });
      if (sort) q.set("sort", sort);
      const jsonUrl = location.origin + url.pathname.replace(/\/$/, "") + "/.json?" + q.toString();
      const res = await fetch(jsonUrl, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) {
        const e = new Error("HTTP " + res.status);
        e.status = res.status;
        throw e;
      }
      data = await res.json();
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) {
        active = false;
        unhideGuard();
      } else {
        renderError(err.status || 0);
        unhideGuard();
      }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    const body = buildCommentsBody(data, { sub: cr.sub, permalink: url.pathname, sort });
    replaceBody(body, (body.sub ? "r/" + body.sub : "reddit") + " — comments");
    active = true;
    unhideGuard();
    loadSidebar({ scope: "sub", sub: body.sub || cr.sub });
  }

  async function loadUser(url, firstLoad) {
    const ur = ORR.isUserRoute(url);
    if (!ur) return;
    const params = { after: url.searchParams.get("after"), count: url.searchParams.get("count") };
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let json;
    try {
      const q = new URLSearchParams({ raw_json: "1", limit: "25" });
      if (params.after) {
        q.set("after", params.after);
        q.set("count", params.count || "25");
      }
      const jsonUrl = location.origin + ur.basePath + "/.json?" + q.toString();
      const res = await fetch(jsonUrl, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) {
        const e = new Error("HTTP " + res.status);
        e.status = res.status;
        throw e;
      }
      json = await res.json();
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) {
        active = false;
        unhideGuard();
      } else {
        renderError(err.status || 0);
        unhideGuard();
      }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    replaceBody(buildUserPage(ur, json, { startCount }), "u/" + ur.name + " — old reddit");
    active = true;
    unhideGuard();
    loadUserSidebar(ur.name);
  }

  async function loadUserSidebar(name) {
    try {
      const res = await fetch(location.origin + "/user/" + encodeURIComponent(name) + "/about.json?raw_json=1", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const about = await res.json();
      const side = document.querySelector(".side");
      if (side && about && about.data) side.innerHTML = buildUserSidebar(about);
    } catch (e) {
      /* ignore */
    }
  }

  function loadPage(url, firstLoad) {
    if (ORR.isListingRoute(url)) return loadListing(url, firstLoad);
    if (ORR.isCommentsRoute(url)) return loadComments(url, firstLoad);
    if (ORR.isUserRoute(url)) return loadUser(url, firstLoad);
  }

  // Expand a "load more comments" stub via the morechildren API, re-nesting the
  // returned comments under their parent by parent_id. Best-effort (experimental).
  async function handleMore(el) {
    const linkId = el.getAttribute("data-link");
    const childrenCsv = el.getAttribute("data-children");
    if (!childrenCsv) {
      el.textContent = "(continue this thread — open the comment's permalink)";
      return;
    }
    const original = el.textContent;
    el.textContent = "loading…";
    try {
      const q = new URLSearchParams({
        api_type: "json", link_id: linkId, children: childrenCsv, raw_json: "1", limit_children: "false",
      });
      const res = await fetch(location.origin + "/api/morechildren.json?" + q.toString(), {
        credentials: "include", headers: { Accept: "application/json" },
      });
      const j = await res.json();
      const things = (j && j.json && j.json.data && j.json.data.things) || [];
      insertMoreThings(el, things, linkId);
    } catch (e) {
      el.textContent = original + " (failed to load)";
    }
  }

  function insertMoreThings(moreEl, things, linkId) {
    const wrap = moreEl.parentElement; // .morecomments
    for (const t of things) {
      let html = "";
      if (t.kind === "t1") html = buildComment(t.data, { linkId });
      else if (t.kind === "more") html = buildMore(t.data, linkId);
      else continue;
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      const node = tmp.firstElementChild;
      if (!node) continue;
      const parentId = t.data.parent_id;
      const parentThing = parentId ? document.getElementById("thing_" + parentId) : null;
      let target = parentThing ? parentThing.querySelector(":scope > .child") : null;
      if (!target) target = wrap && wrap.parentElement; // fall back to the nesting level of the stub
      if (target) target.appendChild(node);
    }
    if (wrap) wrap.remove(); // drop the used stub
  }

  function wireNav() {
    if (wired) return;
    wired = true;

    document.addEventListener(
      "click",
      (e) => {
        if (!active) return;
        // "load more comments" stub → expand via the morechildren API.
        const moreEl = e.target.closest && e.target.closest("a.orr-more");
        if (moreEl) {
          e.preventDefault();
          e.stopPropagation();
          handleMore(moreEl);
          return;
        }
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const href = a.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
        let url;
        try {
          url = new URL(href, location.origin);
        } catch (_) {
          return;
        }
        if (url.origin !== location.origin) return; // external link → normal nav
        // Only intercept routes we rebuild; let search/wiki/etc navigate normally.
        if (!ORR.isListingRoute(url) && !ORR.isCommentsRoute(url) && !ORR.isUserRoute(url)) return;
        e.preventDefault();
        e.stopPropagation();
        history.pushState(null, "", url.pathname + url.search);
        window.scrollTo(0, 0);
        loadPage(url, false);
      },
      true
    );

    window.addEventListener("popstate", () => {
      if (!active) return;
      const url = new URL(location.href);
      if (ORR.isListingRoute(url) || ORR.isCommentsRoute(url) || ORR.isUserRoute(url)) loadPage(url, false);
    });
  }

  async function start() {
    let prefs;
    try {
      prefs = await ORR.getPrefs();
    } catch (e) {
      return;
    }
    if (!prefs.rebuild) return; // rebuild mode off → restyle.js handles the page
    const url = new URL(location.href);
    if (!ORR.isListingRoute(url) && !ORR.isCommentsRoute(url) && !ORR.isUserRoute(url)) return; // else restyle.js skins
    wireNav();
    loadPage(url, true);
  }

  // React to the toggle changing live.
  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.rebuild || changes.enabled)) {
        if (changes.rebuild && changes.rebuild.newValue === false && active) {
          location.reload(); // hand the page back to new Reddit
        } else if (!active) {
          start();
        }
      }
    });
  } catch (e) {
    /* ignore */
  }

  start();
})();
