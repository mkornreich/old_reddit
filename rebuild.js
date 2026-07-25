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

  // True for links that point at an image (reddit/imgur CDNs or a direct image URL),
  // e.g. https://preview.redd.it/xyz.png?width=573&...&s=abc
  function isImageUrl(href) {
    if (typeof href !== "string" || !href) return false;
    // Video files (incl. imgur .gifv) are handled by externalMediaExpando, not as images.
    if (/\.(gifv|mp4|webm|mov)(?:[?#]|$)/i.test(href)) return false;
    if (/(?:i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it|i\.imgur\.com)\//i.test(href)) return true;
    return /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(href);
  }

  // Reddit serves a v.redd.it video as a video-only DASH mp4 plus a separate audio
  // file. Derive the likely audio URLs from the fallback (video) URL — Reddit has
  // used several names over the years, so we list them newest-first and the runtime
  // probes them in order. Returns [] if this isn't a v.redd.it fallback URL.
  function vRedditBase(fallbackUrl) {
    const m = /^(https?:\/\/v\.redd\.it\/[^/?#]+)\//i.exec(fallbackUrl || "");
    return m ? m[1] : null;
  }
  // Candidate audio-track URLs, tried in order if the DASH manifest can't be read.
  // Reddit has used CMAF (current) and DASH (older) container/naming schemes.
  function audioCandidates(base) {
    if (!base) return [];
    return [
      base + "/CMAF_AUDIO_128.mp4",
      base + "/CMAF_AUDIO_64.mp4",
      base + "/DASH_AUDIO_128.mp4",
      base + "/DASH_AUDIO_64.mp4",
      base + "/DASH_audio.mp4",
      base + "/audio",
    ];
  }

  function embedHtml(src, extra, w, h) {
    return `<div class="expando-container"><iframe class="orr-embed" src="${esc(src)}" width="${w || 640}" height="${h || 360}" frameborder="0" loading="lazy" referrerpolicy="no-referrer" ${extra || ""}></iframe></div>`;
  }

  // Expand common non-Reddit media hosts inline (RES "show images" style), from a
  // post's outbound URL. Returns { type, html } or null.
  function externalMediaExpando(url) {
    if (!url) return null;
    let m;
    if ((m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i.exec(url))) {
      const t = (/[?&](?:t|start)=(\d+)/.exec(url) || [])[1];
      return { type: "video", html: embedHtml("https://www.youtube-nocookie.com/embed/" + m[1] + (t ? "?start=" + t : ""), 'allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen') };
    }
    if ((m = /redgifs\.com\/(?:watch|ifr)\/([A-Za-z0-9]+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://www.redgifs.com/ifr/" + m[1], "allowfullscreen") };
    }
    if ((m = /streamable\.com\/(?:e\/)?([A-Za-z0-9]+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://streamable.com/e/" + m[1], "allowfullscreen") };
    }
    if ((m = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://platform.twitter.com/embed/Tweet.html?id=" + m[1], "", 550, 500) };
    }
    if ((m = /imgur\.com\/(?:a|gallery)\/([A-Za-z0-9]+)/i.exec(url))) {
      return { type: "image", html: embedHtml("https://imgur.com/a/" + m[1] + "/embed?pub=true", "allowfullscreen", 640, 500) };
    }
    if (/\.gifv(\?|$)/i.test(url)) {
      return { type: "video", html: `<div class="expando-container"><video class="orr-directvideo" controls loop preload="metadata" width="640"><source src="${esc(url.replace(/\.gifv(\?|$)/i, ".mp4$1"))}" type="video/mp4"></video></div>` };
    }
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
      return { type: "video", html: `<div class="expando-container"><video class="orr-directvideo" controls preload="metadata" width="640"><source src="${esc(url)}"></video></div>` };
    }
    return null;
  }

  // Determine a post's expandable inline content, or null. Returns { type, html }
  // where type feeds the old-reddit expando-button sprite (selftext/image/video…).
  function postExpando(d) {
    if (d.is_self) {
      return d.selftext_html
        ? { type: "selftext", html: `<div class="expando-container"><div class="usertext-body"><div class="md">${d.selftext_html}</div></div></div>` }
        : null;
    }
    const rv = d.media && d.media.reddit_video;
    if (d.is_video && rv && rv.fallback_url) {
      // Reddit's fallback_url is a VIDEO-ONLY stream — the audio is a separate
      // v.redd.it file. We attach the DASH manifest URL (authoritative for the
      // exact audio track, across DASH/CMAF naming) plus candidate URLs as a
      // fallback, so the runtime can play a hidden, synced <audio> element
      // alongside the video (see wireRedditVideo).
      // Reddit "gif" videos (is_gif) have no audio track — don't bother probing.
      const base = (rv.has_audio === false || rv.is_gif === true) ? null : vRedditBase(rv.fallback_url);
      const cands = audioCandidates(base);
      const dashUrl = base ? base + "/DASHPlaylist.mpd" : "";
      const audioAttr = cands.length
        ? ` data-audio-candidates="${esc(cands.join("|"))}" data-dash-url="${esc(dashUrl)}"`
        : "";
      return {
        type: cands.length ? "video" : "video-muted",
        html: `<div class="expando-container"><video class="reddit-video" controls preload="none"${audioAttr} width="${esc(rv.width || 640)}" height="${esc(rv.height || 360)}"><source src="${esc(rv.fallback_url)}" type="video/mp4"></video></div>`,
      };
    }
    if (d.is_gallery && d.gallery_data && d.media_metadata) {
      const srcs = (d.gallery_data.items || [])
        .map((it) => {
          const m = d.media_metadata[it.media_id];
          return m && m.s ? m.s.u || m.s.gif : null;
        })
        .filter(Boolean);
      if (srcs.length) {
        const n = srcs.length;
        const imgs = srcs.map((s, i) => `<img class="orr-gimg${i === 0 ? " active" : ""}" src="${esc(s)}">`).join("");
        const nav =
          n > 1
            ? `<div class="orr-gnav-bar"><a class="orr-gnav" data-d="-1" href="javascript:void(0)">&lsaquo; prev</a> <span class="orr-gcount">1 / ${n}</span> <a class="orr-gnav" data-d="1" href="javascript:void(0)">next &rsaquo;</a></div>`
            : "";
        return {
          type: "image gallery",
          html: `<div class="expando-container"><div class="orr-gallery" data-idx="0" data-n="${n}">${nav}<div class="orr-gitems">${imgs}</div></div></div>`,
        };
      }
    }
    const ext = externalMediaExpando(d.url);
    if (ext) return ext;
    const isImg = d.post_hint === "image" || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(d.url || "");
    if (isImg) {
      const source = d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].source;
      const src = source && source.url ? source.url : d.url;
      return { type: "image", html: `<div class="expando-container"><span class="orr-resizable"><img class="preview" src="${esc(src)}"></span></div>` };
    }
    return null;
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
    // Expandable content. On a comments page (expandText) it's shown expanded;
    // in listings (expandoButton) it's collapsed behind an old-reddit expando box.
    const exp = opts.expandText || opts.expandoButton ? postExpando(d) : null;
    const expBtn =
      opts.expandoButton && exp
        ? `<div class="expando-button collapsed ${exp.type}" role="button" tabindex="0" aria-label="expand"></div>`
        : "";
    const blur = d.over_18 ? " orr-nsfw" : d.spoiler ? " orr-spoiler" : "";
    const expando = exp ? `<div class="expando${blur}"${opts.expandoButton ? ' style="display:none"' : ""}>${exp.html}</div>` : "";

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
      expBtn +
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
        buildItem(c.data, { rank: startRank + i, odd: i % 2 === 0, showSub, expandoButton: true, nowMs: opts.nowMs })
      )
      .join("");

    const count = (startRank - 1) + children.length;
    const pageName = route.scope === "front" ? "reddit.com" : "r/" + route.sub;
    const headerLink = route.scope === "front" ? "/" : "/r/" + route.sub + "/";

    const inner =
      buildHeader({ tabmenu: tabmenuHtml(route), pageName, pageHref: headerLink, me: opts.me, route }) +
      `<div class="side">${sideSearchHtml(route)}</div>` +
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
      `<div class="thing comment id-${esc(d.name)}" id="thing_${esc(d.name)}" data-fullname="${esc(d.name)}" data-author="${esc(d.author)}" data-created="${esc(d.created_utc || 0)}">` +
      `<span class="rank"></span>` +
      `<div class="midcol unvoted"><div class="arrow up login-required" role="button" aria-label="upvote"></div>` +
      `<div class="arrow down login-required" role="button" aria-label="downvote"></div></div>` +
      `<div class="entry unvoted">` +
      `<p class="tagline"><a href="javascript:void(0)" class="expand" role="button" aria-label="collapse">[&ndash;]</a> ` +
      `<a href="/user/${esc(d.author)}" class="author may-blank">${esc(d.author)}</a>` +
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
      buildHeader({
        tabmenu: `<ul class="tabmenu"><li class="selected"><a class="choice" href="${esc(permalink)}">comments</a></li></ul>`,
        pageName: "r/" + sub,
        pageHref: "/r/" + sub + "/",
        me: opts.me,
        route: { scope: "sub", sub },
      }) +
      `<div class="side">${sideSearchHtml({ scope: "sub", sub })}</div>` +
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
        if (c.kind === "t3") return buildItem(c.data, { rank: startRank + i, odd: i % 2 === 0, showSub: true, expandoButton: true, nowMs: opts.nowMs });
        if (c.kind === "t1") return buildUserComment(c.data, { nowMs: opts.nowMs });
        return "";
      })
      .join("");
    const count = (startRank - 1) + children.length;
    const inner =
      buildHeader({
        tabmenu: userTabmenuHtml(route),
        pageName: route.name,
        pageHref: "/user/" + route.name + "/",
        me: opts.me,
        route: { scope: "user" },
      }) +
      `<div class="side">${sideSearchHtml({ scope: "user" })}</div>` +
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

  // ---------- shared header (testable) ---------------------------------

  // Normalize /api/me.json (modern FLAT shape me.name, OR classic {data:{}}) to an
  // identity, or null when logged out. Never trust me.modhash for writes.
  function meIdentity(me) {
    const d = me && me.name ? me : (me && me.data) || null;
    if (!d || !d.name) return null;
    const link = d.link_karma || 0;
    const comment = d.comment_karma || 0;
    return {
      name: d.name,
      linkKarma: link,
      commentKarma: comment,
      totalKarma: d.total_karma != null ? d.total_karma : link + comment,
      inbox: d.inbox_count || 0,
      hasMail: !!d.has_mail || (d.inbox_count || 0) > 0,
      isGold: !!d.is_gold,
    };
  }

  function userbarLoggedIn(id) {
    const karmaTitle = `post karma: ${formatNumber(id.linkKarma)} / comment karma: ${formatNumber(id.commentKarma)}`;
    const mailCls = id.hasMail ? "havemail" : "nohavemail";
    const badge = id.inbox > 0 ? `<span class="message-count">${esc(id.inbox)}</span>` : "";
    return (
      `<div id="header-bottom-right">` +
      `<span class="user"><a href="/user/${esc(id.name)}" class="hover">${esc(id.name)}</a>` +
      ` <span class="userkarma" title="${esc(karmaTitle)}">${formatNumber(id.totalKarma)}</span></span>` +
      `<span class="separator">|</span>` +
      `<a href="/message/inbox/" id="mail" class="${mailCls}" title="${id.hasMail ? "new mail!" : "no new mail"}">${badge}</a>` +
      `<span class="separator">|</span>` +
      `<a href="/prefs" class="pref-lang">preferences</a>` +
      `<span class="separator">|</span>` +
      `<a href="/logout" id="logout">logout</a>` +
      `</div>`
    );
  }

  function userbarLoggedOut() {
    return (
      `<div id="header-bottom-right">` +
      `<a href="/login" class="login-required login-link">login</a>` +
      ` <span class="separator">or</span> ` +
      `<a href="/register" class="register-link">sign up</a>` +
      `</div>`
    );
  }

  const DEFAULT_SRBAR = ["AskReddit", "funny", "pics", "science", "worldnews", "videos", "gaming", "aww", "todayilearned", "news"];

  function srBarHtml(route) {
    const cur = route && route.scope === "sub" ? String(route.sub || "").toLowerCase() : "";
    const links = DEFAULT_SRBAR.map(
      (s) => `<a href="/r/${esc(s)}/" class="choice${s.toLowerCase() === cur ? " selected" : ""}">${esc(s)}</a>`
    ).join("\n");
    return (
      `<div id="sr-header-area"><div class="width-clip"><div class="sr-list">` +
      `<a href="/" class="choice">front</a><span class="separator">-</span>` +
      `<a href="/r/all/" class="choice${cur === "all" ? " selected" : ""}">all</a><span class="separator">-</span>` +
      `<span class="flat-list sr-bar">${links}</span>` +
      `</div></div></div>`
    );
  }

  function isRealSub(sub) {
    return !!sub && sub !== "all" && sub !== "popular" && !/[+\-]/.test(sub);
  }

  function searchFormHtml(route, query) {
    const inSub = route && route.scope === "sub" && isRealSub(route.sub);
    const action = inSub ? "/r/" + route.sub + "/search" : "/search";
    // "limit to r/x" shown right below the search bar (old reddit hides it in
    // #searchexpando; per request we keep it visible).
    const restrict = inSub
      ? `<div class="orr-restrict" style="font-size:11px;margin-top:4px"><label><input type="checkbox" name="restrict_sr" value="1"> limit my search to r/${esc(route.sub)}</label></div>`
      : "";
    return (
      `<form id="search" action="${esc(action)}" method="get" role="search">` +
      `<input type="text" name="q" placeholder="search" value="${esc(query || "")}">` +
      `<input type="submit" value="">` +
      restrict +
      `</form>`
    );
  }

  // The full old-reddit header. Caller supplies pageName/pageHref + a pre-built
  // tabmenu; `me` is the /api/me.json blob (undefined → logged-out, then patched).
  function buildHeader(opts) {
    opts = opts || {};
    const id = meIdentity(opts.me);
    return (
      `<div id="header" role="banner">` +
      srBarHtml(opts.route) +
      `<a href="/" id="header-img" class="default-header title">reddit</a>` +
      `<div id="header-bottom-left">` +
      `<span class="pagename redditname"><a href="${esc(opts.pageHref || "/")}">${esc(opts.pageName || "reddit.com")}</a></span>` +
      (opts.tabmenu || "") +
      `</div>` +
      (id ? userbarLoggedIn(id) : userbarLoggedOut()) +
      `</div>`
    );
  }

  // Old reddit's search box lives at the TOP of the right sidebar (.side), not in
  // the header — a `.spacer` wrapping the #search form.
  function sideSearchHtml(route, query) {
    return `<div class="spacer">${searchFormHtml(route, query)}</div>`;
  }

  // ---------- search (testable) ----------------------------------------

  function searchJsonUrl(route, params) {
    const q = new URLSearchParams({ raw_json: "1", limit: "25" });
    q.set("q", params.q || "");
    q.set("sort", params.sort || "relevance");
    q.set("t", params.t || "all");
    if (route.sub && params.restrict_sr) q.set("restrict_sr", "1");
    if (params.after) { q.set("after", params.after); q.set("count", params.count || "25"); }
    else if (params.before) { q.set("before", params.before); q.set("count", params.count || "25"); }
    return location.origin + route.basePath + ".json?" + q.toString();
  }

  function searchHref(route, params, overrides) {
    const p = Object.assign({}, params, overrides);
    const q = new URLSearchParams();
    q.set("q", p.q || "");
    if (p.sort) q.set("sort", p.sort);
    if (p.t) q.set("t", p.t);
    if (route.sub && p.restrict_sr) q.set("restrict_sr", "1");
    if (p.after) { q.set("after", p.after); q.set("count", p.count); }
    else if (p.before) { q.set("before", p.before); q.set("count", p.count); }
    return route.basePath + "?" + q.toString();
  }

  const SEARCH_SORTS = ["relevance", "hot", "top", "new", "comments"];

  function searchSortMenuHtml(route, params) {
    const cur = params.sort || "relevance";
    const links = SEARCH_SORTS.map((s) => {
      const href = searchHref(route, params, { sort: s, after: null, before: null, count: null });
      return `<a href="${esc(href)}"${s === cur ? ' style="font-weight:bold;text-decoration:underline"' : ""}>${s}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    return `<div class="menuarea" style="padding:5px 10px;font-size:small">sorted by: ${links}</div>`;
  }

  function searchTimeMenuHtml(route, params) {
    const t = params.t || "all";
    const links = TIMES.map(([val, label]) => {
      const href = searchHref(route, params, { t: val, after: null, before: null, count: null });
      return `<a href="${esc(href)}"${val === t ? ' style="font-weight:bold;text-decoration:underline"' : ""}>${label}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    return `<div class="menuarea" style="padding:5px 10px;font-size:small">links from: ${links}</div>`;
  }

  function searchNavHtml(route, params, listing, count) {
    const parts = [];
    if (listing.before)
      parts.push(`<a href="${esc(searchHref(route, params, { before: listing.before, after: null, count }))}" rel="prev nofollow">&lsaquo; prev</a>`);
    if (listing.after)
      parts.push(`<a href="${esc(searchHref(route, params, { after: listing.after, before: null, count }))}" rel="next nofollow">next &rsaquo;</a>`);
    if (!parts.length) return "";
    return `<div class="nav-buttons"><span class="nextprev">view more: ${parts.join(" ")}</span></div>`;
  }

  function buildSearchPage(json, opts) {
    opts = opts || {};
    const route = opts.route || { scope: "search", sub: null, basePath: "/search" };
    const params = opts.params || {};
    const listing = (json && json.data) || {};
    const children = (listing.children || []).filter((c) => c.kind === "t3");
    const startRank = (opts.startCount || 0) + 1;
    const items = children
      .map((c, i) => buildItem(c.data, { rank: startRank + i, odd: i % 2 === 0, showSub: true, expandoButton: true, nowMs: opts.nowMs }))
      .join("");
    const count = (startRank - 1) + children.length;

    const pageName = route.sub ? "r/" + route.sub : "reddit.com";
    const pageHref = route.sub ? "/r/" + route.sub + "/" : "/";
    const tabmenu = `<ul class="tabmenu"><li class="selected"><a class="choice" href="${esc(searchHref(route, params, {}))}">search</a></li></ul>`;

    const inner =
      buildHeader({ tabmenu, pageName, pageHref, me: opts.me, route, query: params.q }) +
      `<div class="side"></div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      `<div class="searchpane raisedbox">${searchFormHtml(route, params.q)}</div>` +
      searchSortMenuHtml(route, params) +
      searchTimeMenuHtml(route, params) +
      `<div id="siteTable" class="sitetable linklisting search-result-listing">` +
      (items || `<div class="thing">No results.</div>`) +
      `</div>` +
      searchNavHtml(route, params, listing, count) +
      `</div>`;

    return { className: "search-page listing-page", inner };
  }

  globalThis.ORR_REBUILD = {
    esc, formatAge, thumbnailHtml, isImageUrl, postExpando, buildItem, tabmenuHtml, navButtonsHtml, timeMenuHtml, buildBody,
    formatNumber, buildSidebar, commentSortMenuHtml, childrenOf, buildMore, buildComment, buildCommentTree, buildCommentsBody,
    userTabmenuHtml, buildUserComment, buildUserPage, buildUserSidebar,
    meIdentity, userbarLoggedIn, userbarLoggedOut, srBarHtml, searchFormHtml, sideSearchHtml, buildHeader,
    searchJsonUrl, searchHref, buildSearchPage,
  };

  // ---------- runtime driver -------------------------------------------

  const CSS_URL = api.runtime.getURL("vendor/oldreddit.bundled.css");
  const GUARD_ID = "orr-rebuild-guard";
  const CSS_ID = "orr-rebuild-css";
  const cache = new Map(); // jsonUrl -> { json, t }
  const CACHE_TTL = 60000;
  let active = false; // rebuild currently owns the page
  let wired = false;

  // Logged-in identity for the header (fetched once).
  let mePromise = null;
  let meCached; // undefined = not fetched, null = logged out, object = raw me.json

  function fetchMe() {
    if (mePromise) return mePromise;
    mePromise = fetch(location.origin + "/api/me.json", { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        meCached = j && (j.name || (j.data && j.data.name)) ? j : null;
        return meCached;
      })
      .catch(() => {
        meCached = null;
        return null;
      });
    return mePromise;
  }

  // Re-render just the userbar once me.json resolves; idempotent.
  function patchHeader() {
    fetchMe().then((me) => {
      if (!active) return;
      const right = document.querySelector("#header-bottom-right");
      if (!right) return;
      const id = meIdentity(me);
      right.outerHTML = id ? userbarLoggedIn(id) : userbarLoggedOut();
    });
  }

  // --- Rate-limit handling: backoff + retry ----------------------------
  const MAX_RETRY = 8; // auto-retries before falling back to a manual "click to retry"
  const MIN_GAP = 900; // ms between consecutive auto page-loads (~1/sec — the safe zone)

  function isTransient(status) {
    // 429 = rate limit, any 5xx = server/gateway hiccup (502 Bad Gateway and
    // 504 Gateway Timeout are common on Reddit's edge under load), 0/null =
    // network error. NOT 4xx like 401/403/404: a 403 is a logged-out session or
    // a network-security block — retrying only makes it worse, so we surface it.
    return status === 429 || (typeof status === "number" && status >= 500 && status <= 599) || status == null || status === 0;
  }
  function jitter() {
    return Math.floor((typeof Math.random === "function" ? Math.random() : 0.5) * 800);
  }
  function backoffMs(attempt, retryAfterSec) {
    // Honor Retry-After when Reddit sends it, but cap it (a hostile value can't
    // freeze the UI) and add jitter so parallel stubs don't retry in lockstep.
    if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 60000) + jitter();
    const base = Math.min(1500 * Math.pow(2, attempt - 1), 60000); // 1.5, 3, 6, 12, 24, 48, 60…
    return base + jitter();
  }
  function retryAfterOf(res) {
    try {
      const ra = res.headers.get("retry-after");
      if (ra) { const n = parseInt(ra, 10); if (!isNaN(n)) return n; }
      const reset = res.headers.get("x-ratelimit-reset");
      if (reset) { const n = parseInt(reset, 10); if (!isNaN(n)) return n; }
    } catch (e) {
      /* headers not readable */
    }
    return 0;
  }

  // --- Infinite scroll (RES "never-ending reddit") ---------------------
  let infiniteOn = false;
  let infState = null; // { fetchPage, after, count, loading, sentinel, observer, attempt, retryTimer, retryInterval }

  function setInfMsg(st, text, isError) {
    if (!st || !st.sentinel) return;
    const m = st.sentinel.querySelector(".orr-loading");
    if (m) {
      m.textContent = text;
      m.classList.toggle("orr-error", !!isError);
    }
  }

  function teardownInfinite() {
    if (infState) {
      if (infState.observer) infState.observer.disconnect();
      if (infState.retryTimer) clearTimeout(infState.retryTimer);
      if (infState.retryInterval) clearInterval(infState.retryInterval);
      if (infState.sentinel && infState.sentinel.remove) infState.sentinel.remove();
    }
    infState = null;
  }

  // fetchPage(after, count) -> Promise<{ itemsHtml, after, addedCount }>
  function setupInfinite(fetchPage, after, count) {
    if (!infiniteOn || !after) return;
    const st = document.getElementById("siteTable");
    if (!st || !st.parentNode) return;
    const nb = document.querySelector(".nav-buttons"); // manual pager gives way to auto-load
    if (nb) nb.style.display = "none";
    const sentinel = document.createElement("div");
    sentinel.className = "orr-inf-sentinel";
    sentinel.innerHTML = '<span class="orr-loading">loading more…</span>';
    st.parentNode.insertBefore(sentinel, st.nextSibling);
    infState = { fetchPage, after, count: count || 0, loading: false, sentinel, observer: null, attempt: 0, retryTimer: null, retryInterval: null };
    if (typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMoreInfinite();
      },
      { rootMargin: "800px" }
    );
    obs.observe(sentinel);
    infState.observer = obs;
    scheduleFill(infState); // in case the first page didn't fill the viewport
  }

  function loadMoreInfinite() {
    const st = infState;
    if (!st || st.loading || st.retryTimer || !st.after) return;
    attemptInfinite(st);
  }

  async function attemptInfinite(st) {
    if (infState !== st || !st.after) return;
    st.loading = true;
    setInfMsg(st, "loading more…", false);
    let res = null, status = null, retryAfter = 0;
    try {
      res = await st.fetchPage(st.after, st.count);
    } catch (e) {
      status = e && e.status != null ? e.status : 0;
      retryAfter = (e && e.retryAfter) || 0;
    }
    if (infState !== st) return; // navigated away
    if (res) {
      const table = document.getElementById("siteTable");
      if (table && res.itemsHtml) {
        table.insertAdjacentHTML("beforeend", res.itemsHtml);
        enhanceNewItems(table);
      }
      st.count += res.addedCount || 0;
      st.after = res.after || null;
      st.attempt = 0;
      st.loading = false;
      if (!st.after) {
        teardownInfinite(); // no more pages → remove the sentinel
        return;
      }
      setInfMsg(st, "loading more…", false);
      scheduleFill(st); // keep filling if the sentinel is still on screen
      return;
    }
    // error → retry with backoff on transient failures
    st.loading = false;
    if (isTransient(status)) {
      st.attempt = (st.attempt || 0) + 1;
      if (st.attempt > MAX_RETRY) {
        setInfMsg(st, "⚠ Reddit keeps rate-limiting — scroll up then back down to retry.", true);
        st.attempt = 0;
        return;
      }
      const ms = backoffMs(st.attempt, retryAfter);
      let remain = Math.ceil(ms / 1000);
      const tick = () => setInfMsg(st, "rate-limited — retrying in " + remain + "s… (try " + st.attempt + "/" + MAX_RETRY + ")", true);
      tick();
      st.retryInterval = setInterval(() => { remain -= 1; if (remain <= 0) clearInterval(st.retryInterval); else tick(); }, 1000);
      st.retryTimer = setTimeout(() => {
        if (st.retryInterval) clearInterval(st.retryInterval);
        st.retryTimer = null;
        attemptInfinite(st);
      }, ms);
    } else {
      setInfMsg(st, "⚠ couldn't load more (error " + status + ")", true);
    }
  }

  // If the sentinel is still near the viewport (short page), auto-load the next
  // page after a small gap so the feed fills — but never in a tight burst.
  function scheduleFill(st) {
    if (!st || !st.sentinel) return;
    setTimeout(() => {
      if (infState !== st || st.loading || st.retryTimer || !st.after) return;
      let r;
      try { r = st.sentinel.getBoundingClientRect(); } catch (e) { return; }
      if (r.top < (window.innerHeight || 800) + 200) attemptInfinite(st);
    }, MIN_GAP);
  }

  // ==================== RES-style enhancements ==========================

  let nightModeOn = true;
  let dataCache = { filters: { subreddits: [], users: [], domains: [], keywords: [], flairs: [] }, userTags: {}, threadVisits: {} };
  const enhanceCache = new Map();

  const ENHANCE_CSS = `
.thing.comment.collapsed > .child, .thing.comment.collapsed > .entry .usertext-body,
.thing.comment.collapsed > .entry .flat-list.buttons { display:none !important; }
.thing.comment.collapsed > .entry .tagline { opacity:.75; }
a.expand { color:#888; text-decoration:none; font-family:monospace; cursor:pointer; margin-right:2px; }
.thing.orr-kb-sel > .entry { outline:2px solid #ff4500; outline-offset:1px; }
.thing.orr-filtered { display:none !important; }
/* Old-reddit's archived sprite dropped the image expando icon, so image/gallery
   posts rendered an invisible (icon-less) expando box. Restore a visible icon. */
.expando-button.image { background-repeat:no-repeat; background-position:center center; }
.expando-button.image.collapsed { background-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'23'%20height%3D'23'%3E%3Crect%20x%3D'3'%20y%3D'5'%20width%3D'17'%20height%3D'13'%20rx%3D'2'%20fill%3D'rgb(240%2C245%2C250)'%20stroke%3D'rgb(95%2C153%2C207)'%20stroke-width%3D'1.5'%2F%3E%3Ccircle%20cx%3D'8'%20cy%3D'9'%20r%3D'1.7'%20fill%3D'rgb(95%2C153%2C207)'%2F%3E%3Cpath%20d%3D'M4.5%2017%20L10%2010.5%20L13.5%2014%20L16%2011%20L18.5%2017%20Z'%20fill%3D'rgb(95%2C153%2C207)'%2F%3E%3C%2Fsvg%3E"); }
.expando-button.image.expanded { background-image:url("data:image/svg+xml,%3Csvg%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%20width%3D'23'%20height%3D'23'%3E%3Crect%20x%3D'3'%20y%3D'5'%20width%3D'17'%20height%3D'13'%20rx%3D'2'%20fill%3D'rgb(95%2C153%2C207)'%20stroke%3D'rgb(60%2C110%2C160)'%20stroke-width%3D'1.5'%2F%3E%3Ccircle%20cx%3D'8'%20cy%3D'9'%20r%3D'1.7'%20fill%3D'white'%2F%3E%3Cpath%20d%3D'M4.5%2017%20L10%2010.5%20L13.5%2014%20L16%2011%20L18.5%2017%20Z'%20fill%3D'white'%2F%3E%3C%2Fsvg%3E"); }
#orr-top { position:fixed; right:16px; bottom:16px; z-index:2147483000; background:#5f99cf; color:#fff;
  border:1px solid #336699; border-radius:3px; padding:6px 10px; font:12px verdana; cursor:pointer; display:none; }
#orr-top.show { display:block; }
.orr-usertag { display:inline-block; padding:0 4px; margin:0 2px; border-radius:3px; font-size:10px; color:#fff; vertical-align:middle; }
#orr-hovercard { position:fixed; z-index:2147483000; max-width:320px; background:#fff; color:#000; border:1px solid #5f99cf;
  border-radius:3px; padding:8px; font:11px verdana; box-shadow:0 2px 10px rgba(0,0,0,.35); line-height:1.5; }
#orr-hovercard .orr-tagbtn { color:#369; cursor:pointer; text-decoration:underline; }
.thing.comment.orr-new > .entry > .tagline:after { content:" \\2022 new"; color:#ff4500; font-weight:bold; }
.orr-gimg { display:none; max-width:100%; height:auto; }
.orr-gimg.active { display:block; }
.orr-gnav-bar { margin:4px 0; font-size:12px; }
a.orr-gnav { color:#369; text-decoration:none; margin:0 6px; cursor:pointer; }
.orr-inline-img { margin:4px 0; display:inline-block; overflow:hidden; resize:both; max-width:100%; line-height:0; border:1px solid #ccc; }
.orr-inline-img img { width:100%; height:100%; object-fit:contain; display:block; }
/* embeds + direct video */
.orr-embed { width:640px; max-width:100%; height:360px; border:0; display:block; background:#000; }
.orr-directvideo { max-width:100%; height:auto; display:block; background:#000; }
/* drag-resizable images (RES-style); double-click to reset */
.orr-resizable { display:inline-block; overflow:hidden; resize:both; max-width:100%; line-height:0; }
.orr-resizable img.preview { width:100%; height:100%; object-fit:contain; display:block; max-width:none; max-height:none; }
/* NSFW / spoiler blur with click-to-reveal */
.expando.orr-nsfw, .expando.orr-spoiler { position:relative; }
.expando.orr-nsfw:not(.orr-revealed) .expando-container,
.expando.orr-spoiler:not(.orr-revealed) .expando-container { filter:blur(24px); pointer-events:none; }
.expando.orr-nsfw:not(.orr-revealed)::after { content:"NSFW \\2014 click to reveal"; }
.expando.orr-spoiler:not(.orr-revealed)::after { content:"spoiler \\2014 click to reveal"; }
.expando.orr-nsfw:not(.orr-revealed)::after, .expando.orr-spoiler:not(.orr-revealed)::after {
  position:absolute; top:8px; left:8px; z-index:3; background:rgba(0,0,0,.75); color:#fff;
  padding:3px 9px; border-radius:3px; font:bold 12px verdana; cursor:pointer; }
.orr-inf-sentinel { text-align:center; padding:10px; }
.orr-loading { color:#888; font-style:italic; font-size:13px; }
.orr-loading.orr-error { color:#c00; font-style:normal; font-weight:bold; }
a.orr-more { color:#369; }
.morecomments a.orr-more[data-orr-loading="1"] { color:#888; font-style:italic; }
#sr-header-area .sr-list { padding-left:8px; }
/* comment tools */
.author.submitter { color:#fff !important; background:#0079d3; padding:0 3px; border-radius:2px; text-decoration:none; }
a.orr-parent { color:#369; }
.orr-inline-media { margin:6px 0; }
.orr-flash { animation: orr-flash 1.3s ease-out; }
@keyframes orr-flash { from { background:#ffe9a8; } to { background:transparent; } }
#orr-cnav { position:fixed; right:12px; top:130px; z-index:2147483000; display:flex; flex-direction:column; gap:3px; }
#orr-cnav button { width:36px; height:26px; font:11px verdana; cursor:pointer; color:#369;
  background:#f6f7f8; border:1px solid #c7c7c7; border-radius:3px; padding:0; }
#orr-cnav button:hover { background:#e9f0f7; }
/* visited posts (persisted) */
.thing.orr-visited .title a:not(:hover) { color:#9b9b9b; }
/* keyboard-shortcuts help */
#orr-help-btn { position:fixed; left:12px; bottom:12px; z-index:2147483000; width:26px; height:26px;
  border-radius:50%; border:1px solid #336699; background:#5f99cf; color:#fff; cursor:pointer; font:bold 14px verdana; padding:0; }
#orr-help { position:fixed; inset:0; z-index:2147483600; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; }
#orr-help .orr-help-box { background:#fff; color:#111; border-radius:6px; padding:18px 22px; min-width:330px; box-shadow:0 6px 30px rgba(0,0,0,.4); font:13px verdana; }
#orr-help h2 { margin:0 0 12px; font-size:16px; }
#orr-help table { border-collapse:collapse; }
#orr-help td { padding:3px 12px 3px 0; }
#orr-help td.k { font-family:monospace; color:#369; white-space:nowrap; font-weight:bold; }
#orr-help .orr-help-close { margin:14px 0 0; color:#888; font-size:11px; }
/* loading skeleton */
#orr-skeleton { position:fixed; inset:0; background:#fff; z-index:2147483500; overflow:hidden; padding:0; }
#orr-skeleton .orr-sk-head { height:38px; background:#cee3f8; border-bottom:1px solid #5f99cf; }
#orr-skeleton .orr-sk-body { padding:14px 18px; max-width:800px; }
#orr-skeleton .orr-sk-row { display:flex; gap:10px; margin:0 0 16px; }
#orr-skeleton .orr-sk-thumb { width:70px; height:50px; border-radius:3px; background:#e6e6e6; flex:0 0 auto; }
#orr-skeleton .orr-sk-lines { flex:1; }
#orr-skeleton .orr-sk-line { height:12px; margin:4px 0; border-radius:3px; background:linear-gradient(90deg,#ededed 25%,#f6f6f6 50%,#ededed 75%); background-size:400% 100%; animation:orr-sk-shim 1.3s infinite; }
#orr-skeleton .orr-sk-line.w70 { width:70%; } #orr-skeleton .orr-sk-line.w40 { width:40%; }
@keyframes orr-sk-shim { from { background-position:100% 0; } to { background-position:0 0; } }`;

  const NIGHT_CSS = `
html.orr-night, html.orr-night body, html.orr-night .content, html.orr-night #siteTable,
html.orr-night .commentarea, html.orr-night shreddit-app { background:#1a1a1b !important; color:#d7dadc !important; }
html.orr-night a, html.orr-night a * { color:#6cb0ff !important; }
html.orr-night a:visited, html.orr-night a:visited * { color:#b39ddb !important; }
html.orr-night .thing, html.orr-night .thing.comment { background:transparent !important; }
html.orr-night .thing { border-color:#343536 !important; }
html.orr-night .tagline, html.orr-night .domain, html.orr-night .score, html.orr-night .rank { color:#818384 !important; }
html.orr-night .md, html.orr-night .usertext-body, html.orr-night .md * { background:transparent !important; color:#d7dadc !important; }
html.orr-night .side .spacer > *, html.orr-night .titlebox, html.orr-night .sidecontentbox {
  background:#242526 !important; border-color:#343536 !important; color:#d7dadc !important; }
html.orr-night #search input[type=text] { background:#111 !important; color:#d7dadc !important; border-color:#474748 !important; }
html.orr-night #header { background:#20303f !important; border-color:#14202b !important; }
html.orr-night .tabmenu li a, html.orr-night #header-bottom-right, html.orr-night #header-bottom-right a { color:#d7dadc !important; }
html.orr-night #header-bottom-right { background:#2a2f31 !important; }
html.orr-night .thing.comment .child { border-color:#343536 !important; }
html.orr-night #orr-hovercard { background:#242526 !important; color:#d7dadc !important; }
html.orr-night .menuarea { background:transparent !important; color:#d7dadc !important; }
html.orr-night .orr-inline-img img { border-color:#343536 !important; }
html.orr-night .side, html.orr-night .side * { background-color:transparent !important; }
html.orr-night .side .sidecontentbox, html.orr-night .side .titlebox { border-color:#343536 !important; }
html.orr-night .tabmenu li a { background-color:#223244 !important; border-color:#14202b !important; color:#cfe0f0 !important; }
html.orr-night .tabmenu li.selected a { background-color:#1a1a1b !important; color:#ff7043 !important; }
html.orr-night #search input[type=submit] { filter:invert(0.85); }
html.orr-night #orr-cnav button { background:#242526 !important; border-color:#343536 !important; color:#6cb0ff !important; }
html.orr-night #orr-cnav button:hover { background:#2f3132 !important; }
html.orr-night .author.submitter { background:#1667b8 !important; color:#fff !important; }
html.orr-night .orr-flash { animation:orr-flash-n 1.3s ease-out; }
@keyframes orr-flash-n { from { background:#4a441f; } to { background:transparent; } }
html.orr-night #orr-help .orr-help-box { background:#242526 !important; color:#d7dadc !important; }
html.orr-night #orr-help td.k { color:#6cb0ff !important; }
html.orr-night .thing.orr-visited .title a:not(:hover) { color:#6a6a6b !important; }
html.orr-night #orr-skeleton { background:#1a1a1b; }
html.orr-night #orr-skeleton .orr-sk-head { background:#20303f; border-color:#14202b; }
html.orr-night #orr-skeleton .orr-sk-thumb { background:#2f3132; }
html.orr-night #orr-skeleton .orr-sk-line { background:linear-gradient(90deg,#2a2b2c 25%,#343536 50%,#2a2b2c 75%); background-size:400% 100%; }`;

  function injectStaticCss() {
    if (!document.getElementById("orr-enhance-css")) {
      const s = document.createElement("style");
      s.id = "orr-enhance-css";
      s.textContent = ENHANCE_CSS + "\n" + NIGHT_CSS;
      (document.head || document.documentElement).appendChild(s);
    }
  }
  function applyNight() {
    document.documentElement.classList.toggle("orr-night", !!nightModeOn);
  }

  function ensureUiChrome() {
    if (!document.body) return;
    if (!document.getElementById("orr-top")) {
      const b = document.createElement("div");
      b.id = "orr-top";
      b.textContent = "↑ top";
      b.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
      document.body.appendChild(b);
    }
    if (!document.getElementById("orr-hovercard")) {
      const c = document.createElement("div");
      c.id = "orr-hovercard";
      c.style.display = "none";
      document.body.appendChild(c);
    }
    if (!document.getElementById("orr-help-btn")) {
      const h = document.createElement("button");
      h.id = "orr-help-btn";
      h.type = "button";
      h.textContent = "?";
      h.title = "keyboard shortcuts (press ?)";
      h.setAttribute("aria-label", "keyboard shortcuts");
      h.addEventListener("click", toggleHelp);
      document.body.appendChild(h);
    }
  }

  // ---- keyboard navigation ----
  let kbIdx = -1;
  function kbThings() {
    const inComments = !!document.querySelector(".commentarea");
    const sel = inComments ? ".nestedlisting > .thing.comment" : "#siteTable > .thing.link:not(.orr-filtered)";
    return Array.from(document.querySelectorAll(sel));
  }
  function kbSelect(i) {
    const things = kbThings();
    if (!things.length) return;
    kbIdx = Math.max(0, Math.min(i, things.length - 1));
    things.forEach((t) => t.classList.remove("orr-kb-sel"));
    const el = things[kbIdx];
    el.classList.add("orr-kb-sel");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    try { el.focus({ preventScroll: true }); } catch (e) { /* older browsers */ }
  }
  function kbCurrent() {
    const things = kbThings();
    return kbIdx >= 0 ? things[kbIdx] : null;
  }
  function handleKeydown(e) {
    if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    switch (e.key) {
      case "j": kbSelect(kbIdx + 1); e.preventDefault(); break;
      case "k": kbSelect(kbIdx - 1); e.preventDefault(); break;
      case "o":
      case "Enter": {
        const c = kbCurrent();
        const a = c && c.querySelector(".title a, a.bylink");
        if (a) a.click();
        break;
      }
      case "x": {
        const c = kbCurrent();
        const btn = c && c.querySelector(".expando-button");
        if (btn) btn.click();
        else if (c && c.classList.contains("comment")) {
          const ex = c.querySelector(":scope > .entry .expand");
          if (ex) ex.click();
        }
        break;
      }
      case "c": {
        const c = kbCurrent();
        const a = c && c.querySelector("a.comments, a.bylink.comments");
        if (a) a.click();
        break;
      }
      case "ArrowLeft": if (hoverGallery) { navGallery(hoverGallery, -1); e.preventDefault(); } else return; break;
      case "ArrowRight": if (hoverGallery) { navGallery(hoverGallery, 1); e.preventDefault(); } else return; break;
      case "?": toggleHelp(); e.preventDefault(); break;
      case "Escape":
        if (document.getElementById("orr-help")) { closeHelp(); e.preventDefault(); }
        else hideHoverCard();
        return;
      default: return;
    }
  }

  // ---- collapse comments ----
  function toggleCollapse(expandLink) {
    const thing = expandLink.closest(".thing.comment");
    if (!thing) return;
    const collapsed = thing.classList.toggle("collapsed");
    expandLink.innerHTML = collapsed ? "[+]" : "[&ndash;]";
    persistCollapse(thing, collapsed);
  }

  // ---- gallery nav ----
  let hoverGallery = null; // gallery under the pointer, for arrow-key navigation
  function navGallery(gal, dir) {
    if (!gal) return;
    const imgs = Array.from(gal.querySelectorAll(".orr-gimg"));
    const n = imgs.length;
    if (!n) return;
    let idx = parseInt(gal.getAttribute("data-idx") || "0", 10);
    idx = (idx + dir + n) % n;
    gal.setAttribute("data-idx", String(idx));
    imgs.forEach((im, i) => im.classList.toggle("active", i === idx));
    const cnt = gal.querySelector(".orr-gcount");
    if (cnt) cnt.textContent = idx + 1 + " / " + n;
  }
  function galleryNav(navEl) {
    navGallery(navEl.closest(".orr-gallery"), parseInt(navEl.getAttribute("data-d") || "1", 10));
  }

  // ---- user tags ----
  const TAG_COLORS = ["#ff4500", "#0079d3", "#46a758", "#a333c8", "#c69026", "#008985"];
  function tagColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return TAG_COLORS[h % TAG_COLORS.length];
  }
  function patchTags(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll("a.author").forEach((a) => {
      if (a.dataset.orrTagged) return;
      const m = /\/user\/([^/?#]+)/.exec(a.getAttribute("href") || "");
      if (!m) return;
      a.dataset.orrTagged = "1";
      const t = dataCache.userTags[m[1].toLowerCase()];
      if (t) {
        const span = document.createElement("span");
        span.className = "orr-usertag";
        span.style.background = t.color || "#888";
        span.textContent = t.text;
        a.insertAdjacentElement("afterend", span);
      }
    });
  }
  function promptTag(username) {
    const key = username.toLowerCase();
    const cur = dataCache.userTags[key];
    const text = window.prompt("Tag for u/" + username + " (blank to remove):", cur ? cur.text : "");
    if (text === null) return;
    if (!text.trim()) delete dataCache.userTags[key];
    else dataCache.userTags[key] = { text: text.trim(), color: cur ? cur.color : tagColor(key) };
    ORR.setPrefs({ userTags: dataCache.userTags });
    // repaint: clear markers so patchTags re-runs
    document.querySelectorAll("a.author[data-orr-tagged]").forEach((a) => delete a.dataset.orrTagged);
    document.querySelectorAll(".orr-usertag").forEach((s) => s.remove());
    patchTags(document);
    hideHoverCard();
  }

  // ---- filters ----
  function applyFilters(scope) {
    const f = dataCache.filters || {};
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll("#siteTable .thing.link").forEach((p) => {
      const sub = (p.getAttribute("data-subreddit") || "").toLowerCase();
      const author = (p.getAttribute("data-author") || "").toLowerCase();
      const domain = (p.getAttribute("data-domain") || "").toLowerCase();
      const titleEl = p.querySelector(".title a");
      const title = (titleEl ? titleEl.textContent : "").toLowerCase();
      const hide =
        (f.subreddits || []).some((s) => s && s.toLowerCase() === sub) ||
        (f.users || []).some((u) => u && u.toLowerCase() === author) ||
        (f.domains || []).some((d) => d && domain.indexOf(d.toLowerCase()) >= 0) ||
        (f.keywords || []).some((k) => k && title.indexOf(k.toLowerCase()) >= 0);
      p.classList.toggle("orr-filtered", hide);
    });
  }

  // ---- new comments since last visit ----
  function markNewComments() {
    const area = document.querySelector(".commentarea");
    if (!area) return;
    const post = document.querySelector("#siteTable .thing.link");
    const t3 = post ? post.getAttribute("data-fullname") : null;
    if (!t3) return;
    const last = dataCache.threadVisits[t3] || 0;
    if (last) {
      document.querySelectorAll(".thing.comment").forEach((c) => {
        const created = parseInt(c.getAttribute("data-created") || "0", 10);
        if (created > last) c.classList.add("orr-new");
      });
    }
    dataCache.threadVisits[t3] = Math.floor((typeof Date.now === "function" ? Date.now() : 0) / 1000);
    // cap growth
    const keys = Object.keys(dataCache.threadVisits);
    if (keys.length > 800) delete dataCache.threadVisits[keys[0]];
    ORR.setPrefs({ threadVisits: dataCache.threadVisits });
  }

  // ---- persist visited posts + collapsed comments ----
  function postKey() {
    const post = document.querySelector("#siteTable .thing.link");
    return post ? post.getAttribute("data-fullname") : null;
  }
  function rememberVisit() {
    const k = postKey();
    if (!k) return;
    if (!dataCache.visitedPosts) dataCache.visitedPosts = {};
    if (!dataCache.visitedPosts[k]) {
      dataCache.visitedPosts[k] = Math.floor(nowMsNow() / 1000);
      const keys = Object.keys(dataCache.visitedPosts);
      if (keys.length > 3000) delete dataCache.visitedPosts[keys[0]];
      ORR.setPrefs({ visitedPosts: dataCache.visitedPosts });
    }
  }
  function markVisited(scope) {
    const set = dataCache.visitedPosts || {};
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll("#siteTable .thing.link").forEach((p) => {
      if (set[p.getAttribute("data-fullname")]) p.classList.add("orr-visited");
    });
  }
  function persistCollapse(thing, collapsed) {
    const k = postKey();
    const id = thing.getAttribute("data-fullname");
    if (!k || !id) return;
    if (!dataCache.collapsedComments) dataCache.collapsedComments = {};
    let arr = dataCache.collapsedComments[k] || [];
    if (collapsed) { if (arr.indexOf(id) < 0) arr = arr.concat(id); }
    else arr = arr.filter((x) => x !== id);
    if (arr.length) dataCache.collapsedComments[k] = arr;
    else delete dataCache.collapsedComments[k];
    const keys = Object.keys(dataCache.collapsedComments);
    if (keys.length > 400) delete dataCache.collapsedComments[keys[0]];
    ORR.setPrefs({ collapsedComments: dataCache.collapsedComments });
  }
  function applyCollapsedState() {
    const k = postKey();
    if (!k || !dataCache.collapsedComments) return;
    const arr = dataCache.collapsedComments[k];
    if (!arr || !arr.length) return;
    arr.forEach((id) => {
      const thing = document.getElementById("thing_" + id);
      if (thing && thing.classList.contains("comment") && !thing.classList.contains("collapsed")) {
        thing.classList.add("collapsed");
        const ex = thing.querySelector(":scope > .entry .expand");
        if (ex) ex.innerHTML = "[+]";
      }
    });
  }

  // ---- reddit preview images whose signed URL expired → refetch a fresh one ----
  let previewJsonPromise = null; // shared across images so we fetch the page JSON once
  function refreshPreviewUrl(img) {
    if (img.dataset.orrRefetched) return;
    img.dataset.orrRefetched = "1";
    let path;
    try { path = new URL(img.getAttribute("src") || img.src, location.origin).pathname; } catch (e) { return; }
    if (!previewJsonPromise) {
      const jsonUrl = location.origin + location.pathname.replace(/\/$/, "") + "/.json?raw_json=1";
      previewJsonPromise = fetch(jsonUrl, { credentials: "include", headers: { Accept: "application/json" } })
        .then((res) => (res.ok ? res.text() : ""))
        .catch(() => "");
      setTimeout(() => { previewJsonPromise = null; }, 30000); // allow a fresh fetch later
    }
    previewJsonPromise.then((text) => {
      if (!text) return;
      const fresh = (text.match(/https?:\/\/(?:external-)?preview\.redd\.it\/[^"\s\\]+/g) || [])
        .map((u) => u.replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&"))
        .find((u) => { try { return new URL(u).pathname === path; } catch (e) { return false; } });
      if (fresh && img.isConnected) img.src = fresh;
    });
  }

  // ---- keyboard-shortcuts help overlay ----
  const SHORTCUTS = [
    ["j / k", "next / previous item"],
    ["o / Enter", "open selected item"],
    ["c", "open comments (on a listing)"],
    ["x", "expand media / collapse comment"],
    ["← / →", "gallery previous / next (while hovering a gallery)"],
    ["comment nav", "▲▼ top comments, OP, new (widget, top-right)"],
    ["?", "toggle this help"],
    ["Esc", "close popups"],
  ];
  let helpPrevFocus = null;
  function toggleHelp() {
    if (document.getElementById("orr-help")) { closeHelp(); return; }
    const ov = document.createElement("div");
    ov.id = "orr-help";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "keyboard shortcuts");
    ov.tabIndex = -1;
    ov.innerHTML =
      '<div class="orr-help-box"><h2>Keyboard shortcuts</h2><table>' +
      SHORTCUTS.map((s) => '<tr><td class="k">' + esc(s[0]) + "</td><td>" + esc(s[1]) + "</td></tr>").join("") +
      '</table><p class="orr-help-close">press <b>?</b> or <b>Esc</b> to close</p></div>';
    ov.addEventListener("click", (e) => { if (e.target === ov) closeHelp(); });
    document.body.appendChild(ov);
    helpPrevFocus = document.activeElement;
    ov.focus();
  }
  function closeHelp() {
    const ov = document.getElementById("orr-help");
    if (ov) ov.remove();
    if (helpPrevFocus && helpPrevFocus.focus) { try { helpPrevFocus.focus(); } catch (e) {} }
    helpPrevFocus = null;
  }

  // ---- hover cards ----
  let hoverTimer = null;
  function hideHoverCard() {
    const c = document.getElementById("orr-hovercard");
    if (c) c.style.display = "none";
  }
  function positionCard(card, anchor) {
    const r = anchor.getBoundingClientRect();
    card.style.left = Math.min(r.left, window.innerWidth - 340) + "px";
    card.style.top = Math.min(r.bottom + 4, window.innerHeight - 120) + "px";
  }
  // Preview a nested comment's parent inline (RES "show parent on hover").
  function showParentCard(pl) {
    const card = document.getElementById("orr-hovercard");
    if (!card) return;
    const c = pl.closest(".thing.comment");
    const p = c && parentOf(c);
    if (!p) return;
    const body = p.querySelector(":scope > .entry .usertext-body");
    const author = p.querySelector(":scope > .entry a.author");
    card.innerHTML =
      '<div style="font-weight:bold;margin-bottom:4px">' + (author ? esc(author.textContent) : "parent comment") + "</div>" +
      '<div class="orr-parentbody" style="max-height:200px;overflow:auto">' + (body ? body.innerHTML : "(parent)") + "</div>";
    card.style.display = "block";
    positionCard(card, pl);
  }
  async function showHoverCard(anchor) {
    const href = anchor.getAttribute("href") || "";
    const card = document.getElementById("orr-hovercard");
    if (!card) return;
    const um = /^\/user\/([^/?#]+)\/?$/.exec(href);
    const sm = /^\/r\/([^/?#+]+)\/?$/.exec(href);
    if (!um && !sm) return;
    const url = um
      ? location.origin + "/user/" + um[1] + "/about.json?raw_json=1"
      : location.origin + "/r/" + sm[1] + "/about.json?raw_json=1";
    const j = await fetchJsonCached(url);
    if (!j || !j.data) return;
    const d = j.data;
    let html;
    if (um) {
      const name = d.name || um[1];
      const cake = d.created_utc ? new Date(d.created_utc * 1000).toISOString().slice(0, 10) : "?";
      html =
        `<b>u/${esc(name)}</b><br>${formatNumber(d.link_karma)} post &middot; ${formatNumber(d.comment_karma)} comment karma` +
        `<br>cake day ${esc(cake)}<br><span class="orr-tagbtn" data-tag-user="${esc(name)}">tag user</span>`;
    } else {
      html =
        `<b>r/${esc(d.display_name || sm[1])}</b><br>${formatNumber(d.subscribers)} subscribers` +
        (d.public_description ? `<br>${esc(d.public_description).slice(0, 240)}` : "");
    }
    card.innerHTML = html;
    positionCard(card, anchor);
    card.style.display = "block";
  }
  function fetchJsonCached(url) {
    if (enhanceCache.has(url)) return enhanceCache.get(url);
    const p = fetch(url, { credentials: "include", headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    enhanceCache.set(url, p);
    return p;
  }

  function wireEnhancements() {
    document.addEventListener("keydown", handleKeydown, true);
    window.addEventListener("scroll", () => {
      const b = document.getElementById("orr-top");
      if (b) b.classList.toggle("show", window.scrollY > 500);
    });
    // Track the gallery under the pointer so arrow keys can page through it.
    document.addEventListener("mouseover", (e) => {
      hoverGallery = (e.target.closest && e.target.closest(".orr-gallery")) || null;
    }, true);
    // Double-click a resized image to reset it to its natural size.
    document.addEventListener("dblclick", (e) => {
      const r = e.target.closest && e.target.closest(".orr-resizable, .orr-inline-img");
      if (r) { r.style.width = ""; r.style.height = ""; }
    });
    // Refetch reddit preview images whose signed URL has expired (403).
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (img && img.tagName === "IMG" && /(?:external-)?preview\.redd\.it/i.test(img.src || "")) refreshPreviewUrl(img);
    }, true);
    document.addEventListener(
      "mouseover",
      (e) => {
        const pl = e.target.closest && e.target.closest("a.orr-parent");
        if (pl) { if (hoverTimer) clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showParentCard(pl), 300); return; }
        const a = e.target.closest && e.target.closest("a.author, .sr-bar a.choice, a.subreddit");
        if (!a) {
          if (!(e.target.closest && e.target.closest("#orr-hovercard"))) {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
          }
          return;
        }
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => showHoverCard(a), 350);
      },
      true
    );
    document.addEventListener("mouseout", (e) => {
      const to = e.relatedTarget;
      if (to && to.closest && (to.closest("#orr-hovercard") || to.closest("a.author, .sr-bar a.choice, a.subreddit, a.orr-parent"))) return;
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      setTimeout(() => {
        const c = document.getElementById("orr-hovercard");
        if (c && !c.matches(":hover")) hideHoverCard();
      }, 250);
    });
  }

  // Per-render pass: chrome, night, filters, tags, new-comments; reset keyboard.
  // Render image links inside comment/post bodies as inline <img> (RES-style).
  function inlineImages(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    let links;
    try {
      links = root.querySelectorAll(".md a[href], .usertext-body a[href]");
    } catch (e) {
      return;
    }
    for (const a of links) {
      if (a.dataset.orrImg) continue;
      const href = a.getAttribute("href") || "";
      if (!isImageUrl(href)) continue;
      a.dataset.orrImg = "1";
      const wrap = document.createElement("div");
      wrap.className = "orr-inline-img";
      const img = document.createElement("img");
      img.setAttribute("loading", "lazy");
      img.src = href;
      wrap.appendChild(img);
      a.insertAdjacentElement("afterend", wrap);
    }
  }

  // Read the exact audio-track URL out of a Reddit DASH manifest. Works across
  // Reddit's container schemes (CMAF today, DASH historically) because it just
  // picks the highest-bitrate BaseURL whose name contains "audio". Returns null
  // if the manifest can't be read or has no audio track.
  async function audioUrlFromManifest(dashUrl) {
    if (!dashUrl) return null;
    try {
      let signal;
      if (typeof AbortController === "function") {
        const ac = new AbortController();
        signal = ac.signal;
        setTimeout(() => ac.abort(), 4000); // don't hang first play on a slow/blocked manifest
      }
      const res = await fetch(dashUrl, { credentials: "omit", signal });
      if (!res.ok) return null;
      const xml = await res.text();
      const urls = [];
      const re = /<BaseURL>([^<]+)<\/BaseURL>/gi;
      let m;
      while ((m = re.exec(xml))) if (/audio/i.test(m[1])) urls.push(m[1]);
      if (!urls.length) return null;
      urls.sort((a, b) => parseInt((b.match(/(\d+)/) || [])[1] || "0", 10) - parseInt((a.match(/(\d+)/) || [])[1] || "0", 10));
      const f = urls[0];
      if (/^https?:/i.test(f)) return f;
      return dashUrl.replace(/\/DASHPlaylist\.mpd.*$/i, "") + "/" + f.replace(/^\//, "");
    } catch (e) {
      return null;
    }
  }

  // Give a Reddit video its sound back. The <video> plays the video-only stream;
  // we play a hidden <audio> (the separate v.redd.it audio track) locked to it, so
  // the native volume/mute controls work. The audio URL is resolved lazily on first
  // play from the DASH manifest (authoritative), falling back to guessed candidate
  // URLs. A truly silent clip (no audio track anywhere) just falls back to no audio.
  function wireRedditVideo(video) {
    if (!video || video.dataset.orrAudioWired) return;
    const cands = (video.getAttribute("data-audio-candidates") || "").split("|").filter(Boolean);
    const dashUrl = video.getAttribute("data-dash-url") || "";
    if (!cands.length && !dashUrl) return;
    video.dataset.orrAudioWired = "1";
    const audio = document.createElement("audio");
    audio.preload = "none";
    audio.style.display = "none";
    (video.parentNode || video).appendChild(audio);

    let idx = -1, resolved = false, dead = false, srcSet = false, resolving = false;
    const resync = () => { if (dead) return; try { if (Math.abs(audio.currentTime - video.currentTime) > 0.3) audio.currentTime = video.currentTime; } catch (e) {} };
    const play = () => { if (dead) return; try { audio.currentTime = video.currentTime; } catch (e) {} audio.play().catch(() => {}); };

    // Choose the audio source: manifest first, then walk the candidate list.
    async function ensureSrc(advance) {
      if (dead) return;
      if (!srcSet) {
        if (resolving) return;
        resolving = true;
        const u = await audioUrlFromManifest(dashUrl);
        resolving = false;
        if (dead) return;
        if (u) { audio.src = u; srcSet = true; }
        else if (cands.length) { idx = 0; audio.src = cands[0]; srcSet = true; }
        else { dead = true; return; }
        if (!video.paused) play();
        return;
      }
      if (advance) {
        idx += 1;
        if (idx >= cands.length) { dead = true; return; } // out of candidates → silent
        audio.src = cands[idx];
        if (!video.paused) play();
      }
    }

    audio.addEventListener("playing", () => { resolved = true; resync(); });
    audio.addEventListener("error", () => {
      if (resolved || dead) return; // only fall through candidates while still probing
      ensureSrc(true);
    });

    video.addEventListener("play", () => { if (srcSet) play(); else ensureSrc(false); });
    video.addEventListener("playing", () => { if (srcSet) play(); });
    video.addEventListener("pause", () => audio.pause());
    video.addEventListener("waiting", () => audio.pause()); // buffering → hold audio
    video.addEventListener("seeking", resync);
    video.addEventListener("seeked", resync);
    video.addEventListener("timeupdate", resync);
    video.addEventListener("ratechange", () => { try { audio.playbackRate = video.playbackRate; } catch (e) {} });
    video.addEventListener("volumechange", () => { audio.volume = video.volume; audio.muted = video.muted; });
    // mirror the initial volume/mute state onto the audio track
    audio.volume = video.volume;
    audio.muted = video.muted;
  }

  function wireRedditVideos(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    let vids;
    try { vids = root.querySelectorAll("video.reddit-video[data-audio-candidates]"); } catch (e) { return; }
    vids.forEach(wireRedditVideo);
  }

  // ---- comment tools: OP highlight, parent links, navigator, media ----
  function nowMsNow() { return typeof Date.now === "function" ? Date.now() : 0; }

  function postAuthor() {
    const post = document.querySelector("#siteTable .thing.link");
    const a = post ? (post.getAttribute("data-author") || "").toLowerCase() : "";
    // A deleted OP/account is not a real author — don't match every [deleted] comment.
    return a === "[deleted]" || a === "[removed]" ? "" : a;
  }
  // Distinguish the submitter's (OP's) comments, like old reddit's .submitter.
  function markOP() {
    const op = postAuthor();
    if (!op) return;
    document.querySelectorAll(".thing.comment").forEach((c) => {
      if ((c.getAttribute("data-author") || "").toLowerCase() !== op) return;
      const a = c.querySelector(":scope > .entry .tagline a.author");
      if (a) a.classList.add("submitter");
    });
  }
  // The parent comment of a nested comment (null for top-level).
  function parentOf(commentThing) {
    const child = commentThing.parentElement; // .child of the parent comment
    return child ? child.closest(".thing.comment") : null;
  }
  // Add a "parent" button to nested comments (hover previews it, click jumps to it).
  function addParentLinks() {
    document.querySelectorAll(".commentarea .thing.comment").forEach((c) => {
      const buttons = c.querySelector(":scope > .entry .flat-list.buttons");
      if (!buttons || buttons.querySelector(".orr-parent")) return;
      if (!parentOf(c)) return; // top-level → no parent
      const li = document.createElement("li");
      li.innerHTML = '<a href="javascript:void(0)" class="orr-parent">parent</a>';
      buttons.appendChild(li);
    });
  }
  function flash(el) {
    el.classList.remove("orr-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("orr-flash");
  }

  // Comment navigator widget (top comments / OP / new), RES-style.
  function ensureCommentNav() {
    const onComments = !!document.querySelector(".commentarea");
    let nav = document.getElementById("orr-cnav");
    if (!onComments) { if (nav) nav.remove(); return; }
    if (nav) return;
    nav = document.createElement("div");
    nav.id = "orr-cnav";
    nav.setAttribute("role", "navigation");
    nav.setAttribute("aria-label", "comment navigator");
    nav.innerHTML =
      '<button type="button" data-nav="prev" title="previous top-level comment" aria-label="previous top-level comment">&#9650;</button>' +
      '<button type="button" data-nav="next" title="next top-level comment" aria-label="next top-level comment">&#9660;</button>' +
      '<button type="button" data-nav="op" title="next comment by OP" aria-label="next OP comment">OP</button>' +
      '<button type="button" data-nav="new" title="next new comment" aria-label="next new comment">new</button>';
    document.body.appendChild(nav);
    nav.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const mode = b.getAttribute("data-nav");
      if (mode === "prev") jumpComment(-1, topComments());
      else if (mode === "next") jumpComment(1, topComments());
      else if (mode === "op") jumpComment(1, opComments());
      else if (mode === "new") jumpComment(1, newComments());
    });
  }
  function topComments() { return Array.from(document.querySelectorAll(".nestedlisting > .thing.comment")); }
  function opComments() {
    const op = postAuthor();
    return op ? Array.from(document.querySelectorAll(".thing.comment")).filter((c) => (c.getAttribute("data-author") || "").toLowerCase() === op) : [];
  }
  function newComments() { return Array.from(document.querySelectorAll(".thing.comment.orr-new")); }
  function jumpComment(dir, els) {
    if (!els.length) return;
    let target = null;
    if (dir > 0) target = els.find((t) => t.getBoundingClientRect().top > 4);
    else { for (let i = els.length - 1; i >= 0; i--) { if (els[i].getBoundingClientRect().top < -4) { target = els[i]; break; } } }
    if (!target) target = dir > 0 ? els[0] : els[els.length - 1];
    if (target.classList.contains("collapsed")) { const ex = target.querySelector(":scope > .entry .expand"); if (ex) ex.click(); }
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    flash(target);
  }

  // Expand media links inside comment bodies (RES "show images" for comments):
  // youtube/redgifs/streamable/imgur/direct video via externalMediaExpando, and
  // v.redd.it links via the DASH manifest (with synced audio).
  function expandCommentMedia(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    let links;
    try { links = root.querySelectorAll(".commentarea .md a[href], .commentarea .usertext-body a[href]"); } catch (e) { return; }
    for (const a of links) {
      if (a.dataset.orrMedia) continue;
      const href = a.getAttribute("href") || "";
      const ext = externalMediaExpando(href);
      if (ext) {
        a.dataset.orrMedia = "1";
        const wrap = document.createElement("div");
        wrap.className = "orr-inline-media";
        wrap.innerHTML = ext.html;
        a.insertAdjacentElement("afterend", wrap);
        continue;
      }
      const vm = /^https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/i.exec(href);
      if (vm) { a.dataset.orrMedia = "1"; buildVredditInto(a, "https://v.redd.it/" + vm[1]); }
    }
  }
  async function buildVredditInto(anchor, base) {
    try {
      const res = await fetch(base + "/DASHPlaylist.mpd", { credentials: "omit" });
      if (!res.ok) return;
      const xml = await res.text();
      const all = [];
      const re = /<BaseURL>([^<]+)<\/BaseURL>/gi;
      let m;
      while ((m = re.exec(xml))) all.push(m[1]);
      const vids = all.filter((u) => !/audio/i.test(u));
      vids.sort((x, y) => (parseInt((y.match(/(\d+)/) || [])[1] || "0", 10)) - (parseInt((x.match(/(\d+)/) || [])[1] || "0", 10)));
      const vfile = vids[0];
      if (!vfile) return;
      const vurl = /^https?:/i.test(vfile) ? vfile : base + "/" + vfile;
      const wrap = document.createElement("div");
      wrap.className = "orr-inline-media";
      wrap.innerHTML =
        '<div class="expando-container"><video class="reddit-video" controls preload="metadata" data-dash-url="' +
        esc(base + "/DASHPlaylist.mpd") + '" data-audio-candidates="' + esc(audioCandidates(base).join("|")) +
        '" width="480"><source src="' + esc(vurl) + '"></video></div>';
      if (anchor.isConnected) { anchor.insertAdjacentElement("afterend", wrap); wireRedditVideos(wrap); }
    } catch (e) { /* leave the link as-is */ }
  }

  // Load a truncated "continue this thread" stub inline via the comment permalink.
  async function continueThread(el) {
    if (el.dataset.orrLoading) return;
    const parentId = el.getAttribute("data-parent"); // t1_xxx
    const linkId = el.getAttribute("data-link");
    const post = document.querySelector("#siteTable .thing.link");
    const permalink = post && post.getAttribute("data-permalink");
    if (!parentId || !permalink) { el.textContent = "(continue this thread — open the comment's permalink)"; return; }
    el.dataset.orrLoading = "1";
    el.textContent = "loading continued thread…";
    const cid = parentId.replace(/^t1_/, "");
    const url = location.origin + permalink.replace(/\/$/, "") + "/" + cid + "/.json?raw_json=1&limit=200";
    try {
      const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const comments = (data[1] && data[1].data && data[1].data.children) || [];
      const parent = comments[0] && comments[0].data;
      const kids = parent && parent.replies && parent.replies.data ? parent.replies.data.children : [];
      const wrap = el.parentElement; // .morecomments, sitting in the parent's .child
      if (!wrap || !wrap.parentNode || !kids.length) { el.textContent = "(nothing more to load)"; return; }
      const tmp = document.createElement("div");
      tmp.innerHTML = buildCommentTree(kids, linkId, nowMsNow());
      while (tmp.firstElementChild) wrap.parentNode.insertBefore(tmp.firstElementChild, wrap);
      wrap.remove();
      enhanceComments(document);
    } catch (e) {
      el.dataset.orrLoading = "";
      el.textContent = "continue this thread — failed, click to retry";
    }
  }

  function enhanceComments(scope) {
    if (!document.querySelector(".commentarea")) return;
    markOP();
    addParentLinks();
    ensureCommentNav();
    applyCollapsedState();
    expandCommentMedia(scope || document);
  }

  function afterRender() {
    injectStaticCss();
    applyNight();
    ensureUiChrome();
    kbIdx = -1;
    applyFilters(document);
    patchTags(document);
    markNewComments();
    markVisited(document);
    inlineImages(document);
    wireRedditVideos(document);
    enhanceComments(document);
    if (document.querySelector(".commentarea")) rememberVisit();
    observeMores();
  }
  function enhanceNewItems(scope) {
    applyFilters(scope || document);
    patchTags(scope || document);
    markVisited(scope || document);
    inlineImages(scope || document);
    wireRedditVideos(scope || document);
  }

  function hideGuard() {
    if (document.getElementById(GUARD_ID)) return;
    const s = document.createElement("style");
    s.id = GUARD_ID;
    // Hide the underlying page but keep our loading skeleton visible.
    s.textContent = "html{visibility:hidden!important}#orr-skeleton{visibility:visible!important}";
    (document.head || document.documentElement).appendChild(s);
  }
  function unhideGuard() {
    const s = document.getElementById(GUARD_ID);
    if (s) s.remove();
    hideSkeleton();
  }

  // A lightweight old-reddit-ish loading skeleton, shown on first paint.
  function showSkeleton() {
    if (document.getElementById("orr-skeleton") || !document.body) return;
    const sk = document.createElement("div");
    sk.id = "orr-skeleton";
    sk.setAttribute("aria-hidden", "true");
    let rows = "";
    for (let i = 0; i < 9; i++)
      rows += '<div class="orr-sk-row"><div class="orr-sk-thumb"></div><div class="orr-sk-lines"><div class="orr-sk-line w70"></div><div class="orr-sk-line w40"></div></div></div>';
    sk.innerHTML = '<div class="orr-sk-head"></div><div class="orr-sk-body">' + rows + "</div>";
    document.body.appendChild(sk);
  }
  function hideSkeleton() {
    const sk = document.getElementById("orr-skeleton");
    if (sk) sk.remove();
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
      err.retryAfter = retryAfterOf(res);
      throw err;
    }
    const json = await res.json();
    cache.set(url, { json, t: Date.now() });
    return json;
  }

  function replaceBody(body, title) {
    teardownInfinite();
    teardownMores();
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
    afterRender();
  }

  function renderInto(route, json, params) {
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    const body = buildBody(route, json, { startCount, t: params.t, me: meCached });
    const sub = route.scope === "front" ? "reddit" : "r/" + route.sub;
    replaceBody(body, sub + " — old reddit");
    patchHeader();
    loadSidebar(route); // async, fills .side when about/rules arrive

    const l0 = (json && json.data) || {};
    const showSub = route.scope === "front" || route.sub === "all" || route.sub === "popular";
    const count0 = startCount + (l0.children || []).filter((c) => c.kind === "t3").length;
    setupInfinite(
      async (after, count) => {
        const j = await fetchListing(route, { after, count, t: params.t });
        const kids = (((j && j.data) || {}).children || []).filter((c) => c.kind === "t3");
        const html = kids
          .map((c, i) => buildItem(c.data, { rank: count + 1 + i, odd: (count + i) % 2 === 0, showSub, expandoButton: true }))
          .join("");
        return { itemsHtml: html, after: ((j && j.data) || {}).after, addedCount: kids.length };
      },
      l0.after,
      count0
    );
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
    if (side) side.insertAdjacentHTML("beforeend", buildSidebar(v.about, v.rules));
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
    const body = buildCommentsBody(data, { sub: cr.sub, permalink: url.pathname, sort, me: meCached });
    replaceBody(body, (body.sub ? "r/" + body.sub : "reddit") + " — comments");
    active = true;
    unhideGuard();
    patchHeader();
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
    replaceBody(buildUserPage(ur, json, { startCount, me: meCached }), "u/" + ur.name + " — old reddit");
    active = true;
    unhideGuard();
    patchHeader();
    loadUserSidebar(ur.name);

    const l0 = (json && json.data) || {};
    const c0 = startCount + (l0.children || []).length;
    setupInfinite(
      async (after, count) => {
        const q = new URLSearchParams({ raw_json: "1", limit: "25", after, count: String(count) });
        const r2 = await fetch(location.origin + ur.basePath + "/.json?" + q.toString(), { credentials: "include", headers: { Accept: "application/json" } });
        if (!r2.ok) { const e = new Error("HTTP " + r2.status); e.status = r2.status; e.retryAfter = retryAfterOf(r2); throw e; }
        const j2 = await r2.json();
        const kids = ((j2 && j2.data) || {}).children || [];
        const html = kids
          .map((c, i) => {
            if (c.kind === "t3") return buildItem(c.data, { rank: count + 1 + i, odd: (count + i) % 2 === 0, showSub: true, expandoButton: true });
            if (c.kind === "t1") return buildUserComment(c.data, {});
            return "";
          })
          .join("");
        return { itemsHtml: html, after: ((j2 && j2.data) || {}).after, addedCount: kids.length };
      },
      l0.after,
      c0
    );
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
      if (side && about && about.data) side.insertAdjacentHTML("beforeend", buildUserSidebar(about));
    } catch (e) {
      /* ignore */
    }
  }

  async function loadSearch(url, firstLoad) {
    const route = ORR.isSearchRoute(url);
    if (!route) return;
    const params = {
      q: url.searchParams.get("q") || "",
      sort: url.searchParams.get("sort") || "relevance",
      t: url.searchParams.get("t") || "all",
      restrict_sr: url.searchParams.get("restrict_sr") === "1" || url.searchParams.get("restrict_sr") === "on",
      after: url.searchParams.get("after"),
      before: url.searchParams.get("before"),
      count: url.searchParams.get("count"),
    };
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let json;
    try {
      const jsonUrl = searchJsonUrl(route, params);
      const hit = cache.get(jsonUrl);
      if (hit && Date.now() - hit.t < CACHE_TTL) json = hit.json;
      else {
        const res = await fetch(jsonUrl, { credentials: "include", headers: { Accept: "application/json" } });
        if (!res.ok) {
          const e = new Error("HTTP " + res.status);
          e.status = res.status;
          throw e;
        }
        json = await res.json();
        cache.set(jsonUrl, { json, t: Date.now() });
      }
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
    replaceBody(buildSearchPage(json, { route, params, startCount, me: meCached }), (params.q ? params.q + " — " : "") + "search — old reddit");
    active = true;
    unhideGuard();
    patchHeader();

    const l0 = (json && json.data) || {};
    const c0 = startCount + (l0.children || []).filter((c) => c.kind === "t3").length;
    setupInfinite(
      async (after, count) => {
        const u = searchJsonUrl(route, Object.assign({}, params, { after, before: null, count }));
        const r2 = await fetch(u, { credentials: "include", headers: { Accept: "application/json" } });
        if (!r2.ok) { const e = new Error("HTTP " + r2.status); e.status = r2.status; e.retryAfter = retryAfterOf(r2); throw e; }
        const j2 = await r2.json();
        const kids = (((j2 && j2.data) || {}).children || []).filter((c) => c.kind === "t3");
        const html = kids
          .map((c, i) => buildItem(c.data, { rank: count + 1 + i, odd: (count + i) % 2 === 0, showSub: true, expandoButton: true }))
          .join("");
        return { itemsHtml: html, after: ((j2 && j2.data) || {}).after, addedCount: kids.length };
      },
      l0.after,
      c0
    );
  }

  function loadPage(url, firstLoad) {
    // Starting any navigation: stop the previous page's auto-load retry timers,
    // observers, and sentinel up front — otherwise a pending backoff retry could
    // fire after we've moved on and refetch the old page into the new/error DOM.
    // (replaceBody also tears down on the success path; this covers the case
    // where the new load errors out and never reaches replaceBody.)
    teardownInfinite();
    teardownMores();
    if (ORR.isListingRoute(url)) return loadListing(url, firstLoad);
    if (ORR.isCommentsRoute(url)) return loadComments(url, firstLoad);
    if (ORR.isUserRoute(url)) return loadUser(url, firstLoad);
    if (ORR.isSearchRoute(url)) return loadSearch(url, firstLoad);
  }

  // Expand a "load more comments" stub via the morechildren API, re-nesting the
  // returned comments under their parent by parent_id. Best-effort (experimental).
  const moreTimers = new Set(); // pending comment-retry timers, cleared on navigation

  async function handleMore(el, auto) {
    const linkId = el.getAttribute("data-link");
    const childrenCsv = el.getAttribute("data-children");
    if (!childrenCsv) {
      continueThread(el); // "continue this thread" → load the subtree inline
      return;
    }
    if (el.dataset.orrLoading) return;
    el.dataset.orrLoading = "1";
    const allIds = childrenCsv.split(",").filter(Boolean);
    const batch = allIds.slice(0, 100); // morechildren takes up to ~100 ids per call
    const rest = allIds.slice(100);
    const left = parseInt(el.getAttribute("data-count") || String(allIds.length), 10) || allIds.length;
    el.textContent = "loading more comments… (" + left + (left === 1 ? " reply" : " replies") + " left)";
    let status = 0, retryAfter = 0, things = null;
    try {
      const q = new URLSearchParams({
        api_type: "json", link_id: linkId, children: batch.join(","), raw_json: "1", limit_children: "false",
      });
      const res = await fetch(location.origin + "/api/morechildren.json?" + q.toString(), {
        credentials: "include", headers: { Accept: "application/json" },
      });
      status = res.status;
      retryAfter = retryAfterOf(res);
      if (res.ok) {
        const j = await res.json();
        const errs = (j && j.json && j.json.errors) || [];
        // morechildren sometimes returns 200 with a RATELIMIT error body.
        if (errs.some((x) => Array.isArray(x) && /RATELIMIT/i.test(String(x[0])))) status = 429;
        else things = (j && j.json && j.json.data && j.json.data.things) || [];
      }
    } catch (e) {
      status = 0; // network error → treat as transient
    }
    if (things) {
      el.dataset.orrAttempt = "";
      insertMoreThings(el, things, linkId, rest);
      return;
    }
    if (isTransient(status)) {
      scheduleMoreRetry(el, auto, retryAfter);
    } else {
      el.textContent = "load more comments — failed (" + status + "), click to retry";
      el.dataset.orrLoading = "";
      el.dataset.orrAttempt = "";
    }
  }

  function scheduleMoreRetry(el, auto, retryAfterSec) {
    const attempt = (parseInt(el.dataset.orrAttempt || "0", 10) || 0) + 1;
    if (attempt > MAX_RETRY) {
      el.textContent = "⚠ rate-limited — click to retry loading comments";
      el.dataset.orrLoading = "";
      el.dataset.orrAttempt = "";
      return;
    }
    el.dataset.orrAttempt = String(attempt);
    el.dataset.orrLoading = "1"; // stay locked through the backoff
    const ms = backoffMs(attempt, retryAfterSec);
    let remain = Math.ceil(ms / 1000);
    const render = () => { el.textContent = "rate-limited — retrying in " + remain + "s… (try " + attempt + "/" + MAX_RETRY + ")"; };
    render();
    const iv = setInterval(() => { remain -= 1; if (remain <= 0) clearInterval(iv); else render(); }, 1000);
    moreTimers.add(iv);
    const to = setTimeout(() => {
      clearInterval(iv);
      moreTimers.delete(iv);
      moreTimers.delete(to);
      if (!el.isConnected) return; // navigated away
      el.dataset.orrLoading = "";
      handleMore(el, auto);
    }, ms);
    moreTimers.add(to);
  }

  function insertMoreThings(moreEl, things, linkId, rest) {
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
      const child = parentThing ? parentThing.querySelector(":scope > .child") : null;
      if (child) child.appendChild(node);
      else if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(node, wrap); // keep the stub at the bottom
    }
    if (rest && rest.length && wrap) {
      // more still to load: refresh the stub so the auto-loader continues.
      moreEl.setAttribute("data-children", rest.join(","));
      moreEl.setAttribute("data-count", String(rest.length));
      moreEl.textContent = "load more comments (" + rest.length + (rest.length === 1 ? " reply" : " replies") + ")";
      moreEl.dataset.orrLoading = "";
      moreEl.removeAttribute("data-orr-observed");
    } else if (wrap) {
      wrap.remove(); // done — drop the stub
    }
    patchTags(document);
    inlineImages(document);
    enhanceComments(document);
    observeMores(); // pick up new/continued "more" stubs
  }

  // Auto-load "load more comments" stubs when they scroll into view.
  let commentMoreObserver = null;
  function observeMores() {
    if (typeof IntersectionObserver === "undefined") return;
    if (!commentMoreObserver) {
      commentMoreObserver = new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (en.isIntersecting) {
              commentMoreObserver.unobserve(en.target);
              handleMore(en.target, true);
            }
          }
        },
        { rootMargin: "600px" }
      );
    }
    document.querySelectorAll("a.orr-more[data-children]:not([data-orr-observed])").forEach((a) => {
      if (a.closest(".child")) return; // nested "more" inside a thread → manual click only
      a.setAttribute("data-orr-observed", "1");
      commentMoreObserver.observe(a);
    });
  }
  function teardownMores() {
    if (commentMoreObserver) {
      commentMoreObserver.disconnect();
      commentMoreObserver = null;
    }
    moreTimers.forEach((id) => { clearTimeout(id); clearInterval(id); });
    moreTimers.clear();
  }

  function wireNav() {
    if (wired) return;
    wired = true;

    document.addEventListener(
      "click",
      (e) => {
        if (!active) return;
        // Reveal blurred NSFW/spoiler media on first click.
        const blurEl = e.target.closest && e.target.closest(".expando.orr-nsfw:not(.orr-revealed), .expando.orr-spoiler:not(.orr-revealed)");
        if (blurEl) {
          e.preventDefault();
          e.stopPropagation();
          blurEl.classList.add("orr-revealed");
          return;
        }
        // Comment collapse toggle.
        const expandLink = e.target.closest && e.target.closest("a.expand");
        if (expandLink) {
          e.preventDefault();
          e.stopPropagation();
          toggleCollapse(expandLink);
          return;
        }
        // "parent" link → scroll to & flash the parent comment.
        const parentLink = e.target.closest && e.target.closest("a.orr-parent");
        if (parentLink) {
          e.preventDefault();
          e.stopPropagation();
          const c = parentLink.closest(".thing.comment");
          const p = c && parentOf(c);
          if (p) { p.scrollIntoView({ block: "start", behavior: "smooth" }); flash(p); }
          hideHoverCard();
          return;
        }
        // Gallery prev/next.
        const gnav = e.target.closest && e.target.closest("a.orr-gnav");
        if (gnav) {
          e.preventDefault();
          e.stopPropagation();
          galleryNav(gnav);
          return;
        }
        // Tag-user link (inside a hover card).
        const tagBtn = e.target.closest && e.target.closest(".orr-tagbtn");
        if (tagBtn) {
          e.preventDefault();
          e.stopPropagation();
          promptTag(tagBtn.getAttribute("data-tag-user") || "");
          return;
        }
        // Old-reddit expando button → toggle the post's inline media/text.
        const expBtn = e.target.closest && e.target.closest(".expando-button");
        if (expBtn) {
          e.preventDefault();
          e.stopPropagation();
          const entry = expBtn.closest(".entry");
          const expando = entry ? entry.querySelector(":scope > .expando") : null;
          const collapse = !expBtn.classList.contains("collapsed");
          expBtn.classList.toggle("collapsed", collapse);
          expBtn.classList.toggle("expanded", !collapse);
          if (expando) {
            expando.style.display = collapse ? "none" : "";
            if (collapse) {
              // Collapsing hides the media but display:none does NOT pause it — so
              // stop any playing <video> (which cascades to audio.pause() via the
              // 'pause' listener) AND blank any iframe embed (whose browsing context
              // keeps playing audio while hidden). Both are restored on re-expand.
              expando.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (e) {} });
              expando.querySelectorAll("iframe.orr-embed").forEach((f) => {
                if (!f.dataset.orrSrc) f.dataset.orrSrc = f.src;
                f.src = "about:blank";
              });
            } else {
              expando.querySelectorAll("iframe.orr-embed").forEach((f) => {
                if (f.dataset.orrSrc) { f.src = f.dataset.orrSrc; delete f.dataset.orrSrc; }
              });
              wireRedditVideos(expando); // give the video its sound
            }
          }
          return;
        }
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
        // Only intercept routes we rebuild; let wiki/etc navigate normally.
        if (!ORR.isListingRoute(url) && !ORR.isCommentsRoute(url) && !ORR.isUserRoute(url) && !ORR.isSearchRoute(url)) return;
        e.preventDefault();
        e.stopPropagation();
        history.pushState(null, "", url.pathname + url.search);
        window.scrollTo(0, 0);
        loadPage(url, false);
      },
      true
    );

    // The old-reddit search form → navigate to a search route we rebuild.
    document.addEventListener(
      "submit",
      (e) => {
        if (!active) return;
        const form = e.target;
        if (!form || form.id !== "search") return;
        e.preventDefault();
        e.stopPropagation();
        const input = form.querySelector('input[name="q"]');
        const q = input ? input.value.trim() : "";
        if (!q) return;
        const restrict = form.querySelector('input[name="restrict_sr"]');
        const action = form.getAttribute("action") || "/search";
        const usp = new URLSearchParams();
        usp.set("q", q); // encodes & etc. so queries aren't split
        if (restrict && restrict.checked) usp.set("restrict_sr", "1");
        const target = action + "?" + usp.toString();
        history.pushState(null, "", target);
        window.scrollTo(0, 0);
        loadPage(new URL(target, location.origin), false);
      },
      true
    );

    window.addEventListener("popstate", () => {
      if (!active) return;
      const url = new URL(location.href);
      if (ORR.isListingRoute(url) || ORR.isCommentsRoute(url) || ORR.isUserRoute(url) || ORR.isSearchRoute(url))
        loadPage(url, false);
    });

    wireEnhancements();
  }

  async function start() {
    let prefs;
    try {
      prefs = await ORR.getPrefs();
    } catch (e) {
      return;
    }
    if (!prefs.enabled) return; // extension off → leave new Reddit alone
    infiniteOn = prefs.infiniteScroll !== false;
    nightModeOn = prefs.nightMode !== false;
    try {
      dataCache = await ORR.getData();
    } catch (e) {
      /* keep defaults */
    }
    const url = new URL(location.href);
    if (!ORR.isListingRoute(url) && !ORR.isCommentsRoute(url) && !ORR.isUserRoute(url) && !ORR.isSearchRoute(url))
      return; // unsupported route → leave it to new Reddit
    wireNav();
    showSkeleton(); // visible placeholder while the first page loads
    fetchMe(); // prime the identity so the header usually renders logged-in on first paint
    loadPage(url, true);
  }

  // React to setting changes live.
  try {
    api.storage.onChanged.addListener((changes, area) => {
      // settings/filters live in sync, big blobs in local — react to either.
      if (changes.infiniteScroll) infiniteOn = changes.infiniteScroll.newValue !== false;
      if (changes.nightMode) {
        nightModeOn = changes.nightMode.newValue !== false;
        if (active) applyNight();
      }
      if ((changes.filters || changes.userTags || changes.threadVisits) && active) {
        ORR.getData().then((d) => {
          dataCache = d;
          applyFilters(document);
          document.querySelectorAll("a.author[data-orr-tagged]").forEach((a) => delete a.dataset.orrTagged);
          document.querySelectorAll(".orr-usertag").forEach((s) => s.remove());
          patchTags(document);
        });
      }
      if (changes.enabled) {
        if (changes.enabled.newValue === false && active) location.reload();
        else if (!active) start();
      }
    });
  } catch (e) {
    /* ignore */
  }

  start();
})();
