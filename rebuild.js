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
    if ((m = /(?:tiktok\.com\/@[^/]+\/video\/|tiktok\.com\/v\/|vm\.tiktok\.com\/)(\d+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://www.tiktok.com/embed/v2/" + m[1], "allowfullscreen", 340, 560) };
    }
    if ((m = /clips\.twitch\.tv\/([A-Za-z0-9-]+)/i.exec(url)) || (m = /twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9-]+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://clips.twitch.tv/embed?clip=" + m[1] + "&parent=www.reddit.com&parent=reddit.com&autoplay=false", "allowfullscreen") };
    }
    if ((m = /bsky\.app\/profile\/([^/]+)\/post\/([A-Za-z0-9]+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://embed.bsky.app/embed/" + encodeURIComponent(m[1]) + "/app.bsky.feed.post/" + m[2], "", 550, 400) };
    }
    if ((m = /imgur\.com\/(?:a|gallery)\/([A-Za-z0-9]+)/i.exec(url))) {
      return { type: "image", html: embedHtml("https://imgur.com/a/" + m[1] + "/embed?pub=true", "allowfullscreen", 640, 500) };
    }
    if (/^https?:\/\//i.test(url) && /\.pdf(\?|#|$)/i.test(url)) {
      return { type: "selftext", html: `<div class="expando-container"><iframe class="orr-embed orr-pdf" src="${esc(url)}" loading="lazy" referrerpolicy="no-referrer"></iframe></div>` };
    }
    if (/\.(mp3|ogg|oga|wav|m4a|flac|opus)(\?|#|$)/i.test(url)) {
      return { type: "video", html: `<div class="expando-container"><audio class="orr-directaudio" controls preload="metadata" src="${esc(url)}"></audio></div>` };
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
  // Coarse post type for the post-type filter (image / video / text / link).
  function postType(d) {
    if (d.is_self) return "text";
    if (d.is_video || (d.media && d.media.reddit_video) || d.post_hint === "hosted:video" || d.post_hint === "rich:video") return "video";
    if (d.is_gallery || d.post_hint === "image" || isImageUrl(d.url || "")) return "image";
    return "link";
  }

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
        ? `<div class="expando-button collapsed ${exp.type}" role="button" tabindex="0" aria-expanded="false" aria-label="expand"></div>`
        : "";
    // NSFW always blurs; a spoiler blurs only in listings — on a comments page you
    // deliberately opened the post, so show it (issue #7: spoilers in one click).
    const blur = d.over_18 ? " orr-nsfw" : d.spoiler && !opts.expandText ? " orr-spoiler" : "";
    const expando = exp ? `<div class="expando${blur}"${opts.expandoButton ? ' style="display:none"' : ""}>${exp.html}</div>` : "";
    const flairText = d.link_flair_text || (Array.isArray(d.link_flair_richtext) ? d.link_flair_richtext.map((x) => x.t || "").join("") : "");
    const flairHtml = flairText ? ` <span class="linkflairlabel" title="${esc(flairText)}">${esc(flairText)}</span>` : "";
    const spoilerTag = d.spoiler ? ` <span class="linkflairlabel" style="background:#000;color:#fff">spoiler</span>` : "";
    const nsfwTag = d.over_18 ? ` <span class="linkflairlabel" style="background:#c00;color:#fff">NSFW</span>` : "";

    return (
      `<div class="thing id-${esc(d.name)} ${oddeven} ${nsfw} link" id="thing_${esc(d.name)}"` +
      ` data-fullname="${esc(d.name)}" data-permalink="${esc(permalink)}" data-subreddit="${esc(d.subreddit)}"` +
      ` data-author="${esc(d.author)}" data-domain="${esc(d.domain)}" data-nsfw="${d.over_18 ? "true" : "false"}"` +
      ` data-flair="${esc(flairText)}" data-score="${esc(typeof d.score === "number" ? d.score : "")}" data-created="${esc(d.created_utc || 0)}"` +
      ` data-promoted="${d.promoted || d.is_created_from_ads_ui ? "true" : "false"}"` +
      ` data-ptype="${postType(d)}" data-crosspost="${d.crosspost_parent || (d.crosspost_parent_list && d.crosspost_parent_list.length) ? "true" : "false"}">` +
      `<span class="rank">${esc(opts.rank || "")}</span>` +
      `<div class="midcol unvoted">` +
      `<div class="arrow up login-required" aria-hidden="true"></div>` +
      `<div class="score unvoted" title="${esc(d.score)}">${score}</div>` +
      `<div class="arrow down login-required" aria-hidden="true"></div>` +
      `</div>` +
      thumbnailHtml(d, permalink) +
      `<div class="entry unvoted">` +
      expBtn +
      `<div class="top-matter">` +
      `<p class="title">` +
      `<a class="title may-blank" href="${esc(linkHref)}" tabindex="1">${esc(d.title)}</a>` +
      flairHtml + spoilerTag + nsfwTag +
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
    const base = route.homeBase != null ? route.homeBase : (route.scope === "front" ? "" : "/r/" + route.sub);
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

  // Reddit's `t` only has fixed buckets; for a custom "last N days" we fetch the
  // smallest bucket that fully contains N days, then filter client-side to the
  // exact window (see daysSince + the sinceUtc filter in buildBody).
  function bucketForDays(days) {
    const d = parseInt(days, 10);
    if (!(d > 0)) return null;
    if (d <= 1) return "day";
    if (d <= 7) return "week";
    if (d <= 31) return "month";
    if (d <= 366) return "year";
    return "all";
  }
  function daysSince(days) {
    const d = parseInt(days, 10);
    return d > 0 ? Math.floor(Date.now() / 1000) - d * 86400 : null;
  }

  function timeMenuHtml(route, currentT, currentDays) {
    const customDays = parseInt(currentDays, 10);
    const custom = customDays > 0;
    const t = custom ? null : (currentT || "day"); // reddit's default for top/controversial
    const boldSel = ' style="font-weight:bold;text-decoration:underline"';
    const links = TIMES.map(([val, label]) => {
      const sel = val === t;
      return `<a href="${route.basePath}/?t=${val}"${sel ? boldSel : ""}>${label}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    // Custom "last N days" window — filtered client-side from the nearest bucket.
    const customField =
      ` <span class="separator">&middot;</span> ` +
      `<span class="orr-custom-top"${custom ? boldSel : ""}>last ` +
        `<input type="number" min="1" max="3650" class="orr-days-input" value="${custom ? esc(String(customDays)) : ""}" ` +
          `placeholder="N" style="width:48px" aria-label="custom number of days"> days ` +
        `<a href="#" class="orr-days-go">go</a></span>`;
    return `<div class="menuarea" style="padding:5px 5px 5px 10px;font-size:small">links from: ${links}${customField}</div>`;
  }

  // Build the full old-reddit page body (className + innerHTML) for a listing.
  function buildBody(route, json, opts) {
    opts = opts || {};
    const listing = (json && json.data) || {};
    let children = (listing.children || []).filter((c) => c.kind === "t3");
    if (opts.sinceUtc) children = children.filter((c) => (c.data.created_utc || 0) >= opts.sinceUtc);
    // multireddits and combined (r/a+b+c) listings mix subs → show each post's sub
    const showSub = route.scope === "front" || route.scope === "multi" || route.combined || route.sub === "all" || route.sub === "popular";
    const startRank = (opts.startCount || 0) + 1;

    const items = children
      .map((c, i) =>
        buildItem(c.data, { rank: startRank + i, odd: i % 2 === 0, showSub, expandoButton: true, nowMs: opts.nowMs })
      )
      .join("");

    const count = (startRank - 1) + children.length;
    const homeBase = route.homeBase != null ? route.homeBase : "/r/" + route.sub;
    const pageName = route.scope === "front" ? "reddit.com" : route.scope === "multi" ? "m/" + route.sub : "r/" + route.sub;
    const headerLink = route.scope === "front" ? "/" : homeBase + "/";

    const inner =
      buildHeader({ tabmenu: tabmenuHtml(route), pageName, pageHref: headerLink, me: opts.me, route }) +
      `<div class="side" role="complementary">${sideSearchHtml(route)}</div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      (route.sort === "top" || route.sort === "controversial" ? timeMenuHtml(route, opts.t, opts.days) : "") +
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

  // Render a wiki page (/r/{sub}/wiki/{page}) in old-reddit style. content_html is
  // Reddit's own sanitized HTML (raw_json=1).
  function buildWikiPage(route, json, opts) {
    opts = opts || {};
    const d = (json && json.data) || {};
    const contentHtml = d.content_html || (d.content_md ? "<pre>" + esc(d.content_md) + "</pre>" : "<p>(this wiki page is empty)</p>");
    const sub = route.sub;
    const pageName = sub ? "r/" + sub : "reddit.com";
    const homeBase = sub ? "/r/" + sub : "";
    const headerRoute = { scope: sub ? "sub" : "front", sub, homeBase };
    const inner =
      buildHeader({
        tabmenu: `<ul class="tabmenu"><li class="selected"><a class="choice" href="${esc(route.basePath)}">wiki</a></li></ul>`,
        pageName, pageHref: homeBase + "/", me: opts.me, route: headerRoute,
      }) +
      `<div class="side" role="complementary">${sideSearchHtml(headerRoute)}</div>` +
      `<a name="content"></a><div class="content" role="main">` +
      `<div id="siteTable" class="sitetable"><div class="wiki-page-content"><h1 class="wiki-page-title">${esc(route.page.replace(/_/g, " "))}</h1>` +
      `<div class="usertext-body"><div class="md">${contentHtml}</div></div></div></div></div>`;
    return { className: "wiki-page", inner };
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
      `<div class="midcol unvoted"><div class="arrow up login-required" aria-hidden="true"></div>` +
      `<div class="arrow down login-required" aria-hidden="true"></div></div>` +
      `<div class="entry unvoted">` +
      `<p class="tagline"><a href="javascript:void(0)" class="expand" role="button" aria-expanded="true" aria-label="collapse">[&ndash;]</a> ` +
      `<a href="/user/${esc(d.author)}" class="author may-blank">${esc(d.author)}</a>` +
      (d.author_flair_text ? ` <span class="flair" title="${esc(d.author_flair_text)}">${esc(d.author_flair_text)}</span>` : "") +
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
      `<div class="side" role="complementary">${sideSearchHtml({ scope: "sub", sub })}</div>` +
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
      `<div class="midcol unvoted"><div class="arrow up login-required" aria-hidden="true"></div>` +
      `<div class="score unvoted">${esc(d.score)}</div><div class="arrow down login-required" aria-hidden="true"></div></div>` +
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
      `<div class="side" role="complementary">${sideSearchHtml({ scope: "user" })}</div>` +
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
      `<div class="side" role="complementary"></div>` +
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
    bucketForDays, daysSince, shareLinkFor, buildSharePanel, postType,
    formatNumber, buildSidebar, commentSortMenuHtml, childrenOf, buildMore, buildComment, buildCommentTree, buildCommentsBody,
    userTabmenuHtml, buildUserComment, buildUserPage, buildUserSidebar,
    meIdentity, userbarLoggedIn, userbarLoggedOut, srBarHtml, searchFormHtml, sideSearchHtml, buildHeader,
    searchJsonUrl, searchHref, buildSearchPage, buildWikiPage,
  };

  // ---------- runtime driver -------------------------------------------

  const CSS_URL = api.runtime.getURL("vendor/oldreddit.bundled.css");
  const GUARD_ID = "orr-rebuild-guard";
  const CSS_ID = "orr-rebuild-css";
  const cache = new Map(); // jsonUrl -> { json, t }
  const CACHE_TTL = 60000;
  let active = false; // rebuild currently owns the page
  let wired = false;

  // Respect the OS "reduce motion" setting for our scrolling/animation.
  const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SB = REDUCED_MOTION ? "auto" : "smooth";

  // Logged-in identity for the header (fetched once).
  let mePromise = null;
  let meCached; // undefined = not fetched, null = logged out, object = raw me.json

  function fetchMe() {
    if (mePromise) return mePromise;
    mePromise = redditFetch(location.origin + "/api/me.json")
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

  // Global post-429 cooldown: after Reddit rate-limits us, remember it and grow
  // the minimum gap enforced before EVERY subsequent API call, so we stop
  // hammering. The gap escalates on repeated 429s and resets after a quiet spell.
  const DEFAULT_FETCH_OPTS = { credentials: "include", headers: { Accept: "application/json" } };
  const RL_STEP = 4000;    // first gap after a 429
  const RL_CAP = 20000;    // never space calls more than this
  const RL_DECAY = 90000;  // no 429 for this long → drop back to full speed
  let rlGap = 0;           // current min ms between reddit API calls
  let rlNextAt = 0;        // earliest timestamp the next call may run
  let rlLast429 = 0;       // remembered time of the most recent 429
  function noteRateLimit(retryAfterSec) {
    const now = nowMsNow();
    rlLast429 = now;
    rlGap = Math.min(Math.max(rlGap ? rlGap * 2 : RL_STEP, (retryAfterSec || 0) * 1000), RL_CAP);
    rlNextAt = now + rlGap;
    try { api.storage.local.set({ rl429: { at: now, gap: rlGap } }); } catch (e) {} // survive reloads
  }
  async function rlWait() {
    if (rlGap && nowMsNow() - rlLast429 > RL_DECAY) { rlGap = 0; rlNextAt = 0; } // quiet → reset
    const now = nowMsNow();
    if (rlNextAt > now) await sleep(rlNextAt - now);
    if (rlGap) rlNextAt = nowMsNow() + rlGap; // reserve the next slot so calls stay spaced
  }
  async function redditFetch(url, opts) {
    await rlWait();
    const o = opts || DEFAULT_FETCH_OPTS;
    const res = await fetch(url, o);
    if (res && res.status === 429) noteRateLimit(retryAfterOf(res));
    return res;
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
    sentinel.setAttribute("role", "status");
    sentinel.setAttribute("aria-live", "polite");
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
  // issue #6 toggles (set from prefs in start())
  let subredditCssOn = true, autoplayOn = false, hideReadOn = false, autoCollapseBotsOn = false, nightAutoOn = false;
  let dataCache = { filters: { subreddits: [], users: [], domains: [], keywords: [], flairs: [] }, userTags: {}, threadVisits: {} };
  const enhanceCache = new Map();

  // Compact / high-contrast / dyslexia-font are html-level classes (persist across
  // body replacement). CSS for each lives in ENHANCE_CSS.
  function applyBodyFlags(p) {
    const el = document.documentElement;
    if (!el) return;
    el.classList.toggle("orr-compact", p.compactView === true);
    el.classList.toggle("orr-contrast", p.highContrast === true);
    el.classList.toggle("orr-dyslexic", p.dyslexiaFont === true);
    el.classList.toggle("orr-fixedthumbs", p.fixedThumbnails === true);
  }
  // Content-width / font-size sliders: drive CSS custom properties on <html>.
  function applyLayoutVars(ui) {
    const el = document.documentElement;
    if (!el) return;
    ui = ui || {};
    const w = parseInt(ui.contentWidth, 10);
    const fs = parseInt(ui.fontSize, 10);
    const customFont = fs > 0 && fs !== 100;
    el.style.setProperty("--orr-content-width", w > 0 ? w + "px" : "");
    el.style.setProperty("--orr-font-scale", customFont ? String(fs / 100) : "");
    el.classList.toggle("orr-custom-width", w > 0);
    el.classList.toggle("orr-custom-font", customFont);
  }
  // Auto night mode on a simple local-time schedule (dark 8pm–7am).
  function applyNightSchedule() {
    if (!nightAutoOn) return;
    const h = new Date().getHours();
    nightModeOn = h >= 20 || h < 7;
  }

  // Subreddit custom CSS (old-reddit's signature feature). Fetched per sub and
  // injected AFTER our CSS so it themes the reproduced old-reddit DOM.
  let navGen = 0; // bumped on every navigation; guards async subreddit-CSS fetches
  let curSub = null; // subreddit of the current page (null when off-sub); lets the toggle apply live
  function removeSubredditCss() {
    document.querySelectorAll("#orr-subreddit-css").forEach((n) => n.remove());
  }
  async function applySubredditCss(sub) {
    curSub = sub || null; // remember the page's sub even when disabled, so re-enabling can re-apply
    removeSubredditCss();
    if (!subredditCssOn || !sub || sub === "all" || sub === "popular" || /[+\-]/.test(sub)) return;
    const gen = navGen;
    try {
      const res = await redditFetch(location.origin + "/r/" + encodeURIComponent(sub) + "/about/stylesheet.json?raw_json=1");
      if (gen !== navGen || !res.ok) return; // navigated away → drop this sub's CSS
      const j = await res.json();
      if (gen !== navGen) return;
      let css = j && j.data && j.data.stylesheet;
      if (!css) return;
      const imgs = (j.data && j.data.images) || [];
      // Reddit stylesheets reference uploaded images as url(%%name%%).
      css = css.replace(/%%([\w-]+)%%/g, (m, name) => {
        const im = imgs.find((x) => x.name === name);
        return im && im.url ? im.url : m;
      });
      const s = document.createElement("style");
      s.id = "orr-subreddit-css";
      s.textContent = css;
      document.head.appendChild(s);
    } catch (e) { /* ignore */ }
  }

  const ENHANCE_CSS = `
.thing.comment.collapsed > .child, .thing.comment.collapsed > .entry .usertext-body,
.thing.comment.collapsed > .entry .flat-list.buttons { display:none !important; }
.thing.comment.collapsed > .entry .tagline { opacity:.75; }
a.expand { color:#888; text-decoration:none; font-family:monospace; cursor:pointer; margin-right:2px; }
.thing.orr-kb-sel > .entry { outline:2px solid #ff4500; outline-offset:1px; }
.thing.orr-filtered { display:none !important; }
#siteTable.orr-reveal-filtered .thing.orr-filtered { display:block !important; opacity:.5; outline:1px dashed #c33; }
#orr-filtered-bar { margin:0 5px 6px; padding:4px 8px; font-size:12px; color:#555; background:#f6f6f6; border:1px solid #e0e0e0; border-radius:3px; }
#orr-filtered-bar a.orr-filtered-toggle { color:#369; font-weight:bold; cursor:pointer; }
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
/* reddit video wrapper + custom mute button (native volume control is hidden for
   audio-less video, so we provide our own) */
.orr-video-wrap { position:relative; display:inline-block; line-height:0; max-width:100%; }
.orr-video-wrap video { max-width:100%; }
button.orr-mute { position:absolute; top:8px; right:8px; z-index:6; background:rgba(0,0,0,.55); color:#fff;
  border:none; border-radius:4px; padding:2px 7px; cursor:pointer; font-size:15px; line-height:1.5; }
button.orr-mute:hover { background:rgba(0,0,0,.82); }
/* video niceties: playback-speed + loop controls, shown below the player */
.orr-vctl { line-height:normal; margin-top:3px; display:flex; gap:5px; }
.orr-vctl button { background:#eee; color:#333; border:1px solid #ccc; border-radius:3px; font:11px verdana,sans-serif; padding:2px 7px; cursor:pointer; }
.orr-vctl button:hover { background:#e2e2e2; }
.orr-vctl .orr-vloop.on { background:#ff4500; color:#fff; border-color:#ff4500; }
/* content-width & font-size sliders (Options) */
html.orr-custom-width body { max-width:var(--orr-content-width); margin-left:auto; margin-right:auto; }
html.orr-custom-font #siteTable, html.orr-custom-font .commentarea { zoom:var(--orr-font-scale); }
/* image lightbox */
html.orr-lb-open { overflow:hidden; }
#orr-lightbox { position:fixed; inset:0; z-index:2147483640; background:rgba(0,0,0,.9); display:flex; align-items:center; justify-content:center; }
#orr-lightbox #orr-lb-img { max-width:95vw; max-height:92vh; transform-origin:center; user-select:none; box-shadow:0 4px 40px rgba(0,0,0,.6); }
#orr-lightbox .orr-lb-bar { position:absolute; top:0; left:0; right:0; height:38px; display:flex; align-items:center; gap:14px; padding:0 14px; color:#fff; font:13px verdana,sans-serif; background:linear-gradient(rgba(0,0,0,.55),transparent); }
#orr-lightbox #orr-lb-count { margin-right:auto; }
#orr-lightbox .orr-lb-bar a { color:#8cf; text-decoration:none; }
#orr-lightbox .orr-lb-close { background:none; border:none; color:#fff; font-size:20px; cursor:pointer; line-height:1; }
#orr-lightbox .orr-lb-prev, #orr-lightbox .orr-lb-next { position:absolute; top:50%; transform:translateY(-50%); background:rgba(0,0,0,.4); color:#fff; border:none; font-size:40px; width:52px; height:82px; cursor:pointer; }
#orr-lightbox .orr-lb-prev { left:0; } #orr-lightbox .orr-lb-next { right:0; }
#orr-lightbox .orr-lb-prev:hover, #orr-lightbox .orr-lb-next:hover { background:rgba(0,0,0,.7); }
/* RES-style hover preview */
#orr-hoverimg { position:fixed; z-index:2147483630; display:none; pointer-events:none; background:#fff; border:1px solid #888; box-shadow:0 4px 20px rgba(0,0,0,.4); padding:2px; }
#orr-hoverimg img { display:block; max-width:44vw; max-height:80vh; }
.orr-pdf { width:100%; height:80vh; background:#fff; }
.orr-directaudio { width:100%; max-width:640px; display:block; }
/* post expando images/videos scale to fit the window (never cut off); click opens the lightbox */
.orr-resizable { display:inline-block; overflow:hidden; max-width:100%; line-height:0; cursor:zoom-in; }
.orr-resizable img.preview { max-width:100%; max-height:80vh; width:auto; height:auto; object-fit:contain; display:block; }
.orr-gimg { max-width:100%; max-height:80vh; }
.orr-video-wrap video, .expando video, video.orr-directvideo { max-width:100%; max-height:80vh; height:auto; }
/* fixed-size thumbnails (uniform row height for easy scanning) */
html.orr-fixedthumbs .thing.link .thumbnail img { width:70px; height:70px; max-width:70px; object-fit:cover; }
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
#orr-skeleton .orr-sk-msg { padding:8px 18px 0; color:#888; font:italic 13px verdana; min-height:16px; }
#orr-skeleton .orr-sk-body { padding:10px 18px; max-width:800px; }
#orr-skeleton .orr-sk-row { display:flex; gap:10px; margin:0 0 16px; }
#orr-skeleton .orr-sk-thumb { width:70px; height:50px; border-radius:3px; background:#e6e6e6; flex:0 0 auto; }
#orr-skeleton .orr-sk-lines { flex:1; }
#orr-skeleton .orr-sk-line { height:12px; margin:4px 0; border-radius:3px; background:linear-gradient(90deg,#ededed 25%,#f6f6f6 50%,#ededed 75%); background-size:400% 100%; animation:orr-sk-shim 1.3s infinite; }
#orr-skeleton .orr-sk-line.w70 { width:70%; } #orr-skeleton .orr-sk-line.w40 { width:40%; }
@keyframes orr-sk-shim { from { background-position:100% 0; } to { background-position:0 0; } }
/* accessibility: skip link, visible focus, reduced motion */
#orr-skip { position:fixed; left:8px; top:-48px; z-index:2147483600; background:#5f99cf; color:#fff;
  padding:8px 14px; border-radius:0 0 4px 4px; font:bold 13px verdana; text-decoration:none; transition:top .15s ease; }
#orr-skip:focus { top:0; outline:2px solid #ff4500; }
.expando-button:focus-visible, a.expand:focus-visible, a.orr-parent:focus-visible, a.orr-gnav:focus-visible,
#orr-cnav button:focus-visible, button.orr-mute:focus-visible, #orr-help-btn:focus-visible,
#orr-top:focus-visible, .thing:focus-visible, a.orr-more:focus-visible {
  outline:2px solid #ff4500; outline-offset:2px; }
@media (prefers-reduced-motion: reduce) {
  .orr-flash, #orr-skeleton .orr-sk-line, #orr-skip { animation:none !important; transition:none !important; }
}
/* flair */
.linkflairlabel { display:inline-block; background:#ddd; border:1px solid #ccc; border-radius:3px; padding:0 4px; margin:0 2px; font-size:x-small; color:#555; vertical-align:middle; }
.tagline .flair { display:inline-block; background:#eef; border:1px solid #ccd; border-radius:3px; padding:0 4px; font-size:x-small; color:#556; }
/* keyword highlight */
.thing.orr-highlight > .entry { box-shadow:-4px 0 0 #ffb000; background:rgba(255,224,130,.16); }
/* download button */
a.orr-dl { position:absolute; top:8px; left:8px; z-index:6; background:rgba(0,0,0,.55); color:#fff; border-radius:4px; padding:1px 7px; font-size:14px; line-height:1.5; text-decoration:none; }
a.orr-dl:hover { background:rgba(0,0,0,.82); }
/* inline spoiler tags: the bundled old-reddit CSS already hides
   .md-spoiler-text:not(.revealed) and reveals .revealed itself — the click handler
   just adds the .revealed class (old reddit's own JS isn't present). */
.md-spoiler-text:not(.revealed) { cursor:pointer; }
/* compact / density view */
html.orr-compact .thing .entry { line-height:1.2; }
html.orr-compact .thing.link { padding:1px 0; }
html.orr-compact .thing.link .expando { margin-top:3px; }
html.orr-compact .thing.link .tagline, html.orr-compact .thing.comment .tagline { font-size:x-small; }
html.orr-compact .thing.comment .child { margin-left:10px; }
html.orr-compact .midcol { margin-right:4px; }
/* high-contrast mode */
html.orr-contrast, html.orr-contrast .content, html.orr-contrast #siteTable, html.orr-contrast body { background:#fff !important; color:#000 !important; }
html.orr-contrast a, html.orr-contrast a * { color:#0000cc !important; }
html.orr-contrast a:visited { color:#551a8b !important; }
html.orr-contrast .tagline, html.orr-contrast .domain, html.orr-contrast .score, html.orr-contrast .md { color:#000 !important; }
html.orr-contrast .thing { border:1px solid #000 !important; }
html.orr-contrast.orr-night, html.orr-contrast.orr-night body, html.orr-contrast.orr-night .content, html.orr-contrast.orr-night #siteTable { background:#000 !important; color:#fff !important; }
html.orr-contrast.orr-night a, html.orr-contrast.orr-night a * { color:#7fd0ff !important; }
/* dyslexia-friendly font + spacing */
html.orr-dyslexic body, html.orr-dyslexic .md, html.orr-dyslexic .usertext-body, html.orr-dyslexic .title, html.orr-dyslexic .tagline {
  font-family:"Comic Sans MS","Trebuchet MS",Verdana,sans-serif !important; letter-spacing:.03em; word-spacing:.08em; line-height:1.6; }
html.orr-dyslexic .md p { margin-bottom:.7em; }
/* quick subreddit switcher */
#orr-qs { position:fixed; inset:0; z-index:2147483600; background:rgba(0,0,0,.45); display:flex; align-items:flex-start; justify-content:center; }
#orr-qs .orr-qs-box { margin-top:16vh; background:#fff; border-radius:8px; padding:14px; box-shadow:0 8px 30px rgba(0,0,0,.4); width:340px; max-width:90vw; }
#orr-qs input { width:100%; box-sizing:border-box; font:15px verdana; padding:8px 10px; border:1px solid #5f99cf; border-radius:5px; }
#orr-qs .orr-qs-hint { color:#888; font:11px verdana; margin-top:8px; }
html.orr-night #orr-qs .orr-qs-box { background:#242526; }
html.orr-night #orr-qs input { background:#111; color:#d7dadc; border-color:#474748; }
/* other discussions */
.orr-other-box { margin:10px; padding:8px 12px; background:#f6f7f8; border:1px solid #ddd; border-radius:4px; font-size:12px; }
.orr-other-box h4 { margin:0 0 6px; }
.orr-other-box ul { margin:0; padding-left:18px; }
html.orr-night .orr-other-box { background:#242526; border-color:#343536; }`;

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
    if (!document.getElementById("orr-skip")) {
      const sk = document.createElement("a");
      sk.id = "orr-skip";
      sk.href = "#siteTable";
      sk.textContent = "Skip to content";
      sk.addEventListener("click", (e) => {
        e.preventDefault();
        const t = document.getElementById("siteTable");
        if (t) { t.setAttribute("tabindex", "-1"); t.focus(); t.scrollIntoView(); }
      });
      document.body.insertBefore(sk, document.body.firstChild);
    }
    if (!document.getElementById("orr-top")) {
      const b = document.createElement("div");
      b.id = "orr-top";
      b.textContent = "↑ top";
      b.addEventListener("click", () => window.scrollTo({ top: 0, behavior: SB }));
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

  // Keep OUR #orr-top the only back-to-top: hide any rival floating "back to top"
  // control (from RES, a subreddit stylesheet, or a new-Reddit remnant) so there
  // aren't two. Conservative: only fixed/sticky floating chrome named exactly like a
  // back-to-top; never our own elements or in-content sort links.
  function hideRivalBackToTop() {
    let els;
    try { els = document.querySelectorAll("body > *, body > * > *, body > * > * > *"); } catch (e) { return; }
    els.forEach((el) => {
      const id = el.id || "";
      if (id === "orr-top" || id.indexOf("orr-") === 0) return; // our chrome
      if (el.dataset && el.dataset.orrRivalHidden) return;
      if (el.closest && el.closest("#siteTable, .commentarea, .content, .side, #header, #sr-header-area")) return;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") return;
      const name = (((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "") + " " +
        (el.childElementCount === 0 ? (el.textContent || "") : "")).trim();
      const arrowsOnly = /[↑⬆▲🔝]/.test(name) && /^[↑⬆▲🔝^\s]+$/.test(name);
      const clean = name.replace(/[↑⬆▲🔝^]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (arrowsOnly || /^(?:back to top|scroll to top|to top|top)$/.test(clean)) {
        el.style.setProperty("display", "none", "important");
        if (el.dataset) el.dataset.orrRivalHidden = "1";
      }
    });
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
    el.scrollIntoView({ block: "center", behavior: SB });
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
    if (document.getElementById("orr-lightbox")) return; // the lightbox owns its own keys
    // Special / contextual keys (not remappable).
    if (e.key === "Enter") { runKeyAction("open"); return; }
    if (e.key === "Escape") {
      if (document.getElementById("orr-help")) { closeHelp(); e.preventDefault(); }
      else hideHoverCard();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (hoverGallery) { navGallery(hoverGallery, e.key === "ArrowRight" ? 1 : -1); e.preventDefault(); }
      return;
    }
    const action = keyToActionMap()[e.key];
    if (action) { runKeyAction(action); e.preventDefault(); }
  }

  // ---- collapse comments ----
  function toggleCollapse(expandLink) {
    const thing = expandLink.closest(".thing.comment");
    if (!thing) return;
    const collapsed = thing.classList.toggle("collapsed");
    expandLink.innerHTML = collapsed ? "[+]" : "[&ndash;]";
    expandLink.setAttribute("aria-expanded", collapsed ? "false" : "true");
    expandLink.setAttribute("aria-label", collapsed ? "expand comment" : "collapse comment");
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

  // ---- filters + highlights ----
  function compileRegexes(list) {
    return (list || []).map((k) => {
      if (!k) return null;
      const m = /^\/(.+)\/([a-z]*)$/i.exec(k); // /pattern/flags → real regex
      if (m && /^[dgimsuvy]*$/i.test(m[2])) {
        // Reject nested quantifiers (catastrophic backtracking / ReDoS) → treat literally.
        if (/\([^)]*[+*][^)]*\)[+*?]/.test(m[1])) return { plain: k.toLowerCase() };
        try {
          let flags = m[2].replace(/[gy]/gi, ""); // g/y carry lastIndex state → drop them
          if (flags.indexOf("i") < 0) flags += "i";
          return new RegExp(m[1], flags);
        } catch (e) { return { plain: k.toLowerCase() }; } // bad regex → literal, don't drop
      }
      return { plain: k.toLowerCase() }; // plain substring (may contain slashes)
    }).filter(Boolean);
  }
  function matchAny(compiled, text) {
    const lower = text.toLowerCase();
    return compiled.some((c) => (c.plain != null ? lower.indexOf(c.plain) >= 0 : c.test(text)));
  }
  function applyFilters(scope) {
    // Never filter on a comments page — the single #siteTable .thing.link is the
    // post the user deliberately opened; hiding it (and a "1 hidden" banner) is wrong.
    if (document.querySelector(".commentarea")) { const b = document.getElementById("orr-filtered-bar"); if (b) b.remove(); return; }
    const f = dataCache.filters || {};
    const kw = compileRegexes(f.keywords);
    const hl = compileRegexes(f.highlights);
    const now = Math.floor(nowMsNow() / 1000);
    const root = scope && scope.querySelectorAll ? scope : document;
    const types = Array.isArray(f.postTypes) && f.postTypes.length ? f.postTypes : null; // types to HIDE
    root.querySelectorAll("#siteTable .thing.link").forEach((p) => {
      const sub = (p.getAttribute("data-subreddit") || "").toLowerCase();
      const author = (p.getAttribute("data-author") || "").toLowerCase();
      const domain = (p.getAttribute("data-domain") || "").toLowerCase();
      const flair = (p.getAttribute("data-flair") || "").toLowerCase();
      const titleEl = p.querySelector(".title a");
      const title = titleEl ? titleEl.textContent : "";
      const score = parseInt(p.getAttribute("data-score") || "", 10);
      const created = parseInt(p.getAttribute("data-created") || "0", 10);
      const nsfw = p.getAttribute("data-nsfw") === "true";
      const promoted = p.getAttribute("data-promoted") === "true";
      const ptype = p.getAttribute("data-ptype") || "";
      const crosspost = p.getAttribute("data-crosspost") === "true";
      const read = p.classList.contains("orr-visited");
      const hide =
        (f.subreddits || []).some((s) => s && s.toLowerCase() === sub) ||
        (f.users || []).some((u) => u && u.toLowerCase() === author) ||
        (f.domains || []).some((d) => d && domain.indexOf(d.toLowerCase()) >= 0) ||
        (f.flairs || []).some((fl) => fl && flair.indexOf(fl.toLowerCase()) >= 0) ||
        (kw.length && matchAny(kw, title)) ||
        (promoted && f.hidePromoted) ||
        (nsfw && f.hideNsfw) ||
        (types && types.indexOf(ptype) >= 0) ||
        (crosspost && f.hideCrossposts) ||
        (f.minScore != null && !isNaN(score) && score < f.minScore) ||
        (f.maxAgeHours != null && created && (now - created) > f.maxAgeHours * 3600) ||
        (hideReadOn && read);
      p.classList.toggle("orr-filtered", hide);
      p.classList.toggle("orr-highlight", !hide && hl.length > 0 && matchAny(hl, title));
    });
    updateFilteredBanner();
  }

  // "N posts hidden — show" banner above the listing, so filters aren't silent.
  function updateFilteredBanner() {
    const st = document.getElementById("siteTable");
    if (!st || !st.parentNode) return;
    const n = st.querySelectorAll(".thing.link.orr-filtered").length;
    let bar = document.getElementById("orr-filtered-bar");
    if (!n) { if (bar) bar.remove(); st.classList.remove("orr-reveal-filtered"); return; }
    const revealing = st.classList.contains("orr-reveal-filtered");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "orr-filtered-bar";
      st.parentNode.insertBefore(bar, st);
    }
    bar.innerHTML = `${n} post${n === 1 ? "" : "s"} hidden by your filters — ` +
      `<a href="#" class="orr-filtered-toggle">${revealing ? "re-hide" : "show"}</a>`;
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
        if (ex) { ex.innerHTML = "[+]"; ex.setAttribute("aria-expanded", "false"); ex.setAttribute("aria-label", "expand comment"); }
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
      previewJsonPromise = redditFetch(jsonUrl)
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
  // Remappable keyboard actions: default key + label. User overrides live in
  // dataCache.keyBindings (action -> key), edited on the Options page.
  const KEY_ACTIONS = {
    next:        { def: "j", label: "next item" },
    prev:        { def: "k", label: "previous item" },
    open:        { def: "o", label: "open selected item (or Enter)" },
    expand:      { def: "x", label: "expand media / collapse comment" },
    comments:    { def: "c", label: "open comments (on a listing)" },
    goto:        { def: "g", label: "go to subreddit (quick switcher)" },
    nextNew:     { def: "n", label: "next new comment (since last visit)" },
    prevNew:     { def: "p", label: "previous new comment" },
    collapseTop: { def: "[", label: "collapse / expand all top-level threads" },
    focusThread: { def: "]", label: "collapse other threads (focus this one)" },
    help:        { def: "?", label: "toggle this help" },
  };
  const KEY_ACTION_ORDER = ["next", "prev", "open", "expand", "comments", "goto", "nextNew", "prevNew", "collapseTop", "focusThread", "help"];
  function keyForAction(name) {
    const kb = (dataCache && dataCache.keyBindings) || {};
    return kb[name] || (KEY_ACTIONS[name] && KEY_ACTIONS[name].def);
  }
  function keyToActionMap() {
    const m = {};
    KEY_ACTION_ORDER.forEach((name) => { const k = keyForAction(name); if (k) m[k] = name; });
    return m;
  }
  function runKeyAction(name) {
    switch (name) {
      case "next": kbSelect(kbIdx + 1); break;
      case "prev": kbSelect(kbIdx - 1); break;
      case "open": { const c = kbCurrent(); const a = c && c.querySelector(".title a, a.bylink"); if (a) a.click(); break; }
      case "expand": { const c = kbCurrent(); const btn = c && c.querySelector(".expando-button"); if (btn) btn.click(); else if (c && c.classList.contains("comment")) { const ex = c.querySelector(":scope > .entry .expand"); if (ex) ex.click(); } break; }
      case "comments": { const c = kbCurrent(); const a = c && c.querySelector("a.comments, a.bylink.comments"); if (a) a.click(); break; }
      case "goto": openQuickSwitch(); break;
      case "nextNew": jumpComment(1, newComments()); break;
      case "prevNew": jumpComment(-1, newComments()); break;
      case "collapseTop": collapseAllTop(); break;
      case "focusThread": focusThread(); break;
      case "help": toggleHelp(); break;
    }
  }
  function buildShortcuts() {
    const key = (a) => { const k = keyForAction(a); return k === " " ? "Space" : k; };
    return KEY_ACTION_ORDER.map((a) => [key(a), KEY_ACTIONS[a].label])
      .concat([["← / →", "gallery / lightbox previous / next"], ["Esc", "close popups / lightbox"]]);
  }
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
      buildShortcuts().map((s) => '<tr><td class="k">' + esc(s[0]) + "</td><td>" + esc(s[1]) + "</td></tr>").join("") +
      '</table><p class="orr-help-close">press <b>?</b> or <b>Esc</b> to close · remap keys in Options</p></div>';
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
    const p = redditFetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    enhanceCache.set(url, p);
    return p;
  }

  function wireEnhancements() {
    document.addEventListener("keydown", handleKeydown, true);
    let rivalScrollTimer = null;
    window.addEventListener("scroll", () => {
      const b = document.getElementById("orr-top");
      if (b) b.classList.toggle("show", window.scrollY > 500);
      // a rival back-to-top often only appears once you scroll — sweep occasionally
      if (!rivalScrollTimer) rivalScrollTimer = setTimeout(() => { rivalScrollTimer = null; hideRivalBackToTop(); }, 400);
    });
    // Track the gallery under the pointer so arrow keys can page through it.
    document.addEventListener("mouseover", (e) => {
      hoverGallery = (e.target.closest && e.target.closest(".orr-gallery")) || null;
    }, true);
    // RES-style hover preview: peek an image/gif by hovering a post link (no click).
    document.addEventListener("mouseover", (e) => {
      if (!hoverPreviewOn) return;
      const a = e.target.closest && e.target.closest(".thing.link a.title, .thing.link a.thumbnail");
      if (!a) return;
      const src = hoverPreviewSrc(a.closest(".thing.link"));
      if (!src) return;
      clearTimeout(hoverImgTimer);
      hoverImgTimer = setTimeout(() => showHoverImg(src), 200);
    }, true);
    document.addEventListener("mousemove", (e) => {
      lastMouseX = e.clientX; lastMouseY = e.clientY;
      const el = document.getElementById("orr-hoverimg");
      if (el && el.style.display === "block") positionHoverImg(el, e.clientX, e.clientY);
    }, true);
    document.addEventListener("mouseout", (e) => {
      const a = e.target.closest && e.target.closest(".thing.link a.title, .thing.link a.thumbnail");
      if (!a) return;
      const to = e.relatedTarget;
      if (to && to.closest && to.closest(".thing.link a.title, .thing.link a.thumbnail") === a) return;
      hideHoverImg();
    }, true);
    // Double-click a resized inline comment image to reset it. (Post expando
    // images open the lightbox on click instead of resizing in-place.)
    document.addEventListener("dblclick", (e) => {
      const r = e.target.closest && e.target.closest(".orr-inline-img");
      if (r) { r.style.width = ""; r.style.height = ""; }
    });
    // Refetch reddit preview images whose signed URL has expired (403).
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (img && img.tagName === "IMG" && /(?:external-)?preview\.redd\.it/i.test(img.src || "")) refreshPreviewUrl(img);
    }, true);
    // Keyboard-activate our role="button" divs (e.g. the expando button) with Enter/Space.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("role") === "button" &&
          !/^(?:BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
        e.preventDefault();
        t.click();
      }
    });
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
  // The audio for a reddit video is a separate hidden element, and Chrome hides the
  // <video>'s native volume control because the video track has no audio — so we add
  // our own mute button. Mute state is global + persisted (orrVideoMuted).
  let orrVideoMuted = false;
  let videoLoopOn = false, videoSpeed = 1, videoVolume = null; // remembered video prefs (ui blob + videoLoop bool)
  let hoverPreviewOn = true, lastMouseX = 0, lastMouseY = 0;
  let expandImagesOn = false;
  function updateUi(patch) { dataCache.ui = Object.assign({}, dataCache.ui, patch); ORR.setPrefs({ ui: dataCache.ui }); }
  function setVideoMuted(m) {
    orrVideoMuted = !!m;
    document.querySelectorAll("video.reddit-video").forEach((v) => {
      if (v._orrAudio) v._orrAudio.muted = orrVideoMuted;
      if (v._orrPaintMute) v._orrPaintMute();
    });
    ORR.setPrefs({ videoMuted: orrVideoMuted });
  }

  function wireRedditVideo(video) {
    if (!video || video.dataset.orrAudioWired) return;
    const cands = (video.getAttribute("data-audio-candidates") || "").split("|").filter(Boolean);
    const dashUrl = video.getAttribute("data-dash-url") || "";
    if (!cands.length && !dashUrl) return;
    video.dataset.orrAudioWired = "1";

    // Wrap the video so the mute button can overlay it precisely.
    let wrap = video.closest(".orr-video-wrap");
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "orr-video-wrap";
      if (video.parentNode) video.parentNode.insertBefore(wrap, video);
      wrap.appendChild(video);
    }
    const audio = document.createElement("audio");
    audio.preload = "none";
    audio.style.display = "none";
    audio.muted = orrVideoMuted;
    audio.loop = videoLoopOn; // loop the synced audio when the video is set to loop
    wrap.appendChild(audio);
    video._orrAudio = audio;

    // Custom, always-visible mute toggle (the native one is unavailable).
    const muteBtn = document.createElement("button");
    muteBtn.type = "button";
    muteBtn.className = "orr-mute";
    const paintMute = () => {
      muteBtn.textContent = audio.muted ? "🔇" : "🔊";
      const lbl = audio.muted ? "unmute video" : "mute video";
      muteBtn.setAttribute("aria-label", lbl);
      muteBtn.setAttribute("aria-pressed", audio.muted ? "true" : "false");
      muteBtn.title = lbl;
    };
    video._orrPaintMute = paintMute;
    paintMute();
    muteBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setVideoMuted(!audio.muted); });
    wrap.appendChild(muteBtn);

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
    // Volume slider (if the browser shows one) mirrors to the audio; mute is driven
    // by our own button (orrVideoMuted), not the video, so we don't override it here.
    video.addEventListener("volumechange", () => { audio.volume = video.volume; });
    audio.volume = video.volume;
  }

  function wireRedditVideos(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    let vids;
    try { vids = root.querySelectorAll("video.reddit-video[data-audio-candidates]"); } catch (e) { return; }
    vids.forEach(wireRedditVideo);
  }

  // ---- video niceties: playback speed, loop, remembered volume ----
  const VIDEO_SPEEDS = [1, 1.25, 1.5, 2, 0.5];
  function setVideoLoop(on) {
    videoLoopOn = !!on;
    document.querySelectorAll(".orr-video-wrap video, video.orr-directvideo, .expando video").forEach((v) => {
      v.loop = videoLoopOn;
      if (v._orrAudio) v._orrAudio.loop = videoLoopOn; // reddit videos loop their synced audio too
      if (v._orrPaintLoop) v._orrPaintLoop();
    });
    ORR.setPrefs({ videoLoop: videoLoopOn });
  }
  function addVideoControls(video) {
    if (!video || video.dataset.orrVctl) return;
    video.dataset.orrVctl = "1";
    const isReddit = video.classList.contains("reddit-video"); // reddit videos carry sound on a separate <audio>
    video.loop = videoLoopOn;
    if (video._orrAudio) video._orrAudio.loop = videoLoopOn; // keep the synced audio looping in step
    try { if (videoSpeed && videoSpeed !== 1) video.playbackRate = videoSpeed; } catch (e) {}
    if (!isReddit && videoVolume != null) { try { video.volume = videoVolume; } catch (e) {} }
    let wrap = video.closest(".orr-video-wrap");
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "orr-video-wrap";
      if (video.parentNode) video.parentNode.insertBefore(wrap, video);
      wrap.appendChild(video);
    }
    if (wrap.querySelector(":scope > .orr-vctl")) return; // controls already present
    const bar = document.createElement("div");
    bar.className = "orr-vctl";
    const speedBtn = document.createElement("button");
    speedBtn.type = "button"; speedBtn.className = "orr-vspeed";
    const paintSpeed = () => { const r = video.playbackRate || 1; speedBtn.textContent = (r % 1 ? r.toFixed(2).replace(/0$/, "") : r) + "×"; speedBtn.title = "playback speed (click to change)"; };
    paintSpeed();
    speedBtn.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      let i = VIDEO_SPEEDS.indexOf(video.playbackRate || 1);
      try { video.playbackRate = VIDEO_SPEEDS[(i + 1) % VIDEO_SPEEDS.length]; } catch (err) {}
    });
    const loopBtn = document.createElement("button");
    loopBtn.type = "button"; loopBtn.className = "orr-vloop"; loopBtn.textContent = "↻ loop";
    const paintLoop = () => { loopBtn.classList.toggle("on", !!video.loop); loopBtn.setAttribute("aria-pressed", video.loop ? "true" : "false"); loopBtn.title = video.loop ? "loop on" : "loop off"; };
    paintLoop();
    video._orrPaintLoop = paintLoop;
    loopBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setVideoLoop(!video.loop); });
    bar.appendChild(speedBtn); bar.appendChild(loopBtn);
    wrap.appendChild(bar);
    video.addEventListener("ratechange", () => {
      paintSpeed();
      const r = video.playbackRate || 1;
      if (r !== videoSpeed) { videoSpeed = r; updateUi({ videoSpeed: r }); }
    });
    if (!isReddit) video.addEventListener("volumechange", () => {
      if (video.volume !== videoVolume) { videoVolume = video.volume; updateUi({ videoVolume: video.volume }); }
    });
  }
  function enhanceVideoControls(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    try { root.querySelectorAll(".expando video, video.reddit-video, video.orr-directvideo").forEach(addVideoControls); } catch (e) {}
  }

  // ---- image lightbox (click an expanded image → fullscreen zoom / pan / paging) ----
  let lightboxState = null, lightboxKey = null, lightboxDragMove = null, lightboxDragUp = null;
  function closeLightbox() {
    const lb = document.getElementById("orr-lightbox");
    if (lb) lb.remove();
    if (lightboxKey) document.removeEventListener("keydown", lightboxKey, true);
    if (lightboxDragMove) window.removeEventListener("mousemove", lightboxDragMove);
    if (lightboxDragUp) window.removeEventListener("mouseup", lightboxDragUp);
    lightboxState = lightboxKey = lightboxDragMove = lightboxDragUp = null;
    document.documentElement.classList.remove("orr-lb-open");
  }
  function lightboxRender() {
    const s = lightboxState; if (!s) return;
    const img = document.getElementById("orr-lb-img"); if (!img) return;
    if (img.getAttribute("src") !== s.srcs[s.idx]) {
      img.onerror = () => { img.onerror = null; refreshPreviewUrl(img); };
      img.src = s.srcs[s.idx];
    }
    img.style.transform = `translate(${s.tx}px, ${s.ty}px) scale(${s.scale})`;
    img.style.cursor = s.scale > 1 ? "grab" : "zoom-in";
    const c = document.getElementById("orr-lb-count");
    if (c) c.textContent = s.srcs.length > 1 ? `${s.idx + 1} / ${s.srcs.length}` : "";
    const link = document.getElementById("orr-lb-open");
    if (link) link.href = s.srcs[s.idx];
  }
  function lightboxTo(delta) {
    const s = lightboxState; if (!s || s.srcs.length < 2) return;
    s.idx = (s.idx + delta + s.srcs.length) % s.srcs.length;
    s.scale = 1; s.tx = 0; s.ty = 0;
    lightboxRender();
  }
  function openLightbox(srcs, idx) {
    srcs = (srcs || []).filter(Boolean);
    if (!srcs.length) return;
    closeLightbox();
    lightboxState = { srcs, idx: Math.min(Math.max(idx || 0, 0), srcs.length - 1), scale: 1, tx: 0, ty: 0 };
    const lb = document.createElement("div");
    lb.id = "orr-lightbox";
    const multi = srcs.length > 1;
    lb.innerHTML =
      `<div class="orr-lb-bar"><span id="orr-lb-count"></span>` +
        `<a id="orr-lb-open" target="_blank" rel="noopener noreferrer">open image ↗</a>` +
        `<button type="button" class="orr-lb-close" aria-label="close">✕</button></div>` +
      (multi ? `<button type="button" class="orr-lb-prev" aria-label="previous">‹</button>` : "") +
      `<img id="orr-lb-img" alt="" draggable="false">` +
      (multi ? `<button type="button" class="orr-lb-next" aria-label="next">›</button>` : "");
    document.body.appendChild(lb);
    document.documentElement.classList.add("orr-lb-open");
    lightboxRender();
    const img = document.getElementById("orr-lb-img");
    img.addEventListener("wheel", (e) => {
      e.preventDefault();
      const s = lightboxState; if (!s) return;
      s.scale = Math.min(8, Math.max(1, s.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (s.scale === 1) { s.tx = 0; s.ty = 0; }
      lightboxRender();
    }, { passive: false });
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      if (moved) { moved = false; return; } // this click ended a pan-drag → don't toggle zoom
      const s = lightboxState; if (!s) return;
      s.scale = s.scale > 1 ? 1 : 2; s.tx = 0; s.ty = 0; lightboxRender();
    });
    img.addEventListener("mousedown", (e) => {
      if (!lightboxState || lightboxState.scale <= 1) return;
      dragging = true; moved = false; sx = e.clientX; sy = e.clientY; ox = lightboxState.tx; oy = lightboxState.ty; e.preventDefault();
    });
    lightboxDragMove = (e) => {
      if (!dragging || !lightboxState) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) moved = true;
      lightboxState.tx = ox + (e.clientX - sx); lightboxState.ty = oy + (e.clientY - sy); lightboxRender();
    };
    lightboxDragUp = () => { dragging = false; };
    window.addEventListener("mousemove", lightboxDragMove);
    window.addEventListener("mouseup", lightboxDragUp);
    lb.addEventListener("click", (e) => {
      if (moved) { moved = false; return; } // a drag that ended on the backdrop → don't close
      if (e.target.closest(".orr-lb-prev")) { lightboxTo(-1); return; }
      if (e.target.closest(".orr-lb-next")) { lightboxTo(1); return; }
      if (e.target.closest(".orr-lb-open")) return; // let the link open
      if (e.target.closest(".orr-lb-close") || e.target === lb || e.target.closest(".orr-lb-bar")) closeLightbox();
    });
    lightboxKey = (e) => {
      if (!lightboxState) return;
      if (e.key === "Escape") { closeLightbox(); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === "ArrowRight") { lightboxTo(1); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === "ArrowLeft") { lightboxTo(-1); e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("keydown", lightboxKey, true);
  }

  // ---- RES-style hover preview (peek an image/gif without clicking) ----
  let hoverImgTimer = null;
  function hideHoverImg() { clearTimeout(hoverImgTimer); const el = document.getElementById("orr-hoverimg"); if (el) el.style.display = "none"; }
  function positionHoverImg(el, x, y) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth || 400, h = el.offsetHeight || 300;
    let left = x + 18; if (left + w > vw - 8) left = x - w - 18; if (left < 8) left = 8;
    let top = y - h / 2; if (top < 8) top = 8; if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    el.style.left = left + "px"; el.style.top = top + "px";
  }
  function hoverPreviewSrc(thing) {
    if (!thing) return null;
    const gi = thing.querySelector(".expando .orr-gimg, .expando img.preview, .expando-container img");
    return gi && gi.getAttribute("src") ? gi.getAttribute("src") : null; // only image/gallery posts
  }
  function showHoverImg(src) {
    let el = document.getElementById("orr-hoverimg");
    if (!el) { el = document.createElement("div"); el.id = "orr-hoverimg"; el.innerHTML = '<img alt="">'; document.body.appendChild(el); }
    const img = el.querySelector("img");
    if (img.getAttribute("src") !== src) { img.onerror = () => { img.onerror = null; refreshPreviewUrl(img); }; img.src = src; }
    el.style.display = "block";
    positionHoverImg(el, lastMouseX, lastMouseY);
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
    target.scrollIntoView({ block: "start", behavior: SB });
    flash(target);
  }
  // Bulk collapse helpers (transient view state, like auto-collapse — not persisted).
  function collapseThing(thing, collapse) {
    if (!thing) return;
    thing.classList.toggle("collapsed", collapse);
    const ex = thing.querySelector(":scope > .entry .expand");
    if (ex) {
      ex.innerHTML = collapse ? "[+]" : "[&ndash;]";
      ex.setAttribute("aria-expanded", collapse ? "false" : "true");
      ex.setAttribute("aria-label", collapse ? "expand comment" : "collapse comment");
    }
  }
  function collapseAllTop() {
    const tops = topComments();
    if (!tops.length) return;
    const anyOpen = tops.some((t) => !t.classList.contains("collapsed"));
    tops.forEach((t) => collapseThing(t, anyOpen)); // any open → collapse all; else expand all
  }
  function focusThread() {
    const cur = kbCurrent();
    if (!cur || !cur.classList.contains("comment")) return;
    const top = cur.closest(".nestedlisting > .thing.comment") || cur;
    topComments().forEach((t) => collapseThing(t, t !== top));
    top.scrollIntoView({ block: "start", behavior: SB });
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
      const res = await redditFetch(url);
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
    autoCollapseBots();
    expandCommentMedia(scope || document);
    addDownloadButtons(scope || document);
  }

  // Auto-collapse AutoModerator / bot comments (heuristic: AutoModerator or a name
  // ending in "bot" / "-bot").
  const BOT_AUTHORS = ["automoderator"];
  function autoCollapseBots() {
    if (!autoCollapseBotsOn) return;
    document.querySelectorAll(".commentarea .thing.comment:not([data-orr-botchecked])").forEach((c) => {
      c.setAttribute("data-orr-botchecked", "1");
      const author = (c.getAttribute("data-author") || "").toLowerCase();
      const isBot = BOT_AUTHORS.indexOf(author) >= 0 || /[-_]?bot$/.test(author);
      if (isBot && !c.classList.contains("collapsed")) {
        c.classList.add("collapsed");
        const ex = c.querySelector(":scope > .entry .expand");
        if (ex) { ex.innerHTML = "[+]"; ex.setAttribute("aria-expanded", "false"); ex.setAttribute("aria-label", "expand comment"); }
      }
    });
  }

  // Autoplay muted reddit videos/gifs in listings as they scroll into view (RES).
  let autoplayObserver = null;
  function autoplayMedia(scope) {
    if (!autoplayOn || typeof IntersectionObserver === "undefined") return;
    if (document.querySelector(".commentarea")) return; // listings only
    const root = scope && scope.querySelectorAll ? scope : document;
    if (!autoplayObserver) {
      autoplayObserver = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          const btn = en.target;
          if (!en.isIntersecting) return;
          autoplayObserver.unobserve(btn);
          if (btn.classList.contains("collapsed")) btn.click(); // expand
          const entry = btn.closest(".entry");
          const v = entry && entry.querySelector(":scope > .expando video");
          if (v) {
            v.muted = true;
            // Reddit videos have a SEPARATE audio element — mute it too, else autoplay
            // blasts sound (v.muted only mutes the video-only track).
            if (v._orrAudio) { v._orrAudio.muted = true; if (v._orrPaintMute) v._orrPaintMute(); }
            try { v.play().catch(() => {}); } catch (e) {}
          }
        });
      }, { rootMargin: "0px" });
    }
    root.querySelectorAll(".thing.link .expando-button.video:not([data-orr-ap]), .thing.link .expando-button.video-muted:not([data-orr-ap])").forEach((b) => {
      b.setAttribute("data-orr-ap", "1");
      autoplayObserver.observe(b);
    });
  }

  // Download buttons on expanded images and videos.
  function dlLink(url, kind) {
    const a = document.createElement("a");
    a.className = "orr-dl";
    a.href = url;
    a.setAttribute("download", "");
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "⤓";
    a.title = "download " + kind + (kind === "video" ? " (video only — reddit stores audio separately)" : "");
    a.setAttribute("aria-label", "download " + kind);
    a.addEventListener("click", (e) => e.stopPropagation());
    return a;
  }
  function addDownloadButtons(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll(".expando .preview:not([data-orr-dl]), .orr-inline-img img:not([data-orr-dl])").forEach((img) => {
      img.dataset.orrDl = "1";
      const wrap = img.closest(".orr-resizable, .orr-inline-img") || img.parentNode;
      if (!wrap) return;
      if (!wrap.style.position) wrap.style.position = "relative";
      wrap.appendChild(dlLink(img.currentSrc || img.src, "image"));
    });
    root.querySelectorAll(".orr-video-wrap:not([data-orr-dl])").forEach((w) => {
      w.dataset.orrDl = "1";
      const v = w.querySelector("video");
      const src = v && (v.currentSrc || (v.querySelector("source") && v.querySelector("source").src));
      if (src) w.appendChild(dlLink(src, "video"));
    });
  }

  // ---- issue #6: recent subs, favorites bar, sort memory, other discussions,
  //      quick switcher, scroll restore ----
  const scrollPositions = {};
  let pendingScrollRestore = null;
  function scrollKey() { return location.pathname + location.search; }

  function rememberSub(sub) {
    if (!sub || /[+\-]/.test(sub) || sub === "all" || sub === "popular") return;
    let r = (dataCache.recentSubs || []).filter((s) => s && s.toLowerCase() !== sub.toLowerCase());
    r.unshift(sub);
    r = r.slice(0, 12);
    dataCache.recentSubs = r;
    ORR.setPrefs({ recentSubs: r });
  }
  function rememberCommentSort(sub, sort) {
    if (!sub || !sort) return;
    if (!dataCache.commentSorts) dataCache.commentSorts = {};
    if (dataCache.commentSorts[sub.toLowerCase()] === sort) return;
    dataCache.commentSorts[sub.toLowerCase()] = sort;
    ORR.setPrefs({ commentSorts: dataCache.commentSorts });
  }
  // Fill the header subreddit shortcut bar from favorites (if set) + recent subs.
  function patchSrBar() {
    const bar = document.querySelector("#sr-header-area .sr-bar");
    if (!bar) return;
    const fav = (dataCache.favoriteSubs || []).filter(Boolean);
    const recent = (dataCache.recentSubs || []).filter(Boolean);
    const subs = fav.length ? fav.slice() : DEFAULT_SRBAR.slice();
    const seen = subs.map((x) => x.toLowerCase());
    recent.forEach((s) => { if (seen.indexOf(s.toLowerCase()) < 0) { subs.push(s); seen.push(s.toLowerCase()); } });
    bar.innerHTML = subs.slice(0, 16).map((s) => `<a href="/r/${esc(s)}/" class="choice">${esc(s)}</a>`).join("\n");
  }

  // "other discussions" — crossposts / duplicate submissions of the same link.
  function addOtherDiscussions(data) {
    const post = data && data[0] && data[0].data && data[0].data.children && data[0].data.children[0] && data[0].data.children[0].data;
    if (!post || post.is_self) return; // self posts have no duplicates
    const buttons = document.querySelector("#siteTable .thing.link .flat-list.buttons");
    if (!buttons || buttons.querySelector(".orr-other")) return;
    const li = document.createElement("li");
    li.innerHTML = '<a href="javascript:void(0)" class="orr-other">other discussions</a>';
    buttons.appendChild(li);
    li.querySelector("a").addEventListener("click", async (e) => {
      e.preventDefault();
      const link = li.querySelector("a");
      if (link.dataset.loading) return;
      link.dataset.loading = "1";
      link.textContent = "loading other discussions…";
      try {
        const id = (post.name || "").replace(/^t3_/, "");
        const res = await redditFetch(location.origin + "/duplicates/" + id + "/.json?raw_json=1");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const j = await res.json();
        const dups = (j && j[1] && j[1].data && j[1].data.children) || [];
        const st = document.querySelector("#siteTable");
        const box = document.createElement("div");
        box.className = "orr-other-box";
        box.innerHTML =
          "<h4>Other discussions (" + dups.length + ")</h4>" +
          (dups.length
            ? "<ul>" + dups.map((c) => { const p = c.data; return '<li><a href="' + esc(p.permalink) + '">r/' + esc(p.subreddit) + "</a> — " + esc(p.num_comments || 0) + " comments · " + esc(p.score) + " points</li>"; }).join("") + "</ul>"
            : "<p>No other discussions found.</p>");
        if (st) st.appendChild(box);
        link.textContent = "other discussions (" + dups.length + ")";
        link.dataset.loading = "";
      } catch (err) {
        link.textContent = "other discussions — failed";
        link.dataset.loading = "";
      }
    });
  }

  // Quick subreddit switcher (RES-style go-to), opened with `g`.
  function navigateTo(path) {
    const u = new URL(path, location.origin);
    scrollPositions[scrollKey()] = window.scrollY;
    history.pushState(null, "", u.pathname + u.search);
    window.scrollTo(0, 0);
    loadPage(u, false);
  }
  // Custom "top of last N days": read the days input from the time menu and
  // navigate to ?days=N (jsonUrlFor maps it to a bucket; buildBody filters to the window).
  function submitCustomDays(fromEl) {
    const area = fromEl.closest(".menuarea") || document;
    const input = area.querySelector(".orr-days-input");
    const n = input ? parseInt(input.value, 10) : NaN;
    if (!(n > 0)) { if (input) input.focus(); return; }
    const r = ORR.isListingRoute(new URL(location.href));
    if (!r) return;
    navigateTo(r.basePath + "/?days=" + Math.min(n, 3650));
  }

  function openQuickSwitch() {
    if (document.getElementById("orr-qs")) return;
    const ov = document.createElement("div");
    ov.id = "orr-qs";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "go to subreddit");
    const list = (dataCache.favoriteSubs || []).concat(dataCache.recentSubs || []);
    const seen = {};
    const opts = list.filter((s) => s && !seen[s.toLowerCase()] && (seen[s.toLowerCase()] = 1)).slice(0, 15);
    ov.innerHTML =
      '<div class="orr-qs-box"><input id="orr-qs-input" placeholder="go to r/…  (Enter)" autocomplete="off" list="orr-qs-list" aria-label="subreddit name">' +
      '<datalist id="orr-qs-list">' + opts.map((s) => '<option value="' + esc(s) + '">').join("") + "</datalist>" +
      '<div class="orr-qs-hint">Enter to go &middot; Esc to close</div></div>';
    ov.addEventListener("click", (e) => { if (e.target === ov) closeQuickSwitch(); });
    document.body.appendChild(ov);
    const input = document.getElementById("orr-qs-input");
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const v = input.value.trim().replace(/^\/?(r\/)?/i, "").replace(/\/.*$/, "");
        closeQuickSwitch();
        if (v) navigateTo("/r/" + encodeURIComponent(v) + "/");
      } else if (e.key === "Escape") {
        closeQuickSwitch();
      }
    });
    input.focus();
  }
  function closeQuickSwitch() { const o = document.getElementById("orr-qs"); if (o) o.remove(); }

  // Per-subreddit overrides (force night, auto-expand). Sort/time is handled in
  // loadListing; this runs each render for the night/auto-expand parts.
  function applySubPrefs() {
    let r;
    try { const u = new URL(location.href); r = ORR.isListingRoute(u) || ORR.isCommentsRoute(u); } catch (e) { return; }
    const sub = r && r.sub ? String(r.sub).toLowerCase() : null;
    const sp = sub ? (dataCache.subPrefs || {})[sub] : null;
    if (!sp) return;
    if (sp.night) document.documentElement.classList.add("orr-night"); // force-on (never removes)
    if (sp.autoExpand) {
      // Expand each post exactly once (mark it), so re-running on infinite-scroll
      // appends never re-opens a post the user manually collapsed.
      document.querySelectorAll("#siteTable .thing.link:not([data-orr-autoexp])").forEach((t) => {
        t.setAttribute("data-orr-autoexp", "1");
        const b = t.querySelector(".expando-button.collapsed");
        if (b) b.click();
      });
    }
  }

  // RES-style "show images": auto-expand image/gallery previews on listings so you
  // can just scroll. Mark-once so it never re-opens a manually-collapsed post.
  function expandImagesPass() {
    if (!expandImagesOn) return;
    document.querySelectorAll("#siteTable .thing.link:not([data-orr-imgexp])").forEach((t) => {
      t.setAttribute("data-orr-imgexp", "1");
      const b = t.querySelector(".expando-button.collapsed.image"); // image + "image gallery"
      if (b) b.click();
    });
  }

  function afterRender() {
    injectStaticCss();
    applyNightSchedule(); // re-evaluate the time-of-day schedule as you browse
    applyNight();
    applySubPrefs();
    ensureUiChrome();
    hideRivalBackToTop();
    setTimeout(hideRivalBackToTop, 1500); // catch rivals added late (RES etc.)
    patchSrBar();
    if (pendingScrollRestore != null) {
      const y = pendingScrollRestore;
      pendingScrollRestore = null;
      setTimeout(() => window.scrollTo(0, y), 0);
    }
    kbIdx = -1;
    markVisited(document); // before applyFilters so "hide read" can act
    applyFilters(document);
    patchTags(document);
    markNewComments();
    inlineImages(document);
    wireRedditVideos(document);
    enhanceVideoControls(document);
    addDownloadButtons(document);
    enhanceComments(document);
    autoplayMedia(document);
    expandImagesPass();
    if (document.querySelector(".commentarea")) rememberVisit();
    observeMores();
  }
  function enhanceNewItems(scope) {
    markVisited(scope || document);
    applyFilters(scope || document);
    patchTags(scope || document);
    inlineImages(scope || document);
    wireRedditVideos(scope || document);
    enhanceVideoControls(scope || document);
    addDownloadButtons(scope || document);
    autoplayMedia(scope || document);
    applySubPrefs(); // auto-expand newly-appended posts if this sub wants it
    expandImagesPass(); // "show images": expand newly-appended image posts
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
    sk.innerHTML = '<div class="orr-sk-head"></div><div class="orr-sk-msg" role="status" aria-live="polite"></div><div class="orr-sk-body">' + rows + "</div>";
    document.body.appendChild(sk);
  }
  function setSkeletonMsg(text) {
    const m = document.querySelector("#orr-skeleton .orr-sk-msg");
    if (m) m.textContent = text || "";
  }
  function hideSkeleton() {
    const sk = document.getElementById("orr-skeleton");
    if (sk) sk.remove();
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    if (route.sort === "top" || route.sort === "controversial") {
      // custom "last N days" → fetch the smallest bucket covering N days, then filter
      const bucket = params.days ? bucketForDays(params.days) : params.t;
      if (bucket) q.set("t", bucket);
    }
    return location.origin + route.basePath + "/.json?" + q.toString();
  }

  async function fetchListing(route, params) {
    const url = jsonUrlFor(route, params);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
    const res = await redditFetch(url);
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
    const sinceUtc = daysSince(params.days); // custom "last N days" window (null otherwise)
    const body = buildBody(route, json, { startCount, t: params.t, days: params.days, sinceUtc, me: meCached });
    const sub = route.scope === "front" ? "reddit" : "r/" + route.sub;
    replaceBody(body, sub + " — old reddit");
    patchHeader();
    if (route.scope === "sub") rememberSub(route.sub);
    loadSidebar(route); // async, fills .side when about/rules arrive

    const l0 = (json && json.data) || {};
    const showSub = route.scope === "front" || route.scope === "multi" || route.combined || route.sub === "all" || route.sub === "popular";
    let kids0 = (l0.children || []).filter((c) => c.kind === "t3");
    if (sinceUtc) kids0 = kids0.filter((c) => (c.data.created_utc || 0) >= sinceUtc);
    const count0 = startCount + kids0.length; // match buildBody's displayed count so ranks stay continuous
    setupInfinite(
      async (after, count) => {
        const j = await fetchListing(route, { after, count, t: params.t, days: params.days });
        let kids = (((j && j.data) || {}).children || []).filter((c) => c.kind === "t3");
        if (sinceUtc) kids = kids.filter((c) => (c.data.created_utc || 0) >= sinceUtc);
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
      redditFetch(u)
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
    applySubredditCss(sub); // theme with the subreddit's own stylesheet (async)
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
    pendingScrollRestore = null; // a failed nav must not scroll the error/old page
    const st = document.getElementById("siteTable");
    const msg =
      status === 403
        ? "Classic Layout for Reddit: the Reddit JSON API returned 403 (are you logged in? Reddit blocks logged-out .json). Turn off Rebuild mode to use normal Reddit."
        : "Classic Layout for Reddit: couldn't load this page from the Reddit API (" + status + ").";
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
      days: url.searchParams.get("days"),
    };
    // Per-subreddit default sort/time: only on the FIRST load of a bare /r/{sub}
    // (typed/bookmarked/external). Not on SPA navs — otherwise the "hot" tab, whose
    // href is the same bare URL, would bounce straight back to the default sort.
    const sp = firstLoad && route.scope === "sub" && route.sub ? (dataCache.subPrefs || {})[route.sub.toLowerCase()] : null;
    if (sp && sp.sort && sp.sort !== "hot" && /^\/r\/[^/]+\/?$/.test(url.pathname) && !params.after && !params.before && !params.t && !params.days) {
      route.sort = sp.sort;
      route.basePath = "/r/" + route.sub + "/" + sp.sort;
      if (sp.t && (sp.sort === "top" || sp.sort === "controversial")) params.t = sp.t;
      try { history.replaceState(null, "", route.basePath + "/" + (params.t ? "?t=" + params.t : "")); } catch (e) {}
    }
    hideGuard();
    // Safety: if a fetch truly hangs on first load, never leave the page blank —
    // reveal new Reddit after a timeout (generous, since we retry rate-limits).
    let watchdog = null, gaveUp = false;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) { gaveUp = true; unhideGuard(); } }, 25000);
    // On first load, retry transient failures (429/5xx/network) with backoff instead
    // of immediately falling back to new Reddit — that fallback was the main cause of
    // "sometimes I still see the new stuff" when Reddit rate-limits the .json.
    let json = null, lastStatus = 0;
    for (let attempt = 0; ; attempt++) {
      if (gaveUp) return; // watchdog already revealed new Reddit
      try {
        json = await fetchListing(route, params);
        break;
      } catch (err) {
        lastStatus = err.status || 0;
        if (!firstLoad || !isTransient(lastStatus) || attempt >= 3) break;
        setSkeletonMsg("Reddit is busy — retrying… (" + (attempt + 1) + "/3)");
        await sleep(backoffMs(attempt + 1, err.retryAfter));
      }
    }
    if (watchdog) clearTimeout(watchdog);
    if (gaveUp) return;
    if (!json) {
      if (firstLoad) { active = false; unhideGuard(); } // give up → new Reddit
      else { renderError(lastStatus); unhideGuard(); }
      return;
    }
    await ensureCss();
    // Never leave the page hidden if a render helper throws on some odd payload.
    try {
      renderInto(route, json, params);
      active = true;
    } catch (e) {
      active = false; // fall back to new Reddit rather than a blank page
    }
    unhideGuard();
  }

  async function loadComments(url, firstLoad) {
    const cr = ORR.isCommentsRoute(url);
    if (!cr) return;
    // per-subreddit comment-sort memory: fall back to the sub's remembered sort.
    let sort = url.searchParams.get("sort");
    if (!sort && cr.sub && dataCache.commentSorts) sort = dataCache.commentSorts[cr.sub.toLowerCase()] || null;
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let data;
    try {
      const q = new URLSearchParams({ raw_json: "1", limit: "200" });
      if (sort) q.set("sort", sort);
      const jsonUrl = location.origin + url.pathname.replace(/\/$/, "") + "/.json?" + q.toString();
      const res = await redditFetch(jsonUrl);
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
    const realSub = body.sub || cr.sub;
    rememberSub(realSub);
    rememberCommentSort(realSub, sort);
    addOtherDiscussions(data);
    loadSidebar({ scope: "sub", sub: realSub });
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
      const res = await redditFetch(jsonUrl);
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
        const r2 = await redditFetch(location.origin + ur.basePath + "/.json?" + q.toString());
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
      const res = await redditFetch(location.origin + "/user/" + encodeURIComponent(name) + "/about.json?raw_json=1");
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
        const res = await redditFetch(jsonUrl);
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
        const r2 = await redditFetch(u);
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
    navGen++; // invalidate any in-flight subreddit-CSS fetch from the previous page
    teardownInfinite();
    teardownMores();
    if (autoplayObserver) { autoplayObserver.disconnect(); autoplayObserver = null; }
    curSub = null; // off-sub until loadSidebar sets it again; keeps the live CSS toggle accurate
    removeSubredditCss(); // clear the previous sub's theme; loadSidebar re-applies
    if (ORR.isListingRoute(url)) return loadListing(url, firstLoad);
    if (ORR.isCommentsRoute(url)) return loadComments(url, firstLoad);
    if (ORR.isUserRoute(url)) return loadUser(url, firstLoad);
    if (ORR.isSearchRoute(url)) return loadSearch(url, firstLoad);
    if (ORR.isWikiRoute && ORR.isWikiRoute(url)) return loadWiki(url, firstLoad);
  }

  async function loadWiki(url, firstLoad) {
    const route = ORR.isWikiRoute(url);
    if (!route) return;
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let json;
    try {
      const base = route.sub ? "/r/" + route.sub + "/wiki/" + route.page : "/wiki/" + route.page;
      const res = await redditFetch(location.origin + base + ".json?raw_json=1");
      if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
      json = await res.json();
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) { active = false; unhideGuard(); } else { renderError(err.status || 0); unhideGuard(); }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    replaceBody(buildWikiPage(route, json, { me: meCached }), (route.sub ? "r/" + route.sub : "reddit") + " wiki — old reddit");
    active = true;
    unhideGuard();
    patchHeader();
    if (route.sub) loadSidebar({ scope: "sub", sub: route.sub });
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
      const res = await redditFetch(location.origin + "/api/morechildren.json?" + q.toString());
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

  // ---------- post "share" panel (old-reddit's inline sharing) ----------
  // Clicking "share" opens the same .post-sharing panel old reddit used: a
  // readonly, auto-selected Link input plus Facebook/Twitter/Tumblr popups. The
  // bundled 2019 stylesheet already styles .post-sharing (the social icons are
  // baked in as data-URIs), so mirroring the DOM gives an authentic panel.
  // Email / reddit-PM sharing is omitted — it needs a write-scoped token this
  // read-only extension doesn't have.
  const SHARE_NETS = [["facebook", "Facebook"], ["twitter", "Twitter"], ["tumblr", "Tumblr"]];
  function shareLinkFor(permalink, source) {
    const sep = permalink.indexOf("?") >= 0 ? "&" : "?";
    return location.origin + permalink + sep + "ref=share&ref_source=" + source;
  }
  function buildSharePanel(permalink) {
    const opts = SHARE_NETS.map(([name, label]) =>
      `<div class="post-sharing-option post-sharing-option-${name}" data-post-sharing-option="${name}" role="button" tabindex="0">` +
        `<div class="c-tooltip" role="tooltip"><div class="tooltip-arrow bottom"></div>` +
        `<div class="tooltip-inner">Share to ${label}</div></div></div>`
    ).join("");
    return (
      `<div class="post-sharing" style="display:block">` +
        `<a href="#" class="c-close c-hide-text" aria-label="close">close this window</a>` +
        `<div class="post-sharing-main post-sharing-form" style="display:block">` +
          `<div class="c-form-group"><div class="post-sharing-label">Share with:</div>` +
            `<div class="post-sharing-options">${opts}</div></div>` +
          `<div class="c-form-group"><div class="post-sharing-label">Link:</div>` +
            `<input class="post-sharing-link-input c-form-control" name="link" type="text" readonly ` +
              `value="${esc(shareLinkFor(permalink, "link"))}"></div>` +
        `</div>` +
      `</div>`
    );
  }
  function closeSharePanels() {
    document.querySelectorAll(".post-sharing").forEach((p) => p.remove());
  }
  function toggleSharePanel(shareBtn) {
    const thing = shareBtn.closest(".thing");
    const buttons = shareBtn.closest("ul.buttons") || (thing && thing.querySelector(".entry .buttons"));
    if (!buttons) return;
    const hadOwn = !!(thing && thing.querySelector(".post-sharing"));
    closeSharePanels(); // only one open at a time
    if (hadOwn) return; // clicking share again on the same post just closes it
    const permalink = shareBtn.getAttribute("href") || (thing && thing.querySelector(".entry a.comments") &&
      thing.querySelector(".entry a.comments").getAttribute("href"));
    if (!permalink) return;
    buttons.insertAdjacentHTML("afterend", buildSharePanel(permalink));
    const input = buttons.parentElement.querySelector(".post-sharing .post-sharing-link-input");
    if (input) { input.focus(); input.select(); }
  }
  function openShareIntent(optEl) {
    const thing = optEl.closest(".thing");
    const shareBtn = thing && thing.querySelector("a.post-sharing-button");
    const permalink = shareBtn && shareBtn.getAttribute("href");
    if (!permalink) return;
    const net = optEl.getAttribute("data-post-sharing-option");
    const titleEl = thing.querySelector(".entry a.title");
    const title = titleEl ? titleEl.textContent : "";
    const url = shareLinkFor(permalink, net);
    let intent = "";
    if (net === "facebook") intent = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(url);
    else if (net === "twitter") intent = "https://twitter.com/intent/tweet?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(title) + "&via=reddit";
    else if (net === "tumblr") intent = "https://www.tumblr.com/widgets/share/tool?canonicalUrl=" + encodeURIComponent(url) + "&posttype=link&title=" + encodeURIComponent(title);
    else return;
    window.open(intent, net, "width=550,height=420,noopener");
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
        // Reveal an inline spoiler tag (>!…!<) in comment/post text. Use the
        // `.revealed` class the bundled old-reddit CSS expects (NOT orr-revealed).
        const spoiler = e.target.closest && e.target.closest(".md-spoiler-text:not(.revealed)");
        if (spoiler) {
          e.preventDefault();
          e.stopPropagation();
          spoiler.classList.add("revealed");
          return;
        }
        // "share" button → toggle the inline share panel (copyable link + socials).
        const shareBtn = e.target.closest && e.target.closest("a.post-sharing-button");
        if (shareBtn) {
          e.preventDefault();
          e.stopPropagation();
          toggleSharePanel(shareBtn);
          return;
        }
        const shareClose = e.target.closest && e.target.closest(".post-sharing .c-close");
        if (shareClose) { e.preventDefault(); e.stopPropagation(); closeSharePanels(); return; }
        const shareOpt = e.target.closest && e.target.closest(".post-sharing-option");
        if (shareOpt) { e.preventDefault(); e.stopPropagation(); openShareIntent(shareOpt); return; }
        const shareInput = e.target.closest && e.target.closest(".post-sharing-link-input");
        if (shareInput) { shareInput.focus(); shareInput.select(); return; } // re-select for easy copy
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
          if (p) { p.scrollIntoView({ block: "start", behavior: SB }); flash(p); }
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
          expBtn.setAttribute("aria-expanded", collapse ? "false" : "true");
          expBtn.setAttribute("aria-label", collapse ? "expand" : "collapse");
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
              // Expanding a spoiler/NSFW post is a deliberate "show me" action —
              // reveal it in this one click instead of requiring a second (issue #7).
              if (expando.classList.contains("orr-spoiler") || expando.classList.contains("orr-nsfw")) expando.classList.add("orr-revealed");
              expando.querySelectorAll("iframe.orr-embed").forEach((f) => {
                if (f.dataset.orrSrc) { f.src = f.dataset.orrSrc; delete f.dataset.orrSrc; }
              });
              wireRedditVideos(expando); // give the video its sound
              enhanceVideoControls(expando); // speed / loop controls + remembered prefs
              addDownloadButtons(expando);
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
        // Custom "last N days" top filter → read the input and navigate to ?days=N.
        // "N hidden — show / re-hide" filtered-posts toggle.
        const filtToggle = e.target.closest && e.target.closest(".orr-filtered-toggle");
        if (filtToggle) {
          e.preventDefault();
          e.stopPropagation();
          const stbl = document.getElementById("siteTable");
          if (stbl) { stbl.classList.toggle("orr-reveal-filtered"); updateFilteredBanner(); }
          return;
        }
        // Image lightbox: click an expanded image / gallery image → fullscreen viewer.
        const lbImg = e.target.closest && e.target.closest(".expando img.preview, .orr-gimg, .expando-container img");
        // Skip inline body images (.orr-inline-img) — they keep in-place resize + dblclick-reset.
        if (lbImg && lbImg.tagName === "IMG" && !lbImg.closest("a[href]") && !lbImg.closest(".orr-inline-img")) {
          e.preventDefault();
          e.stopPropagation();
          const gal = lbImg.closest(".orr-gallery");
          if (gal) {
            const imgs = Array.prototype.slice.call(gal.querySelectorAll(".orr-gimg"));
            openLightbox(imgs.map((im) => im.getAttribute("src")), imgs.indexOf(lbImg));
          } else {
            openLightbox([lbImg.getAttribute("src")], 0);
          }
          return;
        }
        const daysGo = e.target.closest && e.target.closest("a.orr-days-go");
        if (daysGo) {
          e.preventDefault();
          e.stopPropagation();
          submitCustomDays(daysGo);
          return;
        }
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        // Modified / non-left click, or target=_blank → let the browser open a new
        // tab instead of hijacking it into same-tab SPA navigation.
        if (e.ctrlKey || e.metaKey || e.shiftKey || (e.button && e.button !== 0) || a.target === "_blank") return;
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
        if (!ORR.isListingRoute(url) && !ORR.isCommentsRoute(url) && !ORR.isUserRoute(url) && !ORR.isSearchRoute(url) && !ORR.isWikiRoute(url)) return;
        e.preventDefault();
        e.stopPropagation();
        scrollPositions[scrollKey()] = window.scrollY; // remember where we were
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
        scrollPositions[scrollKey()] = window.scrollY; // so Back restores the listing
        history.pushState(null, "", target);
        window.scrollTo(0, 0);
        loadPage(new URL(target, location.origin), false);
      },
      true
    );

    // Enter inside the custom "last N days" input submits it.
    document.addEventListener("keydown", (e) => {
      if (!active) return;
      const t = e.target;
      if (e.key === "Enter" && t && t.classList && t.classList.contains("orr-days-input")) {
        e.preventDefault();
        e.stopPropagation();
        submitCustomDays(t);
      }
    }, true);

    window.addEventListener("popstate", () => {
      if (!active) return;
      const url = new URL(location.href);
      if (ORR.isListingRoute(url) || ORR.isCommentsRoute(url) || ORR.isUserRoute(url) || ORR.isSearchRoute(url) || (ORR.isWikiRoute && ORR.isWikiRoute(url))) {
        pendingScrollRestore = scrollPositions[scrollKey()] != null ? scrollPositions[scrollKey()] : 0;
        loadPage(url, false);
      }
    });

    wireEnhancements();
  }

  // Reddit Answers is a shadow-DOM app we can't rebuild — so we DON'T touch its
  // content (it keeps working natively) and just add a self-contained old-reddit
  // style top bar for visual consistency. Bar links do full navigations into the
  // rebuilt UI. Uses its own CSS (not the 352KB bundle) so it can't restyle the app.
  function loadAnswers() {
    if (!document.getElementById("orr-answers-css")) {
      const s = document.createElement("style");
      s.id = "orr-answers-css";
      s.textContent =
        "body{padding-top:56px!important}" +
        // Hide Reddit's native left sidebar (the "Join the most real place…" login
        // prompt / new-reddit nav) — we provide navigation via the old-reddit bar.
        "#left-sidebar-container{display:none!important}" +
        "#orr-answers-chrome{position:fixed;top:0;left:0;right:0;z-index:2147483000;font:12px Verdana,Arial,sans-serif}" +
        "#orr-answers-chrome .ac-sr{background:#f0f3fc;border-bottom:1px solid #c7d7e8;padding:2px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
        "#orr-answers-chrome .ac-sr a{color:#369;text-decoration:none;margin-right:9px}" +
        "#orr-answers-chrome .ac-sr .sep{color:#aaa;margin-right:9px}" +
        "#orr-answers-chrome .ac-hd{background:#cee3f8;border-bottom:1px solid #5f99cf;padding:5px 12px;display:flex;align-items:center;gap:12px}" +
        "#orr-answers-chrome .ac-logo{font:italic bold 22px Arial;color:#ff4500;text-decoration:none;letter-spacing:-1px}" +
        "#orr-answers-chrome .ac-page{color:#369;font-weight:bold}" +
        "#orr-answers-chrome .ac-search{margin-left:auto}" +
        "#orr-answers-chrome .ac-search input{border:1px solid #5f99cf;padding:3px 6px;width:220px;font-size:12px}" +
        "#orr-answers-chrome.ac-night .ac-sr{background:#20303f;border-color:#14202b}" +
        "#orr-answers-chrome.ac-night .ac-sr a{color:#cfe0f0}" +
        "#orr-answers-chrome.ac-night .ac-hd{background:#223244;border-color:#14202b}" +
        "#orr-answers-chrome.ac-night .ac-search input{background:#111;color:#d7dadc;border-color:#474748}";
      (document.head || document.documentElement).appendChild(s);
    }
    const build = () => {
      if (!document.body || document.getElementById("orr-answers-chrome")) return;
      const bar = document.createElement("div");
      bar.id = "orr-answers-chrome";
      bar.setAttribute("role", "navigation");
      bar.setAttribute("aria-label", "old reddit");
      if (nightModeOn) bar.classList.add("ac-night");
      const subs = ["AskReddit", "funny", "pics", "gaming", "worldnews", "videos", "science"];
      bar.innerHTML =
        '<div class="ac-sr"><a href="/">reddit</a><span class="sep">|</span>' +
        '<a href="/">front</a><a href="/r/all/">all</a><a href="/r/popular/">popular</a><span class="sep">-</span>' +
        subs.map((s) => '<a href="/r/' + s + '/">' + s + "</a>").join("") +
        "</div>" +
        '<div class="ac-hd"><a class="ac-logo" href="/">reddit</a><span class="ac-page">answers</span>' +
        '<form class="ac-search" action="/search" method="get"><input name="q" placeholder="search" aria-label="search reddit"></form></div>';
      document.body.insertBefore(bar, document.body.firstChild);
    };
    if (document.body) build();
    else document.addEventListener("DOMContentLoaded", build, { once: true });
  }

  async function start() {
    // Hide the page SYNCHRONOUSLY at document_start (before the async prefs read),
    // on a route we're going to rebuild — otherwise new Reddit flashes through
    // during the storage reads. Every early-return below must unhide.
    let preSupported = false;
    try {
      const preUrl = new URL(location.href);
      preSupported = !!(ORR.isListingRoute(preUrl) || ORR.isCommentsRoute(preUrl) || ORR.isUserRoute(preUrl) ||
        ORR.isSearchRoute(preUrl) || (ORR.isWikiRoute && ORR.isWikiRoute(preUrl)));
      if (preSupported) hideGuard();
    } catch (e) { /* ignore */ }
    let prefs;
    try {
      prefs = await ORR.getPrefs();
    } catch (e) {
      unhideGuard();
      return;
    }
    if (!prefs.enabled) { unhideGuard(); return; } // extension off → leave new Reddit alone
    infiniteOn = prefs.infiniteScroll !== false;
    nightModeOn = prefs.nightMode !== false;
    orrVideoMuted = prefs.videoMuted === true;
    videoLoopOn = prefs.videoLoop === true;
    hoverPreviewOn = prefs.hoverPreview !== false;
    expandImagesOn = prefs.expandImages === true;
    subredditCssOn = prefs.subredditCss !== false;
    autoplayOn = prefs.autoplayMedia === true;
    hideReadOn = prefs.hideRead === true;
    autoCollapseBotsOn = prefs.autoCollapseBots === true;
    nightAutoOn = prefs.nightAuto === true;
    applyBodyFlags(prefs);
    applyNightSchedule(); // may override nightModeOn based on time of day
    try {
      dataCache = await ORR.getData();
    } catch (e) {
      /* keep defaults */
    }
    const _ui = dataCache.ui || {};
    videoSpeed = typeof _ui.videoSpeed === "number" ? _ui.videoSpeed : 1;
    videoVolume = typeof _ui.videoVolume === "number" ? _ui.videoVolume : null;
    applyLayoutVars(_ui); // content width / font size sliders
    try { // restore a recent rate-limit cooldown so a reload doesn't immediately hammer Reddit
      const rls = await api.storage.local.get({ rl429: null });
      if (rls.rl429 && nowMsNow() - rls.rl429.at < RL_DECAY) {
        rlLast429 = rls.rl429.at;
        rlGap = Math.min(rls.rl429.gap || 0, RL_CAP);
        rlNextAt = nowMsNow() + Math.min(rlGap, 5000); // brief hold on the first post-reload call
      }
    } catch (e) {}
    const url = new URL(location.href);
    if (ORR.isAnswersRoute && ORR.isAnswersRoute(url)) {
      unhideGuard();
      loadAnswers(); // frame Reddit Answers in old-reddit chrome; leave the app itself
      return;
    }
    if (!ORR.isListingRoute(url) && !ORR.isCommentsRoute(url) && !ORR.isUserRoute(url) && !ORR.isSearchRoute(url) && !(ORR.isWikiRoute && ORR.isWikiRoute(url))) {
      unhideGuard();
      return; // unsupported route → leave it to new Reddit
    }
    try { history.scrollRestoration = "manual"; } catch (e) {} // we restore scroll ourselves
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
      if (changes.videoMuted && active) {
        const m = changes.videoMuted.newValue === true;
        if (m !== orrVideoMuted) {
          orrVideoMuted = m;
          document.querySelectorAll("video.reddit-video").forEach((v) => {
            if (v._orrAudio) v._orrAudio.muted = orrVideoMuted;
            if (v._orrPaintMute) v._orrPaintMute();
          });
        }
      }
      if (changes.nightMode) {
        nightModeOn = changes.nightMode.newValue !== false;
        if (active && !nightAutoOn) applyNight();
      }
      if (changes.videoLoop && active) {
        videoLoopOn = changes.videoLoop.newValue === true;
        document.querySelectorAll(".orr-video-wrap video, video.orr-directvideo").forEach((v) => { v.loop = videoLoopOn; if (v._orrAudio) v._orrAudio.loop = videoLoopOn; if (v._orrPaintLoop) v._orrPaintLoop(); });
      }
      if (changes.hoverPreview) { hoverPreviewOn = changes.hoverPreview.newValue !== false; if (!hoverPreviewOn) hideHoverImg(); }
      if (changes.ui && active) {
        const u = changes.ui.newValue || {};
        dataCache.ui = u;
        videoSpeed = typeof u.videoSpeed === "number" ? u.videoSpeed : 1;
        videoVolume = typeof u.videoVolume === "number" ? u.videoVolume : null;
        applyLayoutVars(u);
      }
      // New issue-#6 toggles: apply live where cheap (a reload also works).
      if (active && (changes.subredditCss || changes.autoplayMedia || changes.hideRead || changes.autoCollapseBots ||
                     changes.compactView || changes.nightAuto || changes.highContrast || changes.dyslexiaFont ||
                     changes.fixedThumbnails || changes.expandImages)) {
        ORR.getPrefs().then((p) => {
          subredditCssOn = p.subredditCss !== false;
          if (changes.subredditCss) applySubredditCss(curSub); // apply/remove the sub's CSS live
          autoplayOn = p.autoplayMedia === true;
          hideReadOn = p.hideRead === true;
          autoCollapseBotsOn = p.autoCollapseBots === true;
          nightAutoOn = p.nightAuto === true;
          applyBodyFlags(p); // includes fixedThumbnails
          applyNightSchedule();
          applyNight();
          applyFilters(document); // hideRead / re-filter
          if (changes.expandImages) { expandImagesOn = p.expandImages === true; expandImagesPass(); }
        });
      }
      if ((changes.filters || changes.favoriteSubs || changes.userTags || changes.threadVisits ||
           changes.subPrefs || changes.keyBindings) && active) {
        ORR.getData().then((d) => {
          dataCache = d;
          applyFilters(document);
          patchSrBar();
          document.querySelectorAll("a.author[data-orr-tagged]").forEach((a) => delete a.dataset.orrTagged);
          document.querySelectorAll(".orr-usertag").forEach((s) => s.remove());
          patchTags(document);
          applySubPrefs(); // reflect changed per-sub night/auto-expand (keyBindings picked up on next keypress)
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
