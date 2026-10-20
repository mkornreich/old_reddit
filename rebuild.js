"use strict";

// EXPERIMENTAL "rebuild" mode: on a subreddit / front-page LISTING route, throw
// away new Reddit's DOM and render OLD Reddit's real frontend from the JSON API,
// styled by the bundled archived stylesheet (vendor/oldreddit.bundled.css).
//
// Data path: same-origin `fetch(path + '/.json', {credentials:'include'})`, which
// rides the logged-in user's reddit_session cookie. Logged-out users get a 403
// network-security block instead; for them listings and threads are read from
// Reddit's server-rendered HTML (see "logged-out fallback" below). Anything else
// that fails falls back to letting new Reddit render, never leaving the page blank.
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
    if (d.orr_no_thumb) return ""; // (post type unknown: no self/link icon to pick)
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
  // file, described together by one DASH manifest. Derive that manifest's base URL
  // from the fallback (video) URL. Returns null if this isn't a v.redd.it fallback URL.
  function vRedditBase(fallbackUrl) {
    const m = /^(https?:\/\/v\.redd\.it\/[^/?#]+)\//i.exec(fallbackUrl || "");
    return m ? m[1] : null;
  }

  function embedHtml(src, extra, w, h) {
    // referrerpolicy: YouTube's embedded player requires a referrer/origin header
    // as of late 2025 and throws error 153 without one — "no-referrer" broke it.
    // strict-origin-when-cross-origin is the browser's own default when nothing is
    // specified at all: it reveals only the origin (https://www.reddit.com), never
    // the specific path/post, so it's not a meaningful privacy step down.
    return `<div class="expando-container"><iframe class="orr-embed" src="${esc(src)}" width="${w || 640}" height="${h || 360}" frameborder="0" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" ${extra || ""}></iframe></div>`;
  }

  // Bluesky/Twitter/Twitch-clip/Imgur embeds are blocked by Reddit's own page CSP
  // (frame-src) — see issue #20. Editing that CSP doesn't work (Firefox merges any
  // extension CSP edit with the original by design; Chrome's declarativeNetRequest
  // can only overwrite a header wholesale). Bluesky and Twitter both have a public
  // oEmbed endpoint (as does Giphy), so those get fetched (via background.js,
  // using a narrow optional host permission) and rendered NATIVELY as same-origin
  // DOM (see renderOembedNode — never the provider's raw HTML) instead of a
  // cross-origin iframe. Twitch clips have no such endpoint (RES doesn't solve
  // that one either) and Imgur's API needs a registered client ID, so both just
  // get a plain external link via externalLinkOnly.
  function oembedGatedEmbed(platform, originalUrl, label) {
    return `<div class="expando-container orr-embed-gate" data-embed-platform="${esc(platform)}" data-embed-href="${esc(originalUrl)}" data-embed-label="${esc(label)}">` +
      `<p>Reddit blocks ${esc(label)} previews from loading inline unless you allow it.</p>` +
      `<button type="button" class="orr-embed-allow">Enable ${esc(label)} previews</button>` +
      `<a href="${esc(originalUrl)}" target="_blank" rel="noopener noreferrer">open on ${esc(label)} instead &#8599;</a>` +
      `</div>`;
  }
  function externalLinkOnly(originalUrl, label) {
    return `<div class="expando-container orr-embed-gate">` +
      `<p>Reddit blocks ${esc(label)} previews from loading inline, and there's no way to show them without it.</p>` +
      `<a href="${esc(originalUrl)}" target="_blank" rel="noopener noreferrer">open on ${esc(label)} instead &#8599;</a>` +
      `</div>`;
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
    if (/(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i.test(url)) {
      return { type: "video", html: oembedGatedEmbed("twitter", url, "Twitter/X") };
    }
    if ((m = /(?:tiktok\.com\/@[^/]+\/video\/|tiktok\.com\/v\/|vm\.tiktok\.com\/)(\d+)/i.exec(url))) {
      return { type: "video", html: embedHtml("https://www.tiktok.com/embed/v2/" + m[1], "allowfullscreen", 340, 560) };
    }
    if (/clips\.twitch\.tv\/[A-Za-z0-9-]+/i.test(url) || /twitch\.tv\/[^/]+\/clip\/[A-Za-z0-9-]+/i.test(url)) {
      return { type: "video", html: externalLinkOnly(url, "Twitch clip") };
    }
    if (/bsky\.app\/profile\/[^/]+\/post\/[A-Za-z0-9]+/i.test(url)) {
      return { type: "video", html: oembedGatedEmbed("bluesky", url, "Bluesky") };
    }
    if (/imgur\.com\/(?:a|gallery)\/[A-Za-z0-9]+/i.test(url)) {
      return { type: "image", html: externalLinkOnly(url, "Imgur") };
    }
    if (/^https?:\/\/(?:www\.)?giphy\.com\/gifs\/[\w-]+/i.test(url)) {
      return { type: "image", html: oembedGatedEmbed("giphy", url, "Giphy") };
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

  // Old reddit's self-text box: .usertext > .usertext-body > .md (".link .usertext .md"
  // gives it its padding). Reddit's own selftext_html — and ours — already comes
  // wrapped in a .md div, so don't nest a second one.
  function selfTextBox(html, extraClass) {
    const md = /^\s*(?:<!--[\s\S]*?-->\s*)*<div class="md">/.test(html) ? html : `<div class="md">${html}</div>`;
    return `<div class="expando-container${extraClass ? " " + extraClass : ""}"><div class="usertext"><div class="usertext-body">${md}</div></div></div>`;
  }

  // Determine a post's expandable inline content, or null. Returns { type, html }
  // where type feeds the old-reddit expando-button sprite (selftext/image/video…).
  function postExpando(d) {
    const ex = postExpandoContent(d);
    // A post can carry its own body text AND media — new Reddit allows text on an
    // image, gallery, video or link post, and the text is often what the comments
    // reply to. Show it under the media rather than dropping it (it used to vanish
    // whenever a post had media).
    if (ex && !ex.hasText && !d.is_self && !d.orr_app && d.selftext_html) {
      return {
        type: ex.type,
        hasText: true,
        html: ex.html + selfTextBox(d.selftext_html, "orr-post-text"),
      };
    }
    return ex;
  }

  // The post's inline content: its media, or (when it has none) its text.
  function postExpandoContent(d) {
    if (d.orr_app) {
      // An interactive Devvit app post (game, poll, live thread…) only runs on Reddit itself.
      const href = String(d.permalink || "").replace(/\/+$/, "") + "/#orr-native";
      return {
        type: "selftext",
        html: selfTextBox(`<p>This post is an interactive Reddit app, which only runs on Reddit itself. ` +
          `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open it on Reddit &#8599;</a></p>`),
      };
    }
    if (d.is_self) {
      return d.selftext_html
        ? { type: "selftext", html: selfTextBox(d.selftext_html) }
        : null;
    }
    // A crosspost carries its media (reddit_video / gallery / preview) on the
    // ORIGINAL post in crosspost_parent_list, not on d itself — fall back to it so
    // crossposted v.redd.it videos, galleries and images still render (they showed
    // nothing before, since d.media/d.gallery_data were empty on the crosspost).
    const xp = (d.crosspost_parent_list && d.crosspost_parent_list[0]) || null;
    const posterOf = (m) => {
      const s = m && m.preview && m.preview.images && m.preview.images[0] && m.preview.images[0].source;
      return s && s.url ? s.url : null;
    };
    const rv = (d.media && d.media.reddit_video) || (xp && xp.media && xp.media.reddit_video) || null;
    if (rv && rv.fallback_url) {
      // Reddit's fallback_url is a VIDEO-ONLY stream — the audio is a separate
      // v.redd.it file, described together by one DASH manifest. We attach that
      // manifest URL so the runtime can hand it to dash.js, which demuxes both
      // tracks into this same <video> element via Media Source Extensions (see
      // wireRedditVideo) — real sync, not a hand-rolled two-element approximation.
      // Reddit "gif" videos (is_gif) have no audio track — don't bother.
      const base = (rv.has_audio === false || rv.is_gif === true) ? null : vRedditBase(rv.fallback_url);
      const dashUrl = base ? base + "/DASHPlaylist.mpd" : "";
      const audioAttr = dashUrl ? ` data-dash-url="${esc(dashUrl)}"` : "";
      // Show Reddit's own preview thumbnail as a poster so the player shows a frame
      // instead of a black box before play (the <video> is preload="none").
      const pu = posterOf(d) || posterOf(xp);
      const poster = pu ? ` poster="${esc(pu)}"` : "";
      return {
        type: dashUrl || rv.orr_muxed ? "video" : "video-muted",
        // (a Reddit "gif" is a silent MP4 — loop it like the GIF it stands for)
        html: `<div class="expando-container"><video class="reddit-video" controls preload="none"${rv.is_gif ? " loop muted playsinline data-orr-gif" : ""}${poster}${audioAttr} width="${esc(rv.width || 640)}" height="${esc(rv.height || 360)}"><source src="${esc(rv.fallback_url)}" type="video/mp4"></video></div>`,
      };
    }
    const gal = (d.is_gallery && d.gallery_data && d.media_metadata) ? d
      : (xp && xp.is_gallery && xp.gallery_data && xp.media_metadata ? xp : null);
    if (gal) {
      // Reddit's gallery metadata gives each item's real pixel size (x/y, not
      // width/height — a gallery-specific API quirk). Carry it alongside the
      // src through the same map+filter pass so indices can't drift apart,
      // and set it as plain width/height attributes so the browser reserves
      // the right aspect ratio before the image loads, instead of collapsing
      // to zero height and reflowing everything below it once it does — the
      // exact kind of shift that makes a page seem to "jump" while scrolling.
      const items = (gal.gallery_data.items || [])
        .map((it) => {
          const m = gal.media_metadata[it.media_id];
          const src = m && m.s ? m.s.u || m.s.gif : null;
          return src ? { src, w: m.s.x, h: m.s.y } : null;
        })
        .filter(Boolean);
      if (items.length) {
        const n = items.length;
        const imgs = items.map((it, i) => {
          const wh = it.w && it.h ? ` width="${esc(it.w)}" height="${esc(it.h)}"` : "";
          return `<img class="orr-gimg${i === 0 ? " active" : ""}"${wh} src="${esc(it.src)}">`;
        }).join("");
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
    const isImg = d.post_hint === "image" || (xp && xp.post_hint === "image") || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(d.url || "");
    if (isImg) {
      const source = (d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].source)
        || (xp && xp.preview && xp.preview.images && xp.preview.images[0] && xp.preview.images[0].source);
      const src = source && source.url ? source.url : d.url;
      // Reserve the real aspect ratio up front (see the gallery case above for
      // why) — only meaningful when source.url is what's actually used, since
      // a fallback to d.url has no matching dimensions.
      const wh = source && source.url && source.width && source.height
        ? ` width="${esc(source.width)}" height="${esc(source.height)}"` : "";
      return { type: "image", html: `<div class="expando-container"><span class="orr-resizable"><img class="preview"${wh} src="${esc(src)}"></span></div>` };
    }
    // No media: show body text — a link post's own (new Reddit allows both), or a
    // crossposted text post's original.
    const text = d.selftext_html || (xp && xp.selftext_html);
    if (text) return { type: "selftext", hasText: true, html: selfTextBox(text) };
    return null;
  }

  // Build one old-reddit listing item (.thing.link) from a post's `data` object.
  // Coarse post type for the post-type filter (image / video / text / link).
  function postType(d) {
    if (d.is_self) return "text";
    const xp = (d.crosspost_parent_list && d.crosspost_parent_list[0]) || null;
    if (d.is_video || (d.media && d.media.reddit_video) || (xp && (xp.is_video || (xp.media && xp.media.reddit_video))) ||
        d.post_hint === "hosted:video" || d.post_hint === "rich:video") return "video";
    if (d.is_gallery || (xp && xp.is_gallery) || d.post_hint === "image" || (xp && xp.post_hint === "image") || isImageUrl(d.url || "")) return "image";
    return "link";
  }

  // Only let Reddit's flair colours through as a hex value or a CSS named colour,
  // so a flair's background/text colour can't inject anything into the style attr.
  function safeFlairColor(c) {
    if (typeof c !== "string") return "";
    const s = c.trim();
    return /^#[0-9a-f]{3,8}$/i.test(s) || /^[a-z]+$/i.test(s) ? s : "";
  }
  // Render a Reddit flair (link or author) the way old reddit did: its richtext
  // parts — text plus emoji images — carrying the flair's own background/text
  // colours. Falls back to the plain *_flair_text. "" when there's nothing to show.
  function flairSpan(cls, text, richtext, bgColor, textColor) {
    let inner = "", hasContent = false;
    if (Array.isArray(richtext) && richtext.length) {
      inner = richtext.map((x) => {
        if (x && x.e === "emoji" && typeof x.u === "string" && /^https:\/\//i.test(x.u)) {
          hasContent = true;
          return `<img class="orr-flair-emoji" src="${esc(x.u)}" alt="${esc(x.a || "")}" title="${esc(x.a || "")}">`;
        }
        const t = (x && x.t) || "";
        if (t.trim()) hasContent = true;
        return esc(t);
      }).join("");
    } else if (text) {
      inner = esc(text);
      hasContent = true;
    }
    if (!hasContent) return "";
    const bg = safeFlairColor(bgColor);
    const style = bg ? ` style="background:${bg};border-color:${bg};color:${textColor === "light" ? "#fff" : "#000"}"` : "";
    const title = text || (Array.isArray(richtext) ? richtext.map((x) => (x && (x.e === "emoji" ? x.a : x.t)) || "").join("") : "");
    return ` <span class="${cls}"${style} title="${esc(title)}">${inner}</span>`;
  }

  // A deleted account renders as plain "[deleted]" (no /user/ link), like old reddit.
  function authorHtml(a) {
    return a === "[deleted]" ? "<span>[deleted]</span>" : `<a href="/user/${esc(a)}" class="author may-blank">${esc(a)}</a>`;
  }

  // ---------- your account in the markup (testable) ---------------------
  // Logged in, the JSON carries your vote (`likes`: true / false / null), whether
  // you saved or hid a post, and whether it's archived or locked. Old reddit shows
  // a vote as likes / dislikes / unvoted classes on the midcol, entry and score,
  // and upmod / downmod arrows.
  function voteState(d) {
    return d && d.likes === true ? "likes" : d && d.likes === false ? "dislikes" : "unvoted";
  }
  function accountDataAttrs(d) {
    return (d.saved ? ' data-saved="true"' : "") + (d.hidden ? ' data-hidden="true"' : "") +
      (d.archived ? ' data-archived="true"' : "") + (d.locked ? ' data-locked="true"' : "");
  }
  // Why you can't comment in a subreddit, from its about.json (logged in) — or null.
  function commentBlock(about) {
    const d = (about && about.data) || about || {};
    const sub = d.display_name || "";
    if (d.user_is_banned) return { code: "banned", text: `you're banned from r/${sub}, so you can't comment there.` };
    if (d.restrict_commenting && !d.user_is_contributor && !d.user_is_moderator)
      return { code: "restricted", text: `only approved users can comment in r/${sub}.` };
    return null;
  }
  // The vote arrows (and, for posts, the score between them). Clickable for
  // everyone, like old reddit's: logged out they nudge you to log in.
  function midcolHtml(d, scoreHtml) {
    const vs = voteState(d);
    return (
      `<div class="midcol ${vs}">` +
      `<div class="arrow ${vs === "likes" ? "upmod" : "up"}" role="button" tabindex="0" aria-label="upvote" aria-pressed="${vs === "likes"}"></div>` +
      (scoreHtml || "") +
      `<div class="arrow ${vs === "dislikes" ? "downmod" : "down"}" role="button" tabindex="0" aria-label="downvote" aria-pressed="${vs === "dislikes"}"></div>` +
      `</div>`
    );
  }
  // The buttons that act on your account, after a thing's own ones: save, hide (posts),
  // edit / delete (your own), report (others'), reply (comments). They're rendered for
  // everyone but CSS shows them only when you're logged in (html.orr-logged-in) and
  // edit / delete only on your own things (.orr-mine) — the first render can come
  // before /api/me.json answers. kind: "link" | "comment".
  function actionButtonsHtml(d, kind) {
    const a = (cls, label) => `<a href="javascript:void(0)" class="${cls}" role="button">${label}</a>`;
    let h = `<li class="orr-li-only orr-save-li">${a("orr-save", d.saved ? "unsave" : "save")}</li>`;
    if (kind === "link") h += `<li class="orr-li-only orr-hide-li">${a("orr-hide", d.hidden ? "unhide" : "hide")}</li>`;
    if (kind !== "link" || d.is_self) h += `<li class="orr-own-only">${a("orr-edit", "edit")}</li>`;
    h += `<li class="orr-own-only">${a("orr-delete", "delete")}</li>`;
    h += `<li class="orr-li-only orr-not-own">${a("orr-report", "report")}</li>`;
    if (kind === "comment" && !d.locked && !d.archived) h += `<li class="orr-li-only orr-reply-li">${a("orr-reply", "reply")}</li>`;
    return h;
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
    const flairHtml = flairSpan("linkflairlabel", d.link_flair_text, d.link_flair_richtext, d.link_flair_background_color, d.link_flair_text_color);
    const spoilerTag = d.spoiler ? ` <span class="linkflairlabel" style="background:#000;color:#fff">spoiler</span>` : "";
    const nsfwTag = d.over_18 ? ` <span class="linkflairlabel" style="background:#c00;color:#fff">NSFW</span>` : "";
    const vs = voteState(d);

    return (
      `<div class="thing id-${esc(d.name)} ${oddeven} ${nsfw}${d.stickied ? " stickied" : ""} link" id="thing_${esc(d.name)}"` +
      ` data-fullname="${esc(d.name)}" data-permalink="${esc(permalink)}" data-subreddit="${esc(d.subreddit)}"` +
      ` data-author="${esc(d.author)}" data-domain="${esc(d.domain)}" data-nsfw="${d.over_18 ? "true" : "false"}"` +
      ` data-flair="${esc(flairText)}" data-score="${esc(typeof d.score === "number" ? d.score : "")}" data-created="${esc(d.created_utc || 0)}"` +
      ` data-promoted="${d.promoted || d.is_created_from_ads_ui ? "true" : "false"}"` +
      ` data-comments="${esc(d.num_comments || 0)}"` +
      accountDataAttrs(d) +
      (d.orr_text_unsent && !d.selftext_html ? ' data-orr-textcheck="1"' : "") +
      ` data-ptype="${postType(d)}" data-crosspost="${d.crosspost_parent || (d.crosspost_parent_list && d.crosspost_parent_list.length) ? "true" : "false"}">` +
      `<span class="rank">${esc(opts.rank || "")}</span>` +
      midcolHtml(d, `<div class="score ${vs}" title="${esc(d.score)}">${score}</div>`) +
      thumbnailHtml(d, permalink) +
      `<div class="entry ${vs}">` +
      expBtn +
      `<div class="top-matter">` +
      `<p class="title">` +
      `<a class="title may-blank" href="${esc(linkHref)}" tabindex="1">${esc(d.title)}</a>` +
      flairHtml + spoilerTag + nsfwTag +
      (d.domain ? ` <span class="domain">(<a href="/domain/${esc(d.domain)}/">${esc(d.domain)}</a>)</span>` : "") +
      `</p>` +
      // (time/author can be unknown: a logged-out sticky comes from a highlight card that carries neither)
      `<p class="tagline">${d.created_utc || d.author ? "submitted" : ""}` +
      (d.created_utc ? ` <time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time>` : "") +
      (d.author ? ` by ${authorHtml(d.author)}` : "") +
      flairSpan("flair", d.author_flair_text, d.author_flair_richtext, d.author_flair_background_color, d.author_flair_text_color) +
      toSub +
      (d.stickied ? `${d.created_utc || d.author || toSub ? " - " : ""}<span class="stickied-tagline" title="selected by this subreddit's moderators">announcement</span>` : "") +
      (d.locked ? ` <span class="orr-locked" title="comments are locked">&#128274; locked</span>` : "") +
      `</p>` +
      `<ul class="flat-list buttons">` +
      `<li class="first"><a href="${esc(permalink)}" class="bylink comments may-blank">${comments}</a></li>` +
      `<li class="share"><a class="post-sharing-button" href="${esc(permalink)}">share</a></li>` +
      actionButtonsHtml(d, "link") +
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
  // Reddit only offers "best" for the front page, where it's the default (bare "/").
  const FRONT_TABS = [["best", ""], ["hot", "hot"]].concat(TABS.slice(1));
  const TAB_TITLES = {
    best: "New Reddit's default: popular posts with the most engagement",
    hot: "Old Reddit's classic default: posts getting lots of upvotes right now, favoring newer ones",
    new: "Newest posts first",
    rising: "New posts that are quickly gaining upvotes and comments",
    controversial: "Posts with a close split of upvotes and downvotes",
    top: "Most upvoted posts in the chosen time range",
  };

  function tabmenuHtml(route) {
    const base = route.homeBase != null ? route.homeBase : (route.scope === "front" ? "" : "/r/" + route.sub);
    const lis = (route.scope === "front" || route.bestTab ? FRONT_TABS : TABS).map(([name, seg]) => {
      const href = base + "/" + (seg ? seg + "/" : "");
      const sel = route.sort === name ? " selected" : "";
      return `<li class="${sel}"><a class="choice" href="${href}" title="${TAB_TITLES[name]}">${name}</a></li>`;
    }).join("");
    return `<ul class="tabmenu">${lis}</ul>`;
  }

  function navButtonsHtml(route, listing, count, t, extra) {
    const tq = (t ? "&t=" + t : "") + (extra || "");
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

  // Reddit's `t` only has fixed buckets; for a custom "last N hours/days" window we
  // fetch the smallest bucket that fully contains it, then filter client-side to the
  // exact cutoff (see windowSince + the sinceUtc filter in buildBody). Hours fill the
  // big gap between Reddit's built-in "past hour" and "past 24 hours".
  function bucketForDays(days) {
    const d = parseInt(days, 10);
    if (!(d > 0)) return null;
    if (d <= 1) return "day";
    if (d <= 7) return "week";
    if (d <= 31) return "month";
    if (d <= 366) return "year";
    return "all";
  }
  function bucketForHours(hours) {
    const h = parseInt(hours, 10);
    if (!(h > 0)) return null;
    return h <= 24 ? "day" : bucketForDays(Math.ceil(h / 24));
  }
  function daysSince(days) {
    const d = parseInt(days, 10);
    return d > 0 ? Math.floor(Date.now() / 1000) - d * 86400 : null;
  }
  function hoursSince(hours) {
    const h = parseInt(hours, 10);
    return h > 0 ? Math.floor(Date.now() / 1000) - h * 3600 : null;
  }
  // Unified custom-window helpers (hours wins over days if both are present).
  function windowBucket(params) {
    return params.hours ? bucketForHours(params.hours) : (params.days ? bucketForDays(params.days) : null);
  }
  function windowSince(params) {
    return params.hours ? hoursSince(params.hours) : daysSince(params.days);
  }

  function timeMenuHtml(route, currentT, currentDays, currentHours) {
    const customDays = parseInt(currentDays, 10);
    const customHours = parseInt(currentHours, 10);
    const custom = customDays > 0 || customHours > 0;
    const t = custom ? null : (currentT || "day"); // reddit's default for top/controversial
    const boldSel = ' style="font-weight:bold;text-decoration:underline"';
    const links = TIMES.map(([val, label]) => {
      const sel = val === t;
      return `<a href="${route.basePath}/?t=${val}"${sel ? boldSel : ""}>${label}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    // Custom "last N hours/days" windows — filtered client-side from the nearest bucket.
    // Hours fill the gap between Reddit's "past hour" and "past 24 hours".
    const customField =
      ` <span class="separator">&middot;</span> ` +
      `<span class="orr-custom-top"${customHours > 0 ? boldSel : ""}>last ` +
        `<input type="number" min="1" max="720" class="orr-hours-input" value="${customHours > 0 ? esc(String(customHours)) : ""}" ` +
          `placeholder="N" style="width:44px" aria-label="custom number of hours"> hours ` +
        `<a href="#" class="orr-hours-go">go</a></span>` +
      ` <span class="separator">&middot;</span> ` +
      `<span class="orr-custom-top"${customDays > 0 ? boldSel : ""}>last ` +
        `<input type="number" min="1" max="3650" class="orr-days-input" value="${customDays > 0 ? esc(String(customDays)) : ""}" ` +
          `placeholder="N" style="width:44px" aria-label="custom number of days"> days ` +
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
      (route.sort === "top" || route.sort === "controversial" ? timeMenuHtml(route, opts.t, opts.days, opts.hours) : "") +
      `<div id="siteTable" class="sitetable linklisting">` +
      (items || `<p id="noresults" class="error">there doesn't seem to be anything here</p>`) +
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
    // old reddit's join / leave toggle (shown when logged in; the runtime POSTs /api/subscribe)
    const subbed = !!d.user_is_subscriber;
    if (d.name)
      html += `<span class="fancy-toggle-button subscribe-button toggle orr-li-only" data-sr="${esc(d.name)}" data-subscribers="${esc(d.subscribers || 0)}">` +
        `<a class="option add${subbed ? "" : " active"}" href="javascript:void(0)" role="button">join</a>` +
        `<a class="option remove${subbed ? " active" : ""}" href="javascript:void(0)" role="button">leave</a></span>`;
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

  // Old reddit's "over 18?" interstitial (its own markup + the bundled CSS's
  // .interstitial styles). The continue button is wired by showAgeGate.
  function buildAgeGate(opts) {
    opts = opts || {};
    const sub = opts.sub || "";
    const inner =
      buildHeader({ pageName: sub ? "r/" + sub : "reddit.com", pageHref: sub ? "/r/" + sub + "/" : "/", me: opts.me, route: { scope: sub ? "sub" : "front", sub } }) +
      `<div class="content" role="main"><div class="interstitial">` +
      `<img class="interstitial-image" src="https://www.redditstatic.com/interstitial-image-over18.png" alt="over 18" height="150" width="150">` +
      `<div class="interstitial-message md-container"><div class="md">` +
      `<h3>You must be 18+ to view this ${opts.what || (opts.post ? "post" : "community")}</h3>` +
      `<p>You must be at least eighteen years old to view this content. Are you over eighteen and willing to see adult content?</p>` +
      `</div></div>` +
      `<div class="buttons"><a href="/" class="c-btn c-btn-primary">no thank you</a>` +
      `<button type="button" class="c-btn c-btn-primary orr-over18-yes">continue</button></div>` +
      `</div></div>`;
    return { className: "over18", inner };
  }

  // Logged-out sidebar, from new Reddit's right-rail widgets (railFromHtml).
  // Section html is already allowlist-sanitized there. (From PR #28 by @dirkaw.)
  function buildRailSidebar(rail) {
    const dn = rail.name || "";
    let html = '<div class="spacer"><div class="titlebox">';
    html += `<h1 class="redditname"><a class="hover" href="/r/${esc(dn)}/">${esc(rail.prefixedName || "r/" + dn)}</a></h1>`;
    if (rail.weeklyVisitors != null)
      html += `<div class="subscribers"><span class="number">${formatNumber(rail.weeklyVisitors)}</span> <span class="word">weekly visitors</span></div>`;
    if (rail.weeklyContributions != null)
      html += `<div class="users-online"><span class="number">${formatNumber(rail.weeklyContributions)}</span> <span class="word">weekly contributions</span></div>`;
    if (rail.description) html += `<div class="usertext-body"><div class="md"><p>${esc(rail.description)}</p></div></div>`;
    html += "</div></div>";
    (rail.sections || []).forEach((s) => {
      html += '<div class="spacer"><div class="sidecontentbox">';
      if (s.title) html += `<div class="title"><h1>${esc(s.title)}</h1></div>`;
      html += `<div class="content"><div class="md">${s.html}</div></div></div></div>`;
    });
    return html;
  }

  // ---------- comment editor + live preview (testable) ------------------
  // Old reddit's comment box (.usertext-edit + .bottom-area) with RES's live preview
  // and "big editor". kind: "top" (new top-level comment), "reply", "edit" or "message"
  // (a reply in the inbox); thing: the fullname it replies to / edits. The runtime sets
  // the textarea's text — it never goes through this HTML.
  function editorHtml(kind, thing) {
    const label = kind === "edit" ? "edit" : kind === "top" ? "write a comment" : "reply";
    return (
      `<form class="usertext orr-editor" data-kind="${esc(kind)}" data-thing="${esc(thing)}" action="#">` +
      `<div class="usertext-edit md-container">` +
      `<div class="md"><textarea rows="1" cols="1" name="text" aria-label="${label}"></textarea></div>` +
      `<div class="bottom-area">` +
      `<span class="help-toggle toggle"><a href="javascript:void(0)" class="orr-ed-help" role="button" aria-expanded="false">formatting help</a></span>` +
      `<a href="javascript:void(0)" class="reddiquette orr-ed-big" role="button" title="a bigger editor with the preview beside it">big editor</a>` +
      `<div class="usertext-buttons">` +
      `<button type="submit" class="save">save</button> ` +
      `<button type="button" class="cancel">cancel</button> ` +
      `<span class="status" role="status" aria-live="polite"></span>` +
      `</div></div>` +
      `<div class="orr-ed-preview-box" hidden><div class="orr-ed-label">preview</div><div class="orr-ed-preview md"></div></div>` +
      `</div></form>`
    );
  }
  // Old reddit's "formatting help" table (static).
  const MARKHELP_HTML =
    `<div class="markhelp orr-markhelp"><table><tbody>` +
    `<tr style="background-color:#ffff99;text-align:center"><td><em>you type:</em></td><td><em>you see:</em></td></tr>` +
    [
      ["*italics*", "<em>italics</em>"],
      ["**bold**", "<b>bold</b>"],
      ["[reddit!](https://reddit.com)", '<a href="https://reddit.com" target="_blank" rel="noopener">reddit!</a>'],
      ["* item 1<br>* item 2<br>* item 3", "<ul><li>item 1</li><li>item 2</li><li>item 3</li></ul>"],
      ["&gt; quoted text", "<blockquote>quoted text</blockquote>"],
      ["Lines starting with four spaces<br>are treated like code:<br><br><span class=\"spaces\">&nbsp;&nbsp;&nbsp;&nbsp;</span>if 1 * 2 &lt; 3:<br><span class=\"spaces\">&nbsp;&nbsp;&nbsp;&nbsp;</span>print \"hello, world!\"",
        "Lines starting with four spaces<br>are treated like code:<pre>if 1 * 2 &lt; 3:\n    print \"hello, world!\"</pre>"],
      ["~~strikethrough~~", "<del>strikethrough</del>"],
      ["super^script", "super<sup>script</sup>"],
      ["&gt;!spoiler!&lt;", '<span class="md-spoiler-text revealed">spoiler</span>'],
      ["`inline code`", "<code>inline code</code>"],
    ].map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("") +
    `</tbody></table></div>`;

  // A live preview of Reddit markdown while you type (Reddit renders the real thing
  // once it's posted). Covers what comments mostly use: paragraphs, emphasis,
  // strikethrough, superscript, spoilers, code, links, r/ and u/ links, quotes,
  // lists, headings, rules and tables. Text is escaped before any markup is added,
  // and links must be http(s) or on reddit, so a preview can't inject anything.
  function mdPreview(src) {
    const lines = String(src == null ? "" : src).replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    return mdBlocks(lines, 0);
  }
  const MD_LIST_ITEM = /^( {0,3})([*+-]|\d{1,9}[.)])\s+(.*)$/;
  function mdBlocks(lines, depth) {
    if (depth > 6) return "<p>" + mdInline(lines.join("\n")) + "</p>";
    let out = "", para = [], i = 0;
    const flush = () => { if (para.length) { out += "<p>" + mdInline(para.join("\n")) + "</p>"; para = []; } };
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { flush(); i++; continue; }
      let m = /^ {0,3}(```|~~~)/.exec(line);
      if (m) { // fenced code
        flush();
        const code = [];
        i++;
        while (i < lines.length && lines[i].trim().indexOf(m[1]) !== 0) code.push(lines[i++]);
        i++;
        out += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
        continue;
      }
      if (!para.length && /^ {4}/.test(line)) { // indented code
        const code = [];
        while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) code.push(lines[i++].slice(4));
        while (code.length && !code[code.length - 1].trim()) code.pop();
        out += "<pre><code>" + esc(code.join("\n")) + "</code></pre>";
        continue;
      }
      if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) { flush(); out += "<hr>"; i++; continue; }
      m = /^ {0,3}(#{1,6})\s*(.*?)\s*#*\s*$/.exec(line);
      if (m && m[2]) { flush(); out += `<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`; i++; continue; }
      if (/^ {0,3}>(?!!)/.test(line)) { // quote (">!" at a line start is a spoiler)
        flush();
        const q = [];
        while (i < lines.length && /^ {0,3}>(?!!)/.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}> ?/, ""));
        out += "<blockquote>" + mdBlocks(q, depth + 1) + "</blockquote>";
        continue;
      }
      m = MD_LIST_ITEM.exec(line);
      if (m) {
        flush();
        const ordered = /\d/.test(m[2]);
        const indent = m[1].length; // deeper-indented items belong to a nested list
        const sibling = (im) => im && im[1].length <= indent + 1 && /\d/.test(im[2]) === ordered;
        const items = [];
        let cur = null, loose = false;
        while (i < lines.length) {
          const l = lines[i];
          const im = MD_LIST_ITEM.exec(l);
          if (sibling(im)) { cur = [im[3]]; items.push(cur); i++; continue; }
          if (!l.trim()) { // a blank line ends the list unless more of it follows
            const nx = lines[i + 1];
            if (nx !== undefined && (new RegExp("^ {" + (indent + 2) + ",}\\S").test(nx) || sibling(MD_LIST_ITEM.exec(nx)))) { cur.push(""); loose = true; i++; continue; }
            break;
          }
          if (im && im[1].length <= indent + 1) break; // the other kind of list
          if (/^ {2,}/.test(l) || !/^ {0,3}(#|>|```|~~~)/.test(l)) { cur.push(l.replace(new RegExp("^ {1," + (indent + 4) + "}"), "")); i++; continue; }
          break;
        }
        const tag = ordered ? "ol" : "ul";
        out += `<${tag}>` + items.map((it) => {
          const inner = mdBlocks(it, depth + 1);
          return "<li>" + (loose ? inner : inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1")) + "</li>";
        }).join("") + `</${tag}>`;
        continue;
      }
      const sep = lines[i + 1];
      if (line.indexOf("|") >= 0 && sep !== undefined && sep.indexOf("-") >= 0 && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(sep)) {
        flush(); // table: a header row, then |---|:---:|
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const aligns = cells(sep).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : /^:-/.test(c) ? "left" : ""));
        const al = (k) => (aligns[k] ? ` align="${aligns[k]}"` : "");
        let t = "<table><thead><tr>" + cells(line).map((c, k) => `<th${al(k)}>${mdInline(c)}</th>`).join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) {
          t += "<tr>" + cells(lines[i]).map((c, k) => `<td${al(k)}>${mdInline(c)}</td>`).join("") + "</tr>";
          i++;
        }
        out += t + "</tbody></table>";
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out;
  }
  // A link target the preview may use: http(s), www., or a path on reddit
  // ("/r/x", "r/x", "/u/x"). `u` arrives HTML-escaped.
  function mdSafeHref(u) {
    const raw = String(u).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    if (/^https?:\/\/[^\s]/i.test(raw)) return raw;
    if (/^www\./i.test(raw)) return "https://" + raw;
    if (/^\/(?!\/)/.test(raw)) return raw;
    if (/^(r|u|user)\//i.test(raw)) return "/" + raw;
    if (MAILTO_RE.test(raw)) return raw;
    return null;
  }
  function mdInline(text) {
    const tokens = [];
    const keep = (html) => "\u0000" + (tokens.push(html) - 1) + "\u0000";
    let s = String(text);
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~^|<&])/g, (m, c) => keep(esc(c))); // backslash escapes
    s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, f, code) => keep("<code>" + esc(code.trim()) + "</code>"));
    s = esc(s);
    s = s.replace(/&amp;(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, "&$1;"); // entities the author typed
    s = s.replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, (m, label, url) => {
      const href = mdSafeHref(url);
      return href ? keep(`<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${mdEmph(label)}</a>`) : m;
    });
    s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<\u0000]*[^\s<\u0000.,:;!?)'*_~])/gi, (m, pre, url) => {
      const href = mdSafeHref(url);
      return href ? pre + keep(`<a href="${esc(href)}" target="_blank" rel="noopener nofollow">${url}</a>`) : m;
    });
    s = s.replace(/(^|[^\w.%+\-/\u0000])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24})(?![\w-])/g,
      (m, pre, em) => pre + keep(`<a href="mailto:${esc(em)}">${esc(em)}</a>`)); // emails, like Reddit
    s = s.replace(/(^|[^\w/\u0000])(\/?)((?:r|u)\/[A-Za-z0-9_][A-Za-z0-9_-]{1,20})(?![\w-])/g,
      (m, pre, slash, path) => pre + keep(`<a href="/${path}">${slash}${path}</a>`));
    s = mdEmph(s).replace(/ {2,}\n/g, "<br>");
    for (let n = 0; n < 4 && s.indexOf("\u0000") >= 0; n++) s = s.replace(/\u0000(\d+)\u0000/g, (m, k) => tokens[+k] || "");
    return s;
  }
  // Emphasis on already-escaped text (the tags added are fixed strings).
  function mdEmph(s) {
    return s
      .replace(/&gt;!(?=\S)([\s\S]*?\S)!&lt;/g, '<span class="md-spoiler-text">$1</span>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
      .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, "<strong><em>$2</em></strong>")
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
      .replace(/\*(?=\S)([\s\S]*?\S)\*/g, "<em>$1</em>")
      .replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/\^\(([^)\n]*)\)/g, "<sup>$1</sup>")
      .replace(/\^([^\s^(<\u0000]+)/g, "<sup>$1</sup>");
  }

  // ---------- inbox (testable) ------------------------------------------
  // Old reddit's /message/ pages, from /message/<box>.json (logged in).
  const MESSAGE_TABS = [["inbox", "all"], ["unread", "unread"], ["messages", "messages"], ["comments", "comment replies"],
    ["selfreply", "post replies"], ["mentions", "username mentions"], ["sent", "sent"]];
  function messageTabmenuHtml(where) {
    return `<ul class="tabmenu">` + MESSAGE_TABS.map(([w, label]) =>
      `<li class="${w === where ? "selected" : ""}"><a class="choice" href="/message/${w}/">${label}</a></li>`).join("") + `</ul>`;
  }
  // The post a comment-reply's context link points into (".../comments/<id>/<slug>/<comment>/?context=3").
  function messagePostPath(context) {
    const m = /^(\/r\/[^/]+\/comments\/[a-z0-9]+\/[^/?#]*\/?)/i.exec(String(context || ""));
    return m ? m[1].replace(/\/?$/, "/") : "";
  }
  // One inbox item: a comment reply / mention (t1, was_comment) or a private message (t4,
  // with its replies nested). opts.sent: the "sent" box (to <dest> instead of from <author>).
  function buildMessage(d, opts) {
    opts = opts || {};
    const isComment = !!d.was_comment;
    const iso = new Date((d.created_utc || 0) * 1000).toISOString();
    const bodyHtml = d.body_html ? d.body_html : d.body ? `<div class="md"><p>${esc(d.body)}</p></div>` : "";
    const ctx = /^\/(?!\/)/.test(d.context || "") ? d.context : ""; // (always a path on reddit)
    const postPath = isComment ? messagePostPath(ctx) : "";
    const kind = { comment_reply: "comment reply", post_reply: "post reply", username_mention: "username mention" }[d.type] || d.subject || "";
    const subject = isComment
      ? `${esc(kind)} <a class="title" href="${esc(postPath || ctx)}">${esc(d.link_title || "")}</a>`
      : esc(d.subject || "(no subject)");
    const who = opts.sent
      ? `to ${d.dest ? `<a href="/user/${esc(d.dest)}" class="author">${esc(d.dest)}</a>` : "[unknown]"}`
      : `from ${authorHtml(d.author || "[deleted]")}`;
    const via = d.subreddit ? ` via <a href="/r/${esc(d.subreddit)}/" class="subreddit">r/${esc(d.subreddit)}</a>` : "";
    const a = (cls, label) => `<a href="javascript:void(0)" class="${cls}" role="button">${label}</a>`;
    let buttons = "";
    if (isComment) {
      buttons += `<li class="first"><a href="${esc(ctx)}" class="bylink">context</a></li>`;
      if (postPath) buttons += `<li><a href="${esc(postPath)}" class="bylink">full comments${d.num_comments != null ? ` (${esc(d.num_comments)})` : ""}</a></li>`;
    }
    if (!opts.sent) {
      buttons += `<li class="${buttons ? "" : "first"}">${a("orr-markread", d.new ? "mark read" : "mark unread")}</li>`;
      buttons += `<li>${a("orr-reply orr-msg-reply", "reply")}</li>`;
    }
    const kids = childrenOf(d.replies);
    const childHtml = kids.map((c) => (c.data ? buildMessage(c.data, opts) : "")).join("");
    const vs = voteState(d);
    return (
      `<div class="thing message${d.new ? " new" : ""}${isComment ? " was-comment" : ""} id-${esc(d.name)}" id="thing_${esc(d.name)}"` +
      ` data-fullname="${esc(d.name)}" data-author="${esc(d.author || "")}" data-subreddit="${esc(d.subreddit || "")}"` +
      `${d.new ? ' data-new="true"' : ""}${isComment && d.score != null ? ` data-score="${esc(d.score)}"` : ""}>` +
      `<p class="subject">${subject}</p>` +
      (isComment ? midcolHtml(d, "") : "") +
      `<div class="entry ${vs}">` +
      `<p class="tagline"><span class="head">${who}${via} sent <time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time></span></p>` +
      `<div class="usertext-body">${bodyHtml}</div>` +
      `<ul class="flat-list buttons">${buttons}</ul>` +
      `</div>` +
      `<div class="child">${childHtml}</div>` +
      `<div class="clearleft"></div></div>`
    );
  }
  function buildMessagesPage(route, json, opts) {
    opts = opts || {};
    const listing = (json && json.data) || {};
    const children = listing.children || [];
    const startCount = opts.startCount || 0;
    const items = children.map((c) => (c.data ? buildMessage(c.data, { sent: route.where === "sent", nowMs: opts.nowMs }) : "")).join("");
    const count = startCount + children.length;
    const inner =
      buildHeader({
        tabmenu: messageTabmenuHtml(route.where),
        pageName: "messages",
        pageHref: "/message/inbox/",
        me: opts.me,
        route: { scope: "message" },
      }) +
      `<div class="side" role="complementary">${sideSearchHtml({ scope: "message" })}</div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      `<div id="siteTable" class="sitetable">` +
      (items || `<div class="thing"><p class="orr-empty">there doesn't seem to be anything here</p></div>`) +
      `</div>` +
      navButtonsHtml({ basePath: route.basePath }, listing, count, null, "") +
      `</div>`;
    return { className: "messages-page", inner };
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
    if (d.partial) {
      // Logged-out fallback: a stub that loads one of Reddit's more-comments HTML partials.
      const n = count ? ` (${esc(count)} ${count === 1 ? "reply" : "replies"})` : "";
      return (
        `<div class="morecomments"><a href="#" class="orr-more" data-link="${esc(linkId)}"` +
        ` data-partial="${esc(d.partial)}" data-cursor="${esc(d.cursor || "")}">load more comments${n}</a></div>`
      );
    }
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
    const vs = voteState(d);
    return (
      `<div class="thing comment id-${esc(d.name)}" id="thing_${esc(d.name)}" data-fullname="${esc(d.name)}" data-author="${esc(d.author)}" data-created="${esc(d.created_utc || 0)}"` +
      ` data-subreddit="${esc(d.subreddit || "")}"${d.score_hidden ? "" : ` data-score="${esc(d.score)}"`}${accountDataAttrs(d)}>` +
      `<span class="rank"></span>` +
      midcolHtml(d, "") +
      `<div class="entry ${vs}">` +
      `<p class="tagline"><a href="javascript:void(0)" class="expand" role="button" aria-expanded="true" aria-label="collapse">[&ndash;]</a> ` +
      authorHtml(d.author) +
      flairSpan("flair", d.author_flair_text, d.author_flair_richtext, d.author_flair_background_color, d.author_flair_text_color) +
      ` <span class="score ${vs}">${pts}</span> ` +
      `<time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time></p>` +
      `<div class="usertext-body">${bodyHtml}</div>` +
      `<ul class="flat-list buttons"><li class="first"><a href="${esc(d.permalink || "")}" class="bylink">permalink</a></li>${actionButtonsHtml(d, "comment")}</ul>` +
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
    const closed = !!(post && (post.archived || post.locked));

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
      `<div class="commentarea${closed ? " orr-noreply" : ""}">` +
      commentSortMenuHtml(permalink, opts.sort) +
      // logged in: old reddit's comment box (filled in by the runtime), or why there isn't one
      (closed
        ? `<div class="orr-li-only orr-closed-note">${post.archived
          ? "this is an archived post. you won't be able to vote or comment."
          : "comments are locked."}</div>`
        : linkId ? `<div class="orr-li-only orr-topform" data-thing="${esc(linkId)}"></div>` : "") +
      (opts.singleComment
        ? `<div class="infobar">you are viewing a single comment's thread. <a href="${esc(permalink)}">view the rest of the comments &rarr;</a></div>`
        : "") +
      `<div class="sitetable nestedlisting">${treeHtml || '<div class="thing">No comments yet.</div>'}</div>` +
      `</div></div>`;

    return { className: "comments-page", inner, sub, linkId };
  }

  // ---------- user profile builders (testable) -------------------------

  // "gilded" dropped — Reddit's API 404s it for other users (issue #25).
  const USER_TABS = ["overview", "submitted", "comments"];
  // Only you can see these, on your own profile (logged in).
  const OWN_USER_TABS = ["saved", "upvoted", "downvoted", "hidden"];
  // User pages sort via a ?sort= query param (like comments), not a path segment
  // like subreddit listings. top/controversial also take a time window (?t=).
  const USER_SORTS = ["new", "hot", "top", "controversial"];

  function userTabmenuHtml(route, myName) {
    const own = !!myName && myName.toLowerCase() === String(route.name || "").toLowerCase();
    const lis = (own ? USER_TABS.concat(OWN_USER_TABS) : USER_TABS).map((name) => {
      const href = "/user/" + route.name + (name === "overview" ? "/" : "/" + name + "/");
      const sel = route.section === name ? " selected" : "";
      return `<li class="${sel}"><a class="choice" href="${href}">${name}</a></li>`;
    }).join("");
    return `<ul class="tabmenu">${lis}</ul>`;
  }

  // Old-reddit-style "sorted by:" menu for a user page (issue #25). Sort is a
  // ?sort= query param; top/controversial additionally get a "links from:" window.
  function userSortMenuHtml(route, currentSort, currentT) {
    const cur = USER_SORTS.indexOf(currentSort) >= 0 ? currentSort : "new";
    const base = "/user/" + route.name + (route.section === "overview" ? "/" : "/" + route.section + "/");
    const boldSel = ' style="font-weight:bold;text-decoration:underline"';
    const sortLinks = USER_SORTS.map((s) => {
      const tq = (s === "top" || s === "controversial") && currentT ? "&t=" + esc(currentT) : "";
      return `<a href="${base}?sort=${s}${tq}"${s === cur ? boldSel : ""}>${s}</a>`;
    }).join(' <span class="separator">&middot;</span> ');
    let html = `<div class="menuarea" style="padding:5px 10px;font-size:small">sorted by: ${sortLinks}`;
    if (cur === "top" || cur === "controversial") {
      const tcur = currentT || "all"; // reddit's default window for a user's top/controversial
      const timeLinks = TIMES.map(([val, label]) =>
        `<a href="${base}?sort=${cur}&t=${val}"${val === tcur ? boldSel : ""}>${label}</a>`
      ).join(' <span class="separator">&middot;</span> ');
      html += ` <span class="separator">&middot;</span> links from: ${timeLinks}`;
    }
    return html + `</div>`;
  }

  // A comment as shown on a user page: with "on <post> in r/<sub>" context.
  function buildUserComment(d, opts) {
    opts = opts || {};
    const pts = d.score_hidden ? "score hidden" : `${esc(d.score)} point${d.score === 1 ? "" : "s"}`;
    const bodyHtml = d.body_html ? d.body_html : d.body ? `<div class="md"><p>${esc(d.body)}</p></div>` : "";
    const iso = new Date((d.created_utc || 0) * 1000).toISOString();
    const linkPermalink = d.permalink || d.link_permalink || "";
    const sub = d.subreddit || "";
    const vs = voteState(d);
    return (
      `<div class="thing comment id-${esc(d.name)}" id="thing_${esc(d.name)}" data-fullname="${esc(d.name)}"` +
      ` data-author="${esc(d.author)}" data-subreddit="${esc(sub)}"${d.score_hidden ? "" : ` data-score="${esc(d.score)}"`}${accountDataAttrs(d)}>` +
      midcolHtml(d, `<div class="score ${vs}">${esc(d.score)}</div>`) +
      `<div class="entry ${vs}">` +
      `<p class="tagline"><a href="/user/${esc(d.author)}" class="author">${esc(d.author)}</a> ` +
      `<span class="score ${vs}">${pts}</span> <time datetime="${esc(iso)}">${esc(formatAge(d.created_utc, opts.nowMs))}</time> ` +
      `on <a href="${esc(linkPermalink)}" class="bylink">${esc(d.link_title || "a post")}</a> ` +
      `in <a href="/r/${esc(sub)}/" class="subreddit">r/${esc(sub)}</a></p>` +
      `<div class="usertext-body">${bodyHtml}</div>` +
      `<ul class="flat-list buttons"><li class="first"><a href="${esc(linkPermalink)}" class="bylink">permalink</a></li>${actionButtonsHtml(d, "comment")}</ul>` +
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
    const timed = opts.sort === "top" || opts.sort === "controversial";
    let navExtra = "";
    if (opts.sort) navExtra += "&sort=" + encodeURIComponent(opts.sort);
    if (opts.t && timed) navExtra += "&t=" + encodeURIComponent(opts.t);
    const inner =
      buildHeader({
        tabmenu: userTabmenuHtml(route, (meIdentity(opts.me) || {}).name),
        pageName: route.name,
        pageHref: "/user/" + route.name + "/",
        me: opts.me,
        route: { scope: "user" },
      }) +
      `<div class="side" role="complementary">${sideSearchHtml({ scope: "user" })}</div>` +
      `<a name="content"></a>` +
      `<div class="content" role="main">` +
      userSortMenuHtml(route, opts.sort, opts.t) +
      `<div id="siteTable" class="sitetable">` +
      (items || `<div class="thing">${esc((json && json.orr_emptyText) || "Nothing here.")}</div>`) +
      `</div>` +
      navButtonsHtml({ basePath: route.basePath }, listing, count, null, navExtra) +
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
  // identity, or null when logged out. (The modhash for writes is read separately: myModhash.)
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
    // On a real single-subreddit page, this is the only "r/name" text on
    // screen you can act on without a listing mixing in other subs (e.g.
    // typing the URL directly) — give it the same .subreddit class the
    // hover-card favorite/filter controls already key off elsewhere.
    const subClass = opts.route && opts.route.scope === "sub" ? ' class="subreddit"' : "";
    return (
      `<div id="header" role="banner">` +
      srBarHtml(opts.route) +
      `<a href="/" id="header-img" class="default-header title">reddit</a>` +
      `<div id="header-bottom-left">` +
      `<span class="pagename redditname"><a${subClass} href="${esc(opts.pageHref || "/")}">${esc(opts.pageName || "reddit.com")}</a></span>` +
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

  // Hovering a search result peeks at the post: its picture, where a link post points,
  // and its text. The parts come from a t3's data (postPeekParts) or, logged in, from the
  // row's own hidden expando.
  function postPeekParts(d) {
    if (!d) return null;
    const g = d.is_gallery && d.gallery_data && d.gallery_data.items && d.gallery_data.items[0];
    const gm = g && d.media_metadata && d.media_metadata[g.media_id];
    const pv = d.preview && d.preview.images && d.preview.images[0] && d.preview.images[0].source;
    const x = d.crosspost_parent_list && d.crosspost_parent_list[0];
    const url = String(d.url || "");
    const own = /^https?:\/\/(www\.)?reddit\.com\//i.test(url) || /^https:\/\/(i|v)\.redd\.it\//i.test(url);
    return {
      img: d.orr_peek_img || (gm && gm.s && (gm.s.u || gm.s.gif)) || (pv && pv.url) || "",
      video: !!d.is_video,
      gallery: g ? d.gallery_data.items.length : 0,
      link: !d.is_self && /^https?:\/\//i.test(url) && !own ? url : "",
      html: d.selftext_html || (x && x.selftext_html) || "",
    };
  }
  function postPeekHtml(p) {
    if (!p) return '<div class="orr-peek-none">couldn\'t load this post</div>';
    let h = "";
    if (/^https:\/\//.test(p.img || ""))
      h += `<div class="orr-peek-media">${p.video ? '<span class="orr-peek-badge">&#9654; video</span>' : p.gallery > 1 ? `<span class="orr-peek-badge">${esc(p.gallery)} images</span>` : ""}<img src="${esc(p.img)}" alt=""></div>`;
    if (p.link) h += `<div class="orr-peek-link">${esc(p.link.replace(/^https?:\/\/(www\.)?/i, "").slice(0, 120))}</div>`;
    if (p.html) h += `<div class="orr-peek-text">${p.html}</div>`; // (a post body: already sanitised markup)
    return h || '<div class="orr-peek-none">no description</div>';
  }

  globalThis.ORR_REBUILD = {
    esc, formatAge, thumbnailHtml, isImageUrl, postExpando, buildItem, tabmenuHtml, navButtonsHtml, timeMenuHtml, buildBody,
    bucketForDays, bucketForHours, daysSince, hoursSince, shareLinkFor, buildSharePanel, postType, foldReadSubtrees,
    formatNumber, buildSidebar, commentSortMenuHtml, childrenOf, buildMore, buildComment, buildCommentTree, buildCommentsBody,
    userTabmenuHtml, buildUserComment, buildUserPage, buildUserSidebar,
    meIdentity, userbarLoggedIn, userbarLoggedOut, srBarHtml, searchFormHtml, sideSearchHtml, buildHeader,
    searchJsonUrl, searchHref, buildSearchPage, buildWikiPage,
    parseHtmlDoc, cleanMd, isoToUtc, postFromShreddit, commentsFromHtml, htmlListingPath, profileCommentFromShreddit, htmlUserPath,
    packagedMp4, stickiesFromHtml, railFromHtml, buildRailSidebar, buildAgeGate, userHoverFromHtml, subHoverFromHtml, parseCount,
    voteState, midcolHtml, actionButtonsHtml, editorHtml, mdPreview, buildMessage, buildMessagesPage, messageTabmenuHtml, messagePostPath,
    commentBlock, linkifyEmails, canonicalThreadPath, searchPostsFromHtml, htmlSearchPath, postPeekParts, postPeekHtml,
  };

  // ---------- runtime driver -------------------------------------------

  const CSS_URL = api.runtime.getURL("vendor/oldreddit.bundled.css");
  const GUARD_ID = "orr-rebuild-guard";
  const CSS_ID = "orr-rebuild-css";
  const cache = new Map(); // jsonUrl -> { json, t }
  const CACHE_TTL = 60000;
  let active = false; // rebuild currently owns the page
  let wired = false;

  // New Reddit's own router is still loaded under the rebuilt page and listens for
  // navigations (Navigation API): on every page we navigate to in-page it fetched that
  // page again for itself, and on /message/… it could send you off to /login. While the
  // rebuilt page is up, navigations on reddit are ours — this listener is registered at
  // document_start, before Reddit's, so it can stop Reddit's from running. (A navigation
  // we don't handle then simply loads as a normal page.)
  try {
    if (typeof navigation !== "undefined" && navigation && navigation.addEventListener) {
      navigation.addEventListener("navigate", (e) => {
        if (!active || e.hashChange || e.downloadRequest || e.navigationType === "reload") return;
        let dest;
        try { dest = new URL(e.destination.url); } catch (err) { return; }
        if (dest.origin === location.origin) e.stopImmediatePropagation();
      });
    }
  } catch (e) { /* no Navigation API (older Firefox): nothing to stop */ }

  // Respect the OS "reduce motion" setting for our scrolling/animation.
  const REDUCED_MOTION = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SB = REDUCED_MOTION ? "auto" : "smooth";

  // Logged-in identity for the header (fetched once).
  let mePromise = null;
  let meCached; // undefined = not fetched, null = logged out, object = raw me.json

  function fetchMe() {
    if (mePromise) return mePromise;
    mePromise = redditFetch(location.origin + "/api/me.json")
      // A hiccup (rate limit, server error, network) isn't "logged out": keep who we
      // knew you were rather than hiding every account button until the next page.
      .then((r) => (r.ok ? r.json() : meCached && (r.status === 429 || r.status >= 500) ? meCached : null))
      .then((j) => {
        meCached = j && (j.name || (j.data && j.data.name)) ? j : null;
        applyLoginState();
        return meCached;
      })
      .catch(() => {
        if (!meCached) meCached = null;
        return meCached;
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

  // The pages infinite scroll added, per page (scrollKey), so Back can put them back before
  // restoring where you were. Without them only the first page re-renders, a deep scroll
  // position no longer exists, and you land near the top with the post you came from gone.
  const infPages = new Map(); // scrollKey → { chunks: [itemsHtml…], after, count } (most recent last)
  const INF_PAGES_KEEP = 6;
  let historyNavKey = null; // the page a Back/Forward is re-rendering (set by popstate)
  function rememberInfPage(html, after, count) {
    const key = scrollKey();
    const rec = infPages.get(key) || { chunks: [] };
    infPages.delete(key);
    infPages.set(key, rec);
    if (html) rec.chunks.push(html);
    rec.after = after;
    rec.count = count;
    while (infPages.size > INF_PAGES_KEEP) infPages.delete(infPages.keys().next().value);
  }
  // On Back/Forward: put this page's extra pages back (skipping anything already shown)
  // and carry on from where infinite scroll had got to. A fresh visit starts over.
  function restoreInfPages(st) {
    const key = scrollKey();
    const restoring = historyNavKey === key;
    historyNavKey = null;
    const rec = infPages.get(key);
    if (!restoring || !rec) { infPages.delete(key); return; }
    const table = document.getElementById("siteTable");
    if (!table || !rec.chunks.length) return;
    const tmp = document.createElement("div");
    rec.chunks.forEach((h) => tmp.insertAdjacentHTML("beforeend", h));
    tmp.querySelectorAll(":scope > .thing[id]").forEach((t) => { if (document.getElementById(t.id)) t.remove(); });
    while (tmp.firstChild) table.appendChild(tmp.firstChild);
    enhanceNewItems(table);
    st.after = rec.after;
    st.count = rec.count;
    if (!st.after) teardownInfinite(); // it had reached the end
  }

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
    if (!infiniteOn || !after) { historyNavKey = null; return; }
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
    const st0 = infState;
    restoreInfPages(st0); // Back/Forward: the pages you'd scrolled through
    if (infState !== st0) return; // (they reached the end: nothing more to load)
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
      rememberInfPage(res.itemsHtml, st.after, st.count);
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
  let autoplayOn = false, hideReadOn = false, autoCollapseBotsOn = false, nightAutoOn = false;
  let foldReadCommentsOn = false, trackRecentSubsOn = true;
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
    // phones / tablets keep fit-to-width (no zoom-in minimum width)
    el.classList.toggle("orr-touch-ua", typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ""));
  }
  // Auto night mode on a simple local-time schedule (dark 8pm–7am).
  function applyNightSchedule() {
    if (!nightAutoOn) return;
    const h = new Date().getHours();
    nightModeOn = h >= 20 || h < 7;
  }

  // No per-subreddit custom CSS: those stylesheets were written against old
  // Reddit's exact DOM and broke our rebuild (e.g. r/todayilearned), so every page
  // uses the standard old-reddit style.

  const ENHANCE_CSS = `
.usertext-body .md img, .usertext-body .md video { max-width:100%; height:auto; }
.orr-locked { color:#888; }
/* Reddit's scripts add Google's reCAPTCHA badge for logged-out visitors; on the rebuilt page it just covers our corner buttons */
html.orr-rebuilt .grecaptcha-badge { visibility:hidden !important; }
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
#orr-mute-all { position:fixed; top:16px; right:16px; z-index:2147483000; background:rgba(0,0,0,.55); color:#fff;
  border:none; border-radius:4px; padding:4px 9px; font-size:18px; line-height:1.5; cursor:pointer; display:none; }
#orr-mute-all:hover { background:rgba(0,0,0,.82); }
#orr-mute-all.show { display:block; }
.orr-usertag { display:inline-block; padding:0 4px; margin:0 2px; border-radius:3px; font-size:10px; line-height:normal; color:#fff; vertical-align:baseline; }
/* quick filter/tag actions next to a tagline's author / "to r/sub" link (styled like "locked") */
a.orr-qa { margin-left:5px; color:#999; text-decoration:none; white-space:nowrap; cursor:pointer; opacity:0; transition:opacity .1s; }
/* only while hovering/focusing that post or comment, so taglines stay as plain as old reddit's
   (opacity, not visibility: the space is kept so nothing shifts, and the icons stay keyboard-focusable) */
.thing.link:hover a.orr-qa, .thing.comment > .entry:hover a.orr-qa, .tagline:focus-within a.orr-qa { opacity:1; }
@media (hover: none) { a.orr-qa { opacity:1; } }
a.orr-qa:hover { color:#555; }
a.orr-qa[data-qa="filter"]:hover { color:#d93025; }
a.orr-qa svg { width:11px; height:11px; vertical-align:-2px; }
#orr-toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:2147483000; max-width:90vw;
  padding:8px 14px; border-radius:4px; background:#333; color:#fff; font:13px verdana,arial,sans-serif; box-shadow:0 2px 10px rgba(0,0,0,.3); }
#orr-toast a { color:#8cf; font-weight:bold; margin-left:10px; cursor:pointer; }
#orr-hovercard { position:fixed; z-index:2147483000; max-width:320px; background:#fff; color:#000; border:1px solid #5f99cf;
  border-radius:3px; padding:8px; font:11px verdana; box-shadow:0 2px 10px rgba(0,0,0,.35); line-height:1.5; }
#orr-hovercard .orr-tagbtn, #orr-hovercard .orr-favbtn, #orr-hovercard .orr-filterbtn { color:#369; cursor:pointer; text-decoration:underline; }
.thing.comment.orr-new > .entry > .tagline:after { content:" \\2022 new"; color:#ff4500; font-weight:bold; }
/* issue #16: "N new" badge on visited posts, + grey read comments when folding */
li.orr-newcount-li a.orr-newcount { color:#ff4500; font-weight:bold; }
.commentarea.orr-foldread .thing.comment:not(.orr-new) > .entry > .tagline,
.commentarea.orr-foldread .thing.comment:not(.orr-new) > .entry > .usertext-body { opacity:.55; }
/* clamp read comments to a few lines; click a long one to expand it (RES-style, saves space) */
.commentarea.orr-foldread .thing.comment:not(.orr-new):not(.orr-read-open) > .entry > .usertext-body { max-height:4.2em; overflow:hidden; }
.commentarea.orr-foldread .thing.comment.orr-clamped:not(.orr-read-open) > .entry > .usertext-body { cursor:pointer; position:relative; }
.commentarea.orr-foldread .thing.comment.orr-clamped:not(.orr-read-open) > .entry > .usertext-body:after {
  content:"… click to expand"; position:absolute; left:0; right:0; bottom:0; padding:1.4em 2px 0 0; text-align:right; font-size:11px;
  color:#369; background:linear-gradient(rgba(255,255,255,0), #fff 65%); pointer-events:none; }
.orr-gimg { display:none; max-width:100%; height:auto; }
.orr-gimg.active { display:block; }
.orr-gnav-bar { margin:4px 0; font-size:12px; }
a.orr-gnav { color:#369; text-decoration:none; margin:0 6px; cursor:pointer; }
.orr-inline-img { margin:4px 0; display:inline-block; overflow:hidden; resize:both; max-width:100%; line-height:0; border:1px solid #ccc; }
.orr-inline-img img { width:100%; height:100%; object-fit:contain; display:block; }
/* embeds + direct video */
.orr-embed { width:640px; max-width:100%; height:360px; border:0; display:block; background:#000; }
.orr-embed-gate { width:640px; max-width:100%; padding:10px 12px; border:1px solid #ccc; background:#f7f7f8; font-size:12px; line-height:1.5; }
html.orr-night .orr-embed-gate { background:#272729; border-color:#343536; color:#d7dadc; }
.orr-embed-gate p { margin:0 0 6px; }
.orr-embed-gate .orr-embed-allow { font-size:11px; padding:3px 8px; margin-right:8px; }
.orr-embed-gate a { color:#369; }
.orr-oembed { max-width:550px; overflow:hidden; }
.orr-oembed img, .orr-oembed video { max-width:100%; height:auto; display:block; }
.orr-oembed-quote { border:1px solid #ccc; border-left:3px solid #5f99cf; border-radius:3px; padding:8px 12px; background:#fff; font-size:13px; line-height:1.5; }
html.orr-night .orr-oembed-quote { background:#1a1a1b; border-color:#343536; color:#d7dadc; }
.orr-oembed-author { font-weight:bold; margin-bottom:4px; }
.orr-oembed-text { white-space:pre-wrap; word-wrap:break-word; }
.orr-oembed-link { display:inline-block; margin-top:6px; color:#369; font-size:11px; }
.orr-directvideo { max-width:100%; height:auto; display:block; background:#000; }
/* reddit video wrapper (dash.js gives it a real audio track, so native
   volume/mute controls work — no custom mute button needed) */
.orr-video-wrap { position:relative; display:inline-block; line-height:0; max-width:100%; }
.orr-video-wrap video { max-width:100%; }
/* video niceties: playback-speed + loop controls, shown below the player */
.orr-vctl { line-height:normal; margin-top:3px; display:flex; gap:5px; }
.orr-vctl button { background:#eee; color:#333; border:1px solid #ccc; border-radius:3px; font:11px verdana,sans-serif; padding:2px 7px; cursor:pointer; }
.orr-vctl button:hover { background:#e2e2e2; }
.orr-vctl .orr-vloop.on { background:#ff4500; color:#fff; border-color:#ff4500; }
/* content-width & font-size sliders (Options) */
html.orr-custom-width body { max-width:var(--orr-content-width); margin-left:auto; margin-right:auto; }
/* Zoomed in (fewer CSS pixels across), the 300px sidebar used to squeeze posts and comments
   into a one-word-wide column with nothing to scroll to. Keep a readable minimum width so
   the page overflows and scrolls sideways instead (trackpad / shift+wheel). Your custom
   content width wins if it's narrower; phones and tablets (html.orr-touch-ua) keep their
   own fit-to-width. (Not a hover/pointer media query: Chrome on Linux can report a
   touchpad laptop as hover:none.) */
html.orr-rebuilt:not(.orr-touch-ua) body { min-width:min(820px, var(--orr-content-width, 820px)); }
/* …and let it scroll: new Reddit's styles that survive the purge (styles its components
   attach to the document, <style class=…>, inline styles on <html>) can set overflow
   hidden on html/body — clipping whatever is off-screen, with no scrollbar. The image
   viewer and the big editor still lock scrolling while open. */
html.orr-rebuilt:not(.orr-lb-open):not(.orr-bigedit-open) { overflow:visible !important; }
html.orr-rebuilt body { overflow:visible !important; }
/* pinch zoom: our horizontal scrollbar for the magnified view (sized/placed by placePinchBar) */
#orr-pinchbar { position:absolute; z-index:2147483600; display:none; margin:0; padding:0; box-sizing:border-box; background:rgba(0,0,0,.12); cursor:pointer; touch-action:none; }
#orr-pinchbar .orr-pinchbar-thumb { position:absolute; background:rgba(0,0,0,.45); cursor:grab; }
#orr-pinchbar .orr-pinchbar-thumb:hover, #orr-pinchbar.orr-dragging .orr-pinchbar-thumb { background:rgba(0,0,0,.62); }
#orr-pinchbar.orr-dragging .orr-pinchbar-thumb { cursor:grabbing; }
html.orr-night #orr-pinchbar { background:rgba(255,255,255,.14); }
html.orr-night #orr-pinchbar .orr-pinchbar-thumb { background:rgba(255,255,255,.5); }
html.orr-custom-font #siteTable, html.orr-custom-font .commentarea { zoom:var(--orr-font-scale); }
/* image lightbox */
html.orr-lb-open { overflow:hidden; }
#orr-lightbox { position:fixed; inset:0; z-index:2147483640; background:rgba(0,0,0,.9); display:flex; align-items:center; justify-content:center; }
#orr-lightbox #orr-lb-img { max-width:95vw; max-height:92vh; transform-origin:center; user-select:none; box-shadow:0 4px 40px rgba(0,0,0,.6); }
#orr-lightbox .orr-lb-bar { position:absolute; top:0; left:0; right:0; height:38px; z-index:1; display:flex; align-items:center; gap:14px; padding:0 14px; color:#fff; font:13px verdana,sans-serif; background:linear-gradient(rgba(0,0,0,.55),transparent); }
#orr-lightbox #orr-lb-count { margin-right:auto; }
#orr-lightbox .orr-lb-bar a { color:#8cf; text-decoration:none; }
#orr-lightbox .orr-lb-close { background:none; border:none; color:#fff; font-size:20px; cursor:pointer; line-height:1; }
#orr-lightbox .orr-lb-prev, #orr-lightbox .orr-lb-next { position:absolute; top:50%; transform:translateY(-50%); z-index:1; background:rgba(0,0,0,.4); color:#fff; border:none; font-size:40px; width:52px; height:82px; cursor:pointer; }
#orr-lightbox .orr-lb-prev { left:0; } #orr-lightbox .orr-lb-next { right:0; }
#orr-lightbox .orr-lb-prev:hover, #orr-lightbox .orr-lb-next:hover { background:rgba(0,0,0,.7); }
/* RES-style hover preview */
#orr-hoverimg { position:fixed; z-index:2147483630; display:none; pointer-events:none; background:#fff; border:1px solid #888; box-shadow:0 4px 20px rgba(0,0,0,.4); padding:2px; }
#orr-hoverimg img { display:block; max-width:44vw; max-height:80vh; }
/* search results: hover peek at a post (picture, link, text) */
#orr-hoverpost { position:fixed; z-index:2147483630; display:none; pointer-events:none; box-sizing:border-box; width:min(520px, 46vw);
  max-height:80vh; overflow:hidden; background:#fff; color:#222; border:1px solid #888; box-shadow:0 4px 20px rgba(0,0,0,.4);
  padding:8px 10px; font:12px verdana,arial,sans-serif; line-height:1.45; }
#orr-hoverpost .orr-peek-media { position:relative; margin-bottom:6px; }
#orr-hoverpost .orr-peek-media:not(.orr-peek-loaded) { min-height:120px; background:#eee; }
#orr-hoverpost .orr-peek-media:not(.orr-peek-loaded):before { content:"loading image\\2026"; position:absolute; left:8px; top:8px; color:#888; font-style:italic; }
#orr-hoverpost .orr-peek-media img { display:block; max-width:100%; max-height:45vh; margin:0 auto; }
#orr-hoverpost .orr-peek-badge { position:absolute; left:4px; top:4px; padding:1px 6px; border-radius:3px; background:rgba(0,0,0,.65); color:#fff; font-size:11px; }
#orr-hoverpost .orr-peek-link { color:#888; margin-bottom:6px; word-break:break-all; }
#orr-hoverpost .orr-peek-none { color:#888; font-style:italic; }
#orr-hoverpost .md { font-size:12px; max-width:none; }
#orr-hoverpost .md img { max-width:100%; height:auto; }
#orr-hoverpost.orr-peek-clipped:after { content:"\\2026 open the post to read the rest"; position:absolute; left:0; right:0; bottom:0;
  padding:22px 10px 6px; background:linear-gradient(rgba(255,255,255,0), #fff 55%); color:#888; font-style:italic; }
.orr-pdf { width:100%; height:80vh; background:#fff; }
.orr-directaudio { width:100%; max-width:640px; display:block; }
/* post expando images/videos scale to fit the window (never cut off); click opens the lightbox */
.orr-resizable { display:inline-block; overflow:hidden; max-width:100%; line-height:0; cursor:zoom-in; }
.orr-resizable img.preview { max-width:100%; max-height:80vh; width:auto; height:auto; object-fit:contain; display:block; }
.orr-gimg { max-width:100%; max-height:80vh; width:auto; height:auto; object-fit:contain; }
.orr-video-wrap video, .expando video, video.orr-directvideo { max-width:100%; max-height:80vh; height:auto; }
/* "Watch on Reddit" fallback for v.redd.it videos Reddit won't serve us */
.orr-video-fallback { position:relative; display:inline-block; max-width:100%; min-width:320px; min-height:180px; background:#000; line-height:0; border-radius:3px; overflow:hidden; }
.orr-video-fallback .orr-video-poster { max-width:100%; max-height:80vh; display:block; opacity:.55; }
.orr-video-fallback .orr-watch-reddit { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
  background:rgba(0,0,0,.78); color:#fff; padding:10px 16px; border-radius:6px; font:bold 14px verdana,sans-serif;
  text-decoration:none; line-height:normal; white-space:nowrap; }
.orr-video-fallback .orr-watch-reddit:hover { background:#d93a00; }
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
#orr-cnav button:focus-visible, #orr-help-btn:focus-visible,
#orr-top:focus-visible, #orr-mute-all:focus-visible, .thing:focus-visible, a.orr-more:focus-visible {
  outline:2px solid #ff4500; outline-offset:2px; }
@media (prefers-reduced-motion: reduce) {
  .orr-flash, #orr-skeleton .orr-sk-line, #orr-skip { animation:none !important; transition:none !important; }
}
/* flair */
.linkflairlabel { display:inline-block; background:#ddd; border:1px solid #ccc; border-radius:3px; padding:0 4px; margin:0 2px; font-size:x-small; color:#555; vertical-align:middle; }
.tagline .flair { display:inline-block; background:#eef; border:1px solid #ccd; border-radius:3px; padding:0 4px; font-size:x-small; color:#556; }
.orr-flair-emoji { height:1em; width:auto; vertical-align:text-bottom; }
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
html.orr-night .orr-other-box { background:#242526; border-color:#343536; }
/* logged-in actions: shown only when logged in; edit/delete only on your own things */
html:not(.orr-logged-in) .orr-li-only { display:none !important; }
.flat-list > .orr-own-only { display:none !important; }
html.orr-logged-in .thing.orr-mine > .entry .flat-list > .orr-own-only { display:inline !important; }
html.orr-logged-in .thing.orr-mine > .entry .flat-list > .orr-not-own { display:none !important; }
.commentarea.orr-noreply .orr-reply-li { display:none !important; }
.thing > .midcol > .arrow { cursor:pointer; }
.thing > .midcol > .arrow:focus-visible { outline:2px solid #5f99cf; outline-offset:1px; }
.thing.orr-hidden-post { display:none !important; }
.orr-closed-note { margin:8px 10px; padding:6px 10px; max-width:600px; color:#555; background:#f6f6f6; border:1px solid #e3e3e3; border-radius:3px; font-size:12px; }
.orr-topform { margin:6px 0 10px 10px; }
.orr-editor { margin:6px 0 10px; }
.orr-editor .usertext-edit { width:auto; max-width:600px; }
.orr-editor .usertext-edit textarea { width:100%; box-sizing:border-box; height:100px; min-height:60px; resize:vertical; font:13px/1.4 verdana,arial,sans-serif; padding:4px; }
.orr-editor .usertext-buttons { margin-top:5px; }
.orr-editor .usertext-buttons button { margin-right:4px; }
.orr-editor .status { font-size:small; margin-left:6px; color:#555; }
.orr-editor .status.error, .orr-reportform .status.error { color:#c00; }
.orr-ed-preview-box { margin-top:6px; padding-top:4px; border-top:1px dotted #c0c0c0; }
.orr-ed-label { font-size:x-small; color:#888; text-transform:uppercase; letter-spacing:.05em; }
.orr-ed-preview { padding:4px 0; }
.orr-editor.orr-bigedit { position:fixed; inset:4vh 4vw; z-index:2147483500; margin:0; padding:12px; background:#fff; border-radius:6px; box-shadow:0 8px 40px rgba(0,0,0,.45); overflow:auto; }
.orr-editor.orr-bigedit .usertext-edit { max-width:none; height:100%; box-sizing:border-box; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr auto auto; gap:0 14px; }
.orr-editor.orr-bigedit .usertext-edit > .md { grid-column:1; grid-row:1; }
.orr-editor.orr-bigedit .usertext-edit textarea { height:100%; min-height:240px; resize:none; }
.orr-editor.orr-bigedit .bottom-area, .orr-editor.orr-bigedit .orr-markhelp { grid-column:1; }
.orr-editor.orr-bigedit .orr-ed-preview-box { display:block !important; grid-column:2; grid-row:1 / span 3; margin:0; border:0; overflow:auto; }
html.orr-bigedit-open { overflow:hidden; }
@media (max-width:700px) {
  .orr-editor.orr-bigedit .usertext-edit { grid-template-columns:1fr; grid-template-rows:minmax(200px,1fr) auto auto auto; }
  .orr-editor.orr-bigedit .orr-ed-preview-box { grid-column:1; grid-row:auto; }
}
.orr-reportform { margin:6px 0 8px; padding:8px 10px; max-width:460px; background:#f6f7f8; border:1px solid #e0e0e0; border-radius:3px; font-size:12px; }
.orr-reportform .orr-rf-title { font-weight:bold; margin-bottom:4px; }
.orr-reportform .orr-rf-group { margin:6px 0 2px; color:#555; }
.orr-reportform .orr-rf-opt { display:block; margin:2px 0; cursor:pointer; }
.orr-reportform input[type=text] { width:240px; max-width:100%; font-size:12px; }
.orr-reportform .orr-rf-buttons { margin-top:6px; }
.orr-rf-done, .orr-sent-note { margin:4px 0; color:#2e8b3a; font-size:12px; }
a.orr-reported { color:#888 !important; cursor:default; text-decoration:none !important; }
.orr-del-confirm { color:#c00; }
.orr-uservotes { margin-left:3px; font-size:x-small; font-weight:bold; }
.orr-uservotes.orr-uv-pos { color:#ff8b60; }
.orr-uservotes.orr-uv-neg { color:#9494ff; }
.messages-page .orr-empty { margin:10px; color:#888; }
html.orr-night .orr-editor textarea, html.orr-night .orr-reportform input[type=text] { background:#111 !important; color:#d7dadc !important; border-color:#474748 !important; }
html.orr-night .orr-editor.orr-bigedit, html.orr-night .orr-reportform, html.orr-night .orr-closed-note { background:#242526 !important; border-color:#343536 !important; color:#d7dadc !important; }
html.orr-night .message.new > .entry { background:#2a2b2c !important; border-color:#343536 !important; }
html.orr-night .orr-markhelp tr:first-child { background:#3a3a1f !important; }
html.orr-night .orr-markhelp td { border-color:#474748 !important; }
html.orr-night .link .midcol .score.likes { color:#ff8b60 !important; }
html.orr-night .link .midcol .score.dislikes { color:#9494ff !important; }`;

  const NIGHT_CSS = `
html.orr-night, html.orr-night body, html.orr-night .content, html.orr-night #siteTable,
html.orr-night .commentarea, html.orr-night shreddit-app { background:#1a1a1b !important; color:#d7dadc !important; }
html.orr-night a, html.orr-night a * { color:#6cb0ff !important; }
html.orr-night a:visited, html.orr-night a:visited * { color:#b39ddb !important; }
html.orr-night .thing, html.orr-night .thing.comment { background:transparent !important; }
html.orr-night .thing { border-color:#343536 !important; }
html.orr-night .tagline, html.orr-night .domain, html.orr-night .score, html.orr-night .rank { color:#818384 !important; }
html.orr-night .md, html.orr-night .usertext-body, html.orr-night .md * { background:transparent !important; color:#d7dadc !important; }
html.orr-night .commentarea.orr-foldread .thing.comment.orr-clamped:not(.orr-read-open) > .entry > .usertext-body:after {
  background:linear-gradient(rgba(26,26,27,0), #1a1a1b 65%) !important; color:#6ca6e0; }
html.orr-night .side .spacer > *, html.orr-night .titlebox, html.orr-night .sidecontentbox {
  background:#242526 !important; border-color:#343536 !important; color:#d7dadc !important; }
html.orr-night #search input[type=text] { background:#111 !important; color:#d7dadc !important; border-color:#474748 !important; }
html.orr-night #header { background:#20303f !important; border-color:#14202b !important; }
html.orr-night .tabmenu li a, html.orr-night #header-bottom-right, html.orr-night #header-bottom-right a { color:#d7dadc !important; }
html.orr-night #header-bottom-right { background:#2a2f31 !important; }
html.orr-night .thing.comment .child { border-color:#343536 !important; }
html.orr-night #orr-hovercard { background:#242526 !important; color:#d7dadc !important; }
html.orr-night #orr-hoverpost { background:#1a1a1b !important; color:#d7dadc !important; border-color:#474748 !important; }
html.orr-night #orr-hoverpost .orr-peek-media:not(.orr-peek-loaded) { background:#272729; }
html.orr-night #orr-hoverpost.orr-peek-clipped:after { background:linear-gradient(rgba(26,26,27,0), #1a1a1b 55%); }
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
    if (!document.getElementById("orr-mute-all")) {
      const m = document.createElement("button");
      m.id = "orr-mute-all";
      m.type = "button";
      m.addEventListener("click", () => setVideoMuted(!orrVideoMuted));
      document.body.appendChild(m);
      paintMuteAllBtn();
    }
    updateMuteAllVisibility();
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
    const sel = inComments ? ".nestedlisting > .thing.comment" : "#siteTable > .thing.link:not(.orr-filtered):not(.orr-hidden-post)";
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
  // Collapsing via CSS doesn't pause embedded media — same issue the
  // post-level expando toggle handles. A comment can carry a v.redd.it/direct
  // <video> or an external embed <iframe> (expandCommentMedia), either of
  // which keeps playing (and, for an iframe, keeps making sound) while hidden.
  //
  // For iframes: blanking .src (the obvious approach) isn't reliable — some
  // embedded players (confirmed: YouTube's) can keep playing audio briefly or
  // indefinitely afterward regardless. Fully detaching the iframe is the one
  // technique guaranteed to tear down whatever the embedded page was doing;
  // its markup is saved on a placeholder so it can be recreated on restore.
  function stopHiddenMedia(root) {
    if (!root) return;
    root.querySelectorAll("video").forEach((v) => { v.dataset.orrWant = "pause"; try { v.pause(); } catch (e) {} });
    root.querySelectorAll("iframe.orr-embed").forEach((f) => {
      const placeholder = document.createElement("span");
      placeholder.className = "orr-embed-removed";
      placeholder.dataset.orrHtml = f.outerHTML;
      f.replaceWith(placeholder);
    });
  }
  function resumeHiddenMedia(root) {
    if (!root) return;
    root.querySelectorAll(".orr-embed-removed").forEach((ph) => {
      const html = ph.dataset.orrHtml;
      if (html) ph.outerHTML = html;
    });
  }

  // Wires the "Enable X previews" button in oembedGatedEmbed() placeholders and
  // upgrades any already-permitted placeholders by fetching the oEmbed data and
  // rendering it natively (see renderOembedNode; the fetch happens in background.js,
  // not here, since a content-script fetch is also bound by the page's CSP
  // connect-src). Scoped per platform: granting Bluesky must never silently also
  // grant Twitter/X.
  const embedPermissionCache = {}; // platform -> boolean; absent = not checked yet
  function checkEmbedPermission(platform) {
    if (embedPermissionCache[platform] !== undefined) return Promise.resolve(embedPermissionCache[platform]);
    return Promise.resolve(api.runtime.sendMessage({ type: "orr-check-embed-permission", platform }))
      .then((res) => { embedPermissionCache[platform] = !!(res && res.granted); return embedPermissionCache[platform]; })
      .catch(() => false);
  }
  // Render an oEmbed preview WITHOUT ever injecting the provider's HTML into the
  // live page — that would be an XSS hole on the logged-in reddit.com origin
  // (stripping <script> is not enough: onerror/onload attributes, iframes, and
  // javascript: URLs all survive and activate on insertion). Quote text is read
  // out of the provider markup in an INERT DOMParser document — no browsing
  // context, so nothing loads, no script runs, no handler fires — and re-emitted
  // as textContent; links and media are rebuilt with scheme-validated attributes.
  function safeHttpUrl(u) {
    try { const p = new URL(u, location.href); return (p.protocol === "https:" || p.protocol === "http:") ? p.href : null; }
    catch (e) { return null; }
  }
  function externalLinkNode(href, label, msg) {
    const div = document.createElement("div");
    div.className = "expando-container orr-embed-gate";
    const p = document.createElement("p");
    p.textContent = msg || ("Reddit blocks " + label + " previews from loading inline.");
    div.appendChild(p);
    const safe = safeHttpUrl(href);
    if (safe) {
      const a = document.createElement("a");
      a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = "open on " + label + " instead ↗";
      div.appendChild(a);
    }
    return div;
  }
  function oembedQuoteText(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(String(html || ""), "text/html"); }
    catch (e) { return ""; }
    const el = doc.querySelector("blockquote p") || doc.querySelector("blockquote") || doc.body;
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }
  function renderOembedNode(data, href, label) {
    if (!data) return null;
    if (data.kind === "media") {
      const url = safeHttpUrl(data.url);
      if (!url) return null;
      const wrap = document.createElement("div");
      wrap.className = "expando-container orr-oembed";
      const w = Number.isFinite(data.width) ? data.width : 480;
      let media;
      if (data.mediaType === "video") {
        media = document.createElement("video");
        media.controls = true; media.loop = true; media.preload = "metadata";
        const s = document.createElement("source"); s.src = url; media.appendChild(s);
      } else {
        media = document.createElement("img");
        media.src = url;
        if (Number.isFinite(data.height)) media.height = data.height;
      }
      media.width = w;
      // If reddit's own img-src/media-src blocks the provider host, the load
      // fails — degrade to a plain link rather than a broken frame.
      media.addEventListener("error", () => {
        if (wrap.isConnected) wrap.replaceWith(externalLinkNode(href, label, "Couldn't load the " + label + " preview."));
      }, { once: true });
      wrap.appendChild(media);
      return wrap;
    }
    // quote providers (bluesky, twitter)
    const text = oembedQuoteText(data.html);
    const author = typeof data.author === "string" ? data.author.trim() : "";
    if (!text && !author) return null;
    const wrap = document.createElement("div");
    wrap.className = "expando-container orr-oembed orr-oembed-quote";
    if (author) { const a = document.createElement("div"); a.className = "orr-oembed-author"; a.textContent = author; wrap.appendChild(a); }
    if (text) { const t = document.createElement("div"); t.className = "orr-oembed-text"; t.textContent = text; wrap.appendChild(t); }
    const safe = safeHttpUrl(href);
    if (safe) {
      const a = document.createElement("a");
      a.className = "orr-oembed-link"; a.href = safe; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = "View on " + label + " ↗";
      wrap.appendChild(a);
    }
    return wrap;
  }
  function upgradeEmbedGate(gate) {
    if (gate.dataset.orrUpgrading) return; // don't double-fetch if wireEmbedGates re-runs mid-flight
    gate.dataset.orrUpgrading = "1";
    const platform = gate.getAttribute("data-embed-platform");
    const href = gate.getAttribute("data-embed-href");
    const label = gate.getAttribute("data-embed-label") || platform;
    gate.removeAttribute("data-embed-platform"); // so a concurrent re-scan can't match it again while in flight
    gate.textContent = "";
    const loading = document.createElement("p");
    loading.textContent = "Loading preview…";
    gate.appendChild(loading);
    const fail = () => { if (gate.isConnected) gate.replaceWith(externalLinkNode(href, label, "Couldn't load the " + label + " preview.")); };
    Promise.resolve(api.runtime.sendMessage({ type: "orr-fetch-oembed", platform, href }))
      .then((res) => {
        if (!gate.isConnected) return;
        const node = res && res.data ? renderOembedNode(res.data, href, label) : null;
        if (node) gate.replaceWith(node);
        else fail();
      })
      .catch(fail);
  }
  // A gate hidden inside a collapsed expando (display:none) has no offsetParent.
  // We don't fetch previews for those — it would fire a background request, and
  // reveal the post view to the provider, for every off-screen post on the page.
  // They're upgraded when the user expands the post (the expando handler re-runs
  // wireEmbedGates on the revealed content).
  function gateVisible(g) {
    return !!g && g.isConnected && (g.offsetParent !== null || g.getClientRects().length > 0);
  }
  function wireEmbedGates(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const gates = root.querySelectorAll(".orr-embed-gate[data-embed-platform]");
    if (!gates.length) return;
    const byPlatform = {};
    gates.forEach((g) => {
      const platform = g.getAttribute("data-embed-platform");
      (byPlatform[platform] || (byPlatform[platform] = [])).push(g);
    });
    Object.keys(byPlatform).forEach((platform) => {
      const platformGates = byPlatform[platform];
      checkEmbedPermission(platform).then((granted) => {
        if (granted) {
          platformGates.forEach((g) => { if (gateVisible(g)) upgradeEmbedGate(g); });
          return;
        }
        platformGates.forEach((g) => {
          if (g.dataset.orrGateWired) return;
          g.dataset.orrGateWired = "1";
          const btn = g.querySelector(".orr-embed-allow");
          if (!btn) return;
          const label = g.getAttribute("data-embed-label") || "";
          const resetLabel = () => { btn.disabled = false; btn.textContent = "Enable " + label + " previews"; };
          btn.addEventListener("click", () => {
            btn.disabled = true;
            btn.textContent = "Requesting…";
            Promise.resolve(api.runtime.sendMessage({ type: "orr-request-embed-permission", platform }))
              .then((res) => {
                if (res && res.granted) {
                  embedPermissionCache[platform] = true;
                  document
                    .querySelectorAll('.orr-embed-gate[data-embed-platform="' + platform + '"]')
                    .forEach((gg) => { if (gateVisible(gg)) upgradeEmbedGate(gg); });
                } else {
                  resetLabel();
                }
              })
              .catch(() => resetLabel());
          });
        });
      });
    });
  }

  function toggleCollapse(expandLink) {
    const thing = expandLink.closest(".thing.comment");
    if (!thing) return;
    const collapsed = thing.classList.toggle("collapsed");
    expandLink.innerHTML = collapsed ? "[+]" : "[&ndash;]";
    expandLink.setAttribute("aria-expanded", collapsed ? "false" : "true");
    expandLink.setAttribute("aria-label", collapsed ? "expand comment" : "collapse comment");
    persistCollapse(thing, collapsed);
    if (collapsed) stopHiddenMedia(thing);
    else { resumeHiddenMedia(thing); clampReadBodies(); } // expanding a thread reveals read bodies → add their expand hint
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
    patchUserVotes(root);
    addQuickActions(root);
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
  function toggleFavoriteSub(sub) {
    if (!sub) return;
    const key = sub.toLowerCase();
    const list = (dataCache.favoriteSubs || []).filter(Boolean);
    const idx = list.findIndex((s) => s.toLowerCase() === key);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(sub);
    dataCache.favoriteSubs = list;
    ORR.setPrefs({ favoriteSubs: list });
    patchSrBar();
    hideHoverCard();
  }
  // kind: "subreddits" or "users" (the Options page's filter lists).
  function isFiltered(kind, name) {
    const key = String(name || "").toLowerCase();
    return ((dataCache.filters && dataCache.filters[kind]) || []).some((s) => s && s.toLowerCase() === key);
  }
  function toggleFilter(kind, name, quiet) {
    if (!name) return;
    const key = name.toLowerCase();
    if (!dataCache.filters) dataCache.filters = { subreddits: [], users: [], domains: [], keywords: [], flairs: [], highlights: [] };
    const list = (dataCache.filters[kind] || []).filter(Boolean);
    const idx = list.findIndex((s) => s.toLowerCase() === key);
    const nowFiltered = idx < 0;
    if (nowFiltered) list.push(name);
    else list.splice(idx, 1);
    dataCache.filters[kind] = list;
    ORR.setPrefs({ filters: dataCache.filters });
    applyFilters(document);
    refreshQaTitles(kind, name);
    hideHoverCard();
    if (quiet) return;
    const label = (kind === "users" ? "u/" : "r/") + name;
    const where = document.querySelector(".commentarea") ? " in listings" : ""; // filters don't touch comments
    const msg = nowFiltered
      ? `${label} is filtered — ${kind === "users" ? "their" : "its"} posts are hidden${where}.`
      : `${label} is no longer filtered.`;
    showToast(msg, () => toggleFilter(kind, name, true));
  }

  let toastTimer = null;
  function showToast(text, onUndo) {
    let t = document.getElementById("orr-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "orr-toast";
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      document.body.appendChild(t);
    }
    t.textContent = text;
    if (onUndo) {
      const u = document.createElement("a");
      u.href = "#";
      u.textContent = "undo";
      u.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideToast();
        onUndo();
      });
      t.appendChild(u);
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    const t = document.getElementById("orr-toast");
    if (t) t.remove();
  }

  // Small icons after a tagline's "to r/sub" and author links: filter the sub or
  // user (listing posts only — filters don't apply to comments or to the post
  // a comments page is about), and tag the user.
  const SVG_NS = "http://www.w3.org/2000/svg";
  function blockIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const c = document.createElementNS(SVG_NS, "circle");
    [["cx", "8"], ["cy", "8"], ["r", "6.5"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"]].forEach(([k, v]) => c.setAttribute(k, v));
    const l = document.createElementNS(SVG_NS, "line");
    [["x1", "3.4"], ["y1", "3.4"], ["x2", "12.6"], ["y2", "12.6"], ["stroke", "currentColor"], ["stroke-width", "2"]].forEach(([k, v]) => l.setAttribute(k, v));
    svg.append(c, l);
    return svg;
  }
  // A luggage-tag outline (SVG, like blockIcon, so it looks the same on every OS — an
  // emoji renders differently everywhere).
  function tagIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(SVG_NS, "path");
    [["d", "M1.5 2.5v5l7 7 6-6-7-7h-5z"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "1.6"], ["stroke-linejoin", "round"]].forEach(([k, v]) => p.setAttribute(k, v));
    const h = document.createElementNS(SVG_NS, "circle");
    [["cx", "5"], ["cy", "6"], ["r", "1.3"], ["fill", "currentColor"]].forEach(([k, v]) => h.setAttribute(k, v));
    svg.append(p, h);
    return svg;
  }
  function qaTitle(action, kind, name) {
    if (action === "tag") return `Tag u/${name}: add a label shown next to their name`;
    const label = (kind === "users" ? "u/" : "r/") + name;
    const whose = kind === "users" ? "their" : "its";
    return isFiltered(kind, name)
      ? `Unfilter ${label}: show ${whose} posts in your listings again`
      : `Filter ${label}: hide ${whose} posts from your listings (undo in Options → Filters)`;
  }
  function qaLink(action, kind, name) {
    const a = document.createElement("a");
    a.href = "#";
    a.className = "orr-qa";
    a.setAttribute("role", "button");
    a.dataset.qa = action;
    a.dataset.qaKind = kind;
    a.dataset.qaName = name;
    a.title = qaTitle(action, kind, name);
    a.setAttribute("aria-label", a.title);
    a.appendChild(action === "filter" ? blockIcon() : tagIcon());
    return a;
  }
  // After a filter toggle, update the tooltip on every filter icon for that name.
  function refreshQaTitles(kind, name) {
    const key = name.toLowerCase();
    document.querySelectorAll('a.orr-qa[data-qa="filter"]').forEach((a) => {
      if (a.dataset.qaKind !== kind || (a.dataset.qaName || "").toLowerCase() !== key) return;
      a.title = qaTitle("filter", kind, name);
      a.setAttribute("aria-label", a.title);
    });
  }
  function addQuickActions(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const onComments = !!document.querySelector(".commentarea");
    const ur = ORR.isUserRoute(location);
    const profileUser = ur ? ur.name.toLowerCase() : "";
    root.querySelectorAll(".tagline a.author, .tagline a.subreddit").forEach((a) => {
      if (a.dataset.orrQa) return;
      a.dataset.orrQa = "1";
      const isSub = a.classList.contains("subreddit");
      const m = (isSub ? /^\/r\/([^/?#+]+)/ : /\/user\/([^/?#]+)/).exec(a.getAttribute("href") || "");
      if (!m || m[1].charAt(0) === "[") return; // [deleted]
      const name = m[1];
      const filterable = !onComments && !!a.closest(".thing.link");
      const out = [];
      if (isSub) {
        if (filterable) out.push(qaLink("filter", "subreddits", name));
      } else {
        if (filterable && name.toLowerCase() !== profileUser) out.push(qaLink("filter", "users", name));
        out.push(qaLink("tag", "users", name));
      }
      let at = a.nextElementSibling && a.nextElementSibling.classList.contains("orr-usertag") ? a.nextElementSibling : a;
      out.forEach((el) => { at.insertAdjacentElement("afterend", el); at = el; });
    });
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
      // A read post with new comments since your visit is kept (issue #16).
      const read = p.classList.contains("orr-visited") && !p.classList.contains("orr-has-new");
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
  let curThreadLast = 0; // last-visit time for the open thread, for flagging late-loaded comments
  let lastCommentsPathname = null; // set by loadComments; loadPage clears it on navigating elsewhere
  let commentsResortInPlace = false; // read by markNewComments(): true when this render is just a sort-order change on the same thread, not a fresh visit
  function flagNewComments(scope) {
    if (!curThreadLast) return;
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll(".thing.comment:not(.orr-new)").forEach((c) => {
      if (parseInt(c.getAttribute("data-created") || "0", 10) > curThreadLast) c.classList.add("orr-new");
    });
  }
  function markNewComments() {
    const area = document.querySelector(".commentarea");
    if (!area) return;
    const post = document.querySelector("#siteTable .thing.link");
    const t3 = post ? post.getAttribute("data-fullname") : null;
    if (!t3) return;
    // Only recompute the baseline on a genuine (non-resort) visit. A resort
    // re-running this same function must NOT re-read dataCache.threadVisits —
    // this very visit's own write below (a few lines down) already landed in
    // there, so re-reading it on the resort would silently swap in "the
    // baseline this visit just created" instead of "the baseline as it stood
    // before this visit started," making anything correctly flagged new on
    // the first render stop being flagged the moment you change sort.
    if (!commentsResortInPlace) {
      const rec = dataCache.threadVisits[t3];
      curThreadLast = typeof rec === "number" ? rec : (rec && rec.t) || 0; // old (number) or new ({t,c})
    }
    if (curThreadLast) {
      flagNewComments(document);
      area.classList.add("orr-visited-before"); // prior-visit info exists → read/unread is meaningful
    }
    applyReadFolding(); // grey + fold read threads (opt-in) before we overwrite the record
    // Just re-sorting the same open thread isn't a new visit — leave the read
    // timestamp (and the new/read split it drives) alone. Otherwise every
    // sort-order change would immediately "catch up" curThreadLast to now,
    // flagging everything as read and folding it all away.
    if (commentsResortInPlace) return;
    // Record this visit: timestamp + current comment count (powers the listing "N new" badge).
    const count = parseInt(post.getAttribute("data-comments") || "0", 10);
    dataCache.threadVisits[t3] = { t: Math.floor(nowMsNow() / 1000), c: count };
    const keys = Object.keys(dataCache.threadVisits);
    if (keys.length > 800) delete dataCache.threadVisits[keys[0]]; // cap growth
    ORR.setPrefs({ threadVisits: dataCache.threadVisits });
  }

  // Grey read comments and fold — at the HIGHEST level of each all-read subtree —
  // comment branches with nothing new since your last visit. Opt-in (foldReadComments)
  // and only when we have prior-visit info.
  function childComments(childWrap) {
    return Array.prototype.filter.call(childWrap.children, (el) => el.classList && el.classList.contains("comment"));
  }
  function foldReadSubtrees(topLevel) {
    // Bottom-up: mark every comment whose subtree contains a new comment (O(n)).
    const hasNew = new WeakSet();
    function mark(c) {
      let has = c.classList.contains("orr-new");
      const child = c.querySelector(":scope > .child");
      if (child) childComments(child).forEach((cc) => { if (mark(cc)) has = true; });
      if (has) hasNew.add(c);
      return has;
    }
    topLevel.forEach(mark);
    // Top-down: fold the highest all-read node in each branch; descend past nodes
    // that contain something new so their all-read sub-branches still fold.
    (function fold(list) {
      list.forEach((c) => {
        if (c.classList.contains("collapsed")) return; // already collapsed (user/prior) → leave it
        if (!hasNew.has(c)) { collapseThing(c, true); c.setAttribute("data-orr-readfold", "1"); }
        else { const child = c.querySelector(":scope > .child"); if (child) fold(childComments(child)); }
      });
    })(topLevel);
  }
  function applyReadFolding() {
    const area = document.querySelector(".commentarea");
    if (!area || !foldReadCommentsOn || !area.classList.contains("orr-visited-before")) return;
    area.classList.add("orr-foldread"); // CSS greys .thing.comment:not(.orr-new) and clamps read bodies
    foldReadSubtrees(topComments());
    clampReadBodies(); // add the "click to expand" affordance to long, visible read bodies
  }
  // Add the expand affordance (.orr-clamped) to read bodies that overflow the clamp.
  // Read bodies are clamped by CSS whenever visible; the click-to-expand handler works
  // on ANY read body, so this is only the visual hint. Re-run when bodies become newly
  // visible (a thread expands, load-more appends); idempotent via :not(.orr-clamped).
  function clampReadBodies() {
    const area = document.querySelector(".commentarea");
    if (!area || !area.classList.contains("orr-foldread")) return;
    const over = [];
    area.querySelectorAll(".thing.comment:not(.orr-new):not(.orr-read-open):not(.orr-clamped) > .entry > .usertext-body").forEach((b) => {
      if (b.offsetParent !== null && b.scrollHeight > b.clientHeight + 4) { const c = b.parentElement.parentElement; if (c) over.push(c); }
    });
    over.forEach((c) => c.classList.add("orr-clamped"));
  }
  function unfoldReadComments() {
    const area = document.querySelector(".commentarea");
    if (area) area.classList.remove("orr-foldread"); // un-grey / un-clamp
    document.querySelectorAll(".thing.comment[data-orr-readfold]").forEach((t) => {
      t.removeAttribute("data-orr-readfold");
      collapseThing(t, false); // re-expand only the threads we auto-folded
    });
    document.querySelectorAll(".thing.comment.orr-clamped, .thing.comment.orr-read-open").forEach((c) => c.classList.remove("orr-clamped", "orr-read-open"));
  }

  // Forget this thread's visit record — the next markNewComments() pass (e.g.
  // after a reload) will treat it as never-visited, same as a real first visit.
  // Also undoes the current page's new/read split live, without a reload.
  //
  // Also clears visitedPosts (the separate "have I opened this post at all"
  // tracker rememberVisit() writes): leaving that behind was a real bug, not
  // just an incompleteness — with threadVisits gone, markThreadNew() no longer
  // has a comment-count baseline, so a post can't be flagged orr-has-new
  // either, which removes the one thing that normally keeps a visited-but-
  // updated post from being caught by "hide read posts" (applyFilters' `read
  // = orr-visited && !orr-has-new`). Without also clearing visitedPosts, the
  // post would still read as visited and, missing that protection, get hidden
  // outright — exactly backwards from what "mark unread" should do.
  function markThreadUnread() {
    const post = document.querySelector("#siteTable .thing.link[data-fullname]");
    const t3 = post && post.getAttribute("data-fullname");
    if (!t3) return;
    let changed = false;
    if (dataCache.threadVisits[t3]) { delete dataCache.threadVisits[t3]; changed = true; }
    if (dataCache.visitedPosts && dataCache.visitedPosts[t3]) { delete dataCache.visitedPosts[t3]; changed = true; }
    if (!changed) return;
    ORR.setPrefs({ threadVisits: dataCache.threadVisits, visitedPosts: dataCache.visitedPosts });
    curThreadLast = 0;
    const area = document.querySelector(".commentarea");
    if (area) area.classList.remove("orr-visited-before");
    document.querySelectorAll(".thing.comment.orr-new").forEach((c) => c.classList.remove("orr-new"));
    unfoldReadComments();
  }

  // Listing pass: show "N new" on posts whose comment count grew since your last visit.
  function markThreadNew(scope) {
    if (document.querySelector(".commentarea")) return; // listings only — never badge the opened post
    const root = scope && scope.querySelectorAll ? scope : document;
    root.querySelectorAll("#siteTable .thing.link[data-fullname]").forEach((p) => {
      const rec = dataCache.threadVisits[p.getAttribute("data-fullname")];
      const seen = rec && typeof rec === "object" ? rec.c : null; // count at last visit (new format only)
      const cur = parseInt(p.getAttribute("data-comments") || "0", 10);
      const n = seen != null ? cur - seen : 0;
      p.classList.toggle("orr-has-new", n > 0);
      let li = p.querySelector(".orr-newcount-li");
      if (n > 0) {
        const commentsLi = p.querySelector(".entry .flat-list.buttons li.first");
        const link = commentsLi && commentsLi.querySelector("a.comments");
        if (!li && commentsLi) {
          li = document.createElement("li");
          li.className = "orr-newcount-li";
          const a = document.createElement("a");
          a.className = "orr-newcount";
          a.setAttribute("href", link ? link.getAttribute("href") : "#");
          li.appendChild(a);
          commentsLi.insertAdjacentElement("afterend", li);
        }
        if (li) li.querySelector("a").textContent = n + " new";
      } else if (li) {
        li.remove();
      }
    });
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
    upvote:      { def: "a", label: "upvote (logged in)" },
    downvote:    { def: "z", label: "downvote (logged in)" },
    reply:       { def: "r", label: "reply / write a comment (logged in)" },
    save:        { def: "s", label: "save / unsave (logged in)" },
    hide:        { def: "h", label: "hide / unhide the post (logged in)" },
    help:        { def: "?", label: "toggle this help" },
  };
  const KEY_ACTION_ORDER = ["next", "prev", "open", "expand", "comments", "goto", "nextNew", "prevNew", "collapseTop", "focusThread",
    "upvote", "downvote", "reply", "save", "hide", "help"];
  function keyForAction(name) {
    const kb = (dataCache && dataCache.keyBindings) || {};
    return kb[name] || (KEY_ACTIONS[name] && KEY_ACTIONS[name].def);
  }
  // Your own bindings win over defaults (so a newer default like "a" can't take a key
  // you'd already given to something else).
  function keyToActionMap() {
    const kb = (dataCache && dataCache.keyBindings) || {};
    const m = {};
    KEY_ACTION_ORDER.forEach((name) => { if (!kb[name] && KEY_ACTIONS[name].def) m[KEY_ACTIONS[name].def] = name; });
    KEY_ACTION_ORDER.forEach((name) => { if (kb[name]) m[kb[name]] = name; });
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
      case "upvote": case "downvote": { const t = kbTarget(); if (t) vote(t, name === "upvote" ? 1 : -1); break; }
      case "save": { const t = kbTarget(); if (t) toggleSave(t); break; }
      case "hide": { const t = kbTarget(); if (t && t.classList.contains("link")) toggleHide(t); break; }
      case "reply": {
        const t = kbCurrent();
        if (t && t.classList.contains("comment")) openReply(t);
        else { const top = document.querySelector(".orr-topform textarea"); if (top) focusEditor(top.closest("form")); else if (!myName()) loginNudge("comment"); }
        break;
      }
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
    const card = document.getElementById("orr-hovercard");
    if (!card) return;
    // Reddit's own markdown renderer can turn a bare "r/foo"/"u/foo" mention
    // (e.g. in a sidebar's "related subreddits") into an absolute URL rather
    // than a relative one — normalize through URL() so both match, same as
    // a hand-authored relative link would.
    let href;
    try {
      const u = new URL(anchor.getAttribute("href") || "", location.origin);
      if (u.origin !== location.origin) return; // not a reddit.com link
      href = u.pathname;
    } catch (e) {
      return;
    }
    const um = /^\/user\/([^/?#]+)\/?$/.exec(href);
    const sm = /^\/r\/([^/?#+]+)\/?$/.exec(href);
    if (!um && !sm) return;
    const url = um
      ? location.origin + "/user/" + um[1] + "/about.json?raw_json=1"
      : location.origin + "/r/" + sm[1] + "/about.json?raw_json=1";
    // Logged out, about.json is blocked: Reddit's own small hover-card partials carry
    // the same basics (see hoverPartial); failing that, show the name + actions.
    const j = jsonBlocked ? null : await fetchJsonCached(url);
    let d = j && j.data;
    if (!d && !jsonBlocked) return;
    if (!d) {
      const h = await hoverPartial(um ? "user" : "sub", um ? um[1] : sm[1]);
      if (h && um) d = { name: h.name, link_karma: h.postKarma, comment_karma: h.commentKarma, created_utc: h.created };
      else if (h) d = { display_name: h.name, public_description: h.description, orr_weekly: h.weeklyVisitors };
    }
    let html;
    if (um) {
      const name = (d && d.name) || um[1];
      const stats = d
        ? (d.link_karma != null || d.comment_karma != null ? `<br>${formatNumber(d.link_karma)} post &middot; ${formatNumber(d.comment_karma)} comment karma` : "") +
          (d.created_utc ? `<br>cake day ${esc(new Date(d.created_utc * 1000).toISOString().slice(0, 10))}` : "")
        : "";
      html =
        `<b>u/${esc(name)}</b>${stats}` +
        `<br><span class="orr-tagbtn" data-tag-user="${esc(name)}">tag user</span>` +
        ` &middot; <span class="orr-filterbtn" data-filter-kind="users" data-filter-name="${esc(name)}">${isFiltered("users", name) ? "un-filter user" : "filter user"}</span>`;
    } else {
      const rail = d ? null : await fetchRail(sm[1]); // last resort (heavier partial)
      const subName = (d && d.display_name) || (rail && rail.name) || sm[1];
      const subKey = subName.toLowerCase();
      const isFav = (dataCache.favoriteSubs || []).some((s) => s && s.toLowerCase() === subKey);
      const visitors = d && d.orr_weekly != null ? d.orr_weekly : rail ? rail.weeklyVisitors : null;
      const count = d && d.subscribers != null ? `${formatNumber(d.subscribers)} subscribers`
        : visitors != null ? `${formatNumber(visitors)} weekly visitors` : "";
      const desc = (d && d.public_description) || (rail && rail.description) || "";
      html =
        `<b>r/${esc(subName)}</b>` + (count ? `<br>${count}` : "") +
        (desc ? `<br>${esc(desc.slice(0, 240))}` : "") +
        `<br><span class="orr-favbtn" data-fav-sub="${esc(subName)}">${isFav ? "remove from favorites" : "add to favorites"}</span>` +
        ` &middot; <span class="orr-filterbtn" data-filter-kind="subreddits" data-filter-name="${esc(subName)}">${isFiltered("subreddits", subName) ? "un-filter" : "filter this subreddit"}</span>`;
    }
    if (!anchor.isConnected || !anchor.matches(":hover")) return; // pointer left while fetching
    card.innerHTML = html;
    positionCard(card, anchor);
    card.style.display = "block";
  }
  // Reddit's hover-card partials (~5-8 KB; work logged out). Values are read by their
  // visible labels ("Post karma", "Weekly visitors"…), the least fragile hook in them.
  function parseCount(t) {
    const m = /([\d.,]+)\s*([km])?/i.exec(String(t || ""));
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) return null;
    return Math.round(n * (/k/i.test(m[2] || "") ? 1e3 : /m/i.test(m[2] || "") ? 1e6 : 1));
  }
  function labeledCount(doc, label) {
    const want = label.toLowerCase();
    for (const el of doc.querySelectorAll("div, span")) {
      if (el.children.length || el.textContent.trim().toLowerCase() !== want) continue;
      // the number sits in a sibling (or a sibling's child) of the label, a level or two up
      for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
        const fn = p.querySelector("faceplate-number[number]");
        if (fn) return parseCount(fn.getAttribute("number"));
        const s = Array.from(p.querySelectorAll("span")).find((x) => !x.children.length && /^[\d.,]+\s*[km]?$/i.test(x.textContent.trim()));
        if (s) return parseCount(s.textContent);
      }
    }
    return null;
  }
  function userHoverFromHtml(doc) {
    const post = labeledCount(doc, "Post karma"), comment = labeledCount(doc, "Comment karma");
    if (post == null && comment == null) return null; // not a (visible) user
    const a = doc.querySelector("a[href^='/user/']");
    const m = a && /^\/user\/([^/?#]+)/.exec(a.getAttribute("href"));
    const t = doc.querySelector("time[datetime]");
    const ms = t ? Date.parse(t.getAttribute("datetime")) : NaN;
    return { name: m ? m[1] : "", postKarma: post, commentKarma: comment, created: isNaN(ms) ? 0 : ms / 1000 };
  }
  function subHoverFromHtml(doc) {
    const visitors = labeledCount(doc, "Weekly visitors");
    if (visitors == null) return null; // not a (visible) subreddit
    const a = doc.querySelector("a[href^='/r/']");
    const m = a && /^\/r\/([^/?#]+)/.exec(a.getAttribute("href"));
    const p = Array.from(doc.querySelectorAll("p")).find((x) => !x.closest("rpl-hovercard, article") && x.textContent.trim());
    return { name: m ? m[1] : "", description: p ? p.textContent.replace(/\s+/g, " ").trim() : "", weeklyVisitors: visitors, weeklyContributions: labeledCount(doc, "Weekly contributions") };
  }
  async function hoverPartial(kind, name) {
    const key = "hover:" + kind + ":" + String(name).toLowerCase();
    const hit = aboutCache.get(key);
    if (hit && Date.now() - hit.t < ABOUT_TTL) return hit.v;
    let v = null;
    try {
      const doc = await fetchHtmlDoc((kind === "user" ? "/svc/shreddit/user-hover-card/" : "/svc/shreddit/community-hover-card/") + encodeURIComponent(name));
      v = kind === "user" ? userHoverFromHtml(doc) : subHoverFromHtml(doc);
    } catch (e) {
      /* no data → name-only card */
    }
    aboutCache.set(key, { v, t: Date.now() });
    return v;
  }

  function fetchJsonCached(url) {
    if (enhanceCache.has(url)) return enhanceCache.get(url);
    const p = redditFetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    enhanceCache.set(url, p);
    return p;
  }

  // ---- pinch zoom: sideways scrolling pans the magnified view ----
  // Pinch-zoomed in (visualViewport.scale > 1), Chrome on Linux didn't pan the magnified view
  // with a touchpad's sideways swipe when the page itself has no sideways overflow (user
  // report: "nothing moves", pinch 4×) — while elsewhere the browser pans it fine. So on the
  // first sideways scroll after zooming in (and separately for Shift + scroll, like the
  // SideScroll extension), wait two frames: if the browser moved the view, leave it be; if
  // not, pan it ourselves from then on. Pages can't set the visual viewport's offset, but
  // asking a 1px marker just past its edge to scrollIntoView moves it. The wheel listener is
  // attached only while zoomed in.
  let pinchWheelOn = false;
  const pinchNative = { side: null, shift: null }; // does the browser pan the zoomed view itself? (null = not seen yet)
  let pinchProbe = null; // { kind, x0, sum } while finding out
  let pinchLastX = null; // where our last pan left the view (to notice the browser panning too)
  let pinchStill = null; // { kind, x, scale, n } — sideways scrolls in a row that left the view put
  // The page's own width: the viewport, or the body if it's wider (its min-width). Not
  // scrollWidth — our marker and scrollbar are absolutely positioned and would count.
  function pinchDocWidth() {
    return Math.max(document.documentElement.clientWidth, document.body ? document.body.offsetWidth : 0);
  }
  function panPinchView(dx) {
    const vv = window.visualViewport;
    if (!vv || !document.body) return false;
    const before = vv.pageLeft;
    // never past either side of the page (a marker beyond the right edge would widen the page
    // and the view would scroll on into empty space)
    const target = Math.max(0, Math.min(pinchDocWidth() - vv.width, before + dx));
    if (Math.abs(target - before) < 0.5) return false; // at the edge
    dx = target - before;
    const m = document.createElement("div");
    m.setAttribute("aria-hidden", "true");
    m.tabIndex = -1;
    m.style.cssText = "position:absolute;width:1px;height:1px;pointer-events:none;opacity:0;outline:none;margin:0;padding:0;";
    // (right: the marker's right edge lands at or just past the view's new right edge, but
    // never past the page's; left: its left edge at the view's new left edge)
    const x = dx > 0 ? Math.min(pinchDocWidth() - 1, Math.ceil(target + vv.width - 1)) : Math.floor(target);
    m.style.left = Math.max(0, x) + "px";
    m.style.top = Math.round(vv.pageTop + vv.height / 2) + "px";
    document.body.appendChild(m);
    try { m.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); } catch (e) { m.scrollIntoView(false); }
    if (Math.abs(vv.pageLeft - before) <= 0.5) {
      // didn't move: focusing an element also brings it into view (then give focus back)
      const prev = document.activeElement;
      try { m.focus(); } catch (e) { /* ignore */ }
      try { if (prev && prev.focus && prev !== document.body) prev.focus({ preventScroll: true }); else m.blur(); } catch (e) { /* ignore */ }
    }
    m.remove();
    return Math.abs(vv.pageLeft - before) > 0.5;
  }
  // Something under the pointer that scrolls sideways itself (a wide code block or table)
  // keeps its own sideways scrolling.
  function scrollsSideways(el, dx) {
    for (let n = el && el.nodeType === 1 ? el : el && el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth + 1) {
        if (dx > 0 ? n.scrollLeft < n.scrollWidth - n.clientWidth - 1 : n.scrollLeft > 0) return n;
      }
    }
    return null;
  }
  function onPinchWheel(e, fromPassive) {
    const vv = window.visualViewport;
    if (!active || !vv || vv.scale <= 1.01 || e.ctrlKey) return; // (ctrl+wheel = the pinch itself)
    if (document.getElementById("orr-lightbox")) return; // the image viewer pans its own image
    let dx = 0, kind = "side";
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dx = e.deltaX;
    else if (e.shiftKey && e.deltaY) { dx = e.deltaY; kind = "shift"; } // Shift + scroll = sideways
    else return;
    if (e.deltaMode === 1) dx *= 16; else if (e.deltaMode === 2) dx *= vv.width;
    const scroller = scrollsSideways(e.target, dx);
    if (scroller) return;
    // A cancelable scroll (a real touchpad's, in the user's Chrome) we simply take over: pan
    // the view ourselves and cancel the browser's own handling — no guessing whether it would
    // have panned (theirs never does; elsewhere this keeps it from moving twice).
    if (e.cancelable && !fromPassive) {
      if (panPinchView(dx)) e.preventDefault();
      return;
    }
    if (pinchNative[kind] === true) {
      // The browser pans it itself — unless several sideways scrolls in a row leave the view
      // exactly where it was (at the same zoom): then that verdict was wrong (e.g. it saw the
      // view settling after a pinch), so pan it ourselves after all.
      const st = pinchStill;
      if (st && st.kind === kind && Math.abs(st.scale - vv.scale) < 0.001 && Math.abs(st.x - vv.pageLeft) < 0.5) st.n++;
      else pinchStill = { kind, x: vv.pageLeft, scale: vv.scale, n: 0 };
      if (pinchStill.n < 5) return;
      pinchNative[kind] = false;
      pinchStill = null;
      pinchLastX = null;
    }
    // (deltas already come in zoomed-page pixels — the browser's own pan moves the view by deltaX)
    if (pinchNative[kind] === false) {
      if (pinchLastX != null && Math.abs(vv.pageLeft - pinchLastX) > 0.5) {
        // the view moved since our last pan without us: the browser pans after all — leave it
        pinchNative[kind] = true;
        pinchLastX = null;
        return;
      }
      if (panPinchView(dx)) { pinchLastX = vv.pageLeft; if (e.cancelable) e.preventDefault(); }
      return;
    }
    // First sideways scrolls while zoomed in: does the browser pan the view itself? Watch for
    // ~120ms (adding up the steps meanwhile); not at the edge it's heading for, where nothing
    // would move either way.
    if (pinchProbe) { if (pinchProbe.kind === kind) pinchProbe.sum += dx; return; }
    const x0 = vv.pageLeft;
    const room = dx > 0 ? pinchDocWidth() - (x0 + vv.width) : x0;
    if (room < 1) return; // at the edge
    const probe = pinchProbe = { kind, x0, scale0: vv.scale, sum: dx };
    setTimeout(() => {
      pinchProbe = null;
      if (pinchNative[kind] !== null) return;
      if (Math.abs(vv.scale - probe.scale0) > 0.001) return; // still zooming: check again next time
      // only a move in the scroll's direction counts (a pinch settling can shift the view either way)
      pinchNative[kind] = (vv.pageLeft - probe.x0) * Math.sign(probe.sum) > 0.5;
      if (!pinchNative[kind] && panPinchView(probe.sum)) pinchLastX = vv.pageLeft; // catch up those steps
    }, 120);
  }
  function syncPinchWheel() {
    const zoomed = !!window.visualViewport && window.visualViewport.scale > 1.01;
    pinchLastX = null; // (zooming moves the view by itself)
    pinchStill = null;
    if (zoomed && !pinchWheelOn) window.addEventListener("wheel", onPinchWheel, { passive: false });
    else if (!zoomed && pinchWheelOn) {
      window.removeEventListener("wheel", onPinchWheel, { passive: false });
      pinchNative.side = pinchNative.shift = null; // check again next time
    }
    pinchWheelOn = zoomed;
  }
  // (The browser's "zoom changed" signal doesn't always arrive, so the scrolls themselves can
  // switch the panning on: a passive watcher that costs nothing at normal zoom.)
  function pinchWatch(e) {
    const vv = window.visualViewport;
    if (!active || pinchWheelOn || !vv || vv.scale <= 1.01) return;
    syncPinchWheel(); // from the next event on
    onPinchWheel(e, true); // and this one (a passive listener can't cancel it)
  }

  // ---- pinch zoom: a horizontal scrollbar for the magnified view ----
  // The browser shows no usable scrollbar for a pinch-zoomed view (its own bars only cover
  // the page's sideways overflow — none here), and the user's touchpad can't pan it. So while
  // zoomed in, draw one along the bottom of what's on screen: the thumb shows where the view
  // is across the page; drag it, or click the track to page left / right. It's sized in CSS
  // pixels divided by the zoom, so it looks the same at any zoom, and moves the view with
  // panPinchView (the visual viewport can't be moved any other way).
  let pinchBar = null, pinchBarRaf = 0;
  const PINCHBAR_PX = 14; // on-screen height
  function placePinchBar() {
    pinchBarRaf = 0;
    const vv = window.visualViewport;
    const want = active && vv && vv.scale > 1.01 && !document.getElementById("orr-lightbox");
    if (!want) { if (pinchBar) pinchBar.style.display = "none"; return; }
    if (!pinchBar || !pinchBar.isConnected) {
      pinchBar = document.createElement("div");
      pinchBar.id = "orr-pinchbar";
      pinchBar.setAttribute("role", "scrollbar");
      pinchBar.setAttribute("aria-orientation", "horizontal");
      pinchBar.setAttribute("aria-label", "scroll the zoomed-in page sideways");
      pinchBar.innerHTML = '<div class="orr-pinchbar-thumb"></div>';
      pinchBar.addEventListener("pointerdown", onPinchBarDown);
      document.body.appendChild(pinchBar);
    }
    const s = vv.scale, docW = pinchDocWidth();
    const h = PINCHBAR_PX / s;
    Object.assign(pinchBar.style, {
      display: "block", left: vv.pageLeft + "px", top: (vv.pageTop + vv.height - h) + "px",
      width: vv.width + "px", height: h + "px", borderRadius: h / 2 + "px",
    });
    const thumb = pinchBar.firstElementChild;
    const tw = Math.max(vv.width * (vv.width / docW), 24 / s);
    const tl = docW > vv.width ? (vv.pageLeft / (docW - vv.width)) * (vv.width - tw) : 0;
    Object.assign(thumb.style, { width: tw + "px", left: tl + "px", top: 2 / s + "px", bottom: 2 / s + "px", borderRadius: h / 2 + "px" });
    pinchBar.setAttribute("aria-valuenow", String(Math.round((vv.pageLeft / Math.max(1, docW - vv.width)) * 100)));
  }
  function schedulePinchBar() { if (!pinchBarRaf) pinchBarRaf = requestAnimationFrame(placePinchBar); }
  // Drag the thumb, or press the track to page towards the click.
  function onPinchBarDown(e) {
    const vv = window.visualViewport;
    if (!vv || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const thumb = pinchBar.firstElementChild;
    const docW = pinchDocWidth();
    const trackPx = (vv.width - thumb.getBoundingClientRect().width) * vv.scale; // on-screen pixels the thumb can travel
    if (e.target !== thumb) { // track: a page towards the pointer
      const r = thumb.getBoundingClientRect();
      panPinchView((e.clientX < r.left ? -1 : 1) * vv.width * 0.9);
      schedulePinchBar();
      return;
    }
    const startX = e.screenX, startLeft = vv.pageLeft;
    pinchBar.classList.add("orr-dragging");
    try { pinchBar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const move = (ev) => {
      if (trackPx <= 0) return;
      const target = startLeft + ((ev.screenX - startX) / trackPx) * (docW - vv.width);
      const dx = Math.max(0, Math.min(docW - vv.width, target)) - vv.pageLeft;
      if (Math.abs(dx) >= 0.5) panPinchView(dx);
      schedulePinchBar();
    };
    const up = () => {
      pinchBar.classList.remove("orr-dragging");
      pinchBar.removeEventListener("pointermove", move);
      pinchBar.removeEventListener("pointerup", up);
      pinchBar.removeEventListener("pointercancel", up);
    };
    pinchBar.addEventListener("pointermove", move);
    pinchBar.addEventListener("pointerup", up);
    pinchBar.addEventListener("pointercancel", up);
  }

  function wireEnhancements() {
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", schedulePinchBar);
      window.visualViewport.addEventListener("scroll", schedulePinchBar);
      window.addEventListener("scroll", schedulePinchBar, { passive: true });
      window.visualViewport.addEventListener("resize", syncPinchWheel);
      window.addEventListener("wheel", pinchWatch, { passive: true });
      syncPinchWheel();
    }
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
      if (onSearchPage()) return; // (search results peek on pointer movement: see mousemove)
      const src = hoverPreviewSrc(a.closest(".thing.link"));
      if (!src) return;
      clearTimeout(hoverImgTimer);
      hoverImgTimer = setTimeout(() => showHoverImg(src), 200);
    }, true);
    document.addEventListener("mousemove", (e) => {
      const moved = e.clientX !== lastMouseX || e.clientY !== lastMouseY;
      lastMouseX = e.clientX; lastMouseY = e.clientY;
      // Search results: peek when the pointer moves onto a result's picture or title —
      // not when results scroll by under a resting pointer (browsers send mouseover then,
      // and a peek per title would pop up all through a scroll).
      if (moved && hoverPreviewOn && onSearchPage()) {
        const a = e.target.closest && e.target.closest(".thing.link a.title, .thing.link a.thumbnail");
        const thing = a && a.closest(".thing.link");
        if (thing && thing !== peekPending && thing.getAttribute("data-fullname") !== peekFor) {
          peekPending = thing;
          clearTimeout(hoverImgTimer);
          hoverImgTimer = setTimeout(() => {
            peekPending = null;
            if (a.matches(":hover")) showPostPeek(thing);
          }, 300);
        }
      }
      const el = document.getElementById("orr-hoverimg");
      if (el && el.style.display === "block") positionHoverImg(el, e.clientX, e.clientY);
      const pk = document.getElementById("orr-hoverpost");
      if (pk && pk.style.display === "block") positionHoverImg(pk, e.clientX, e.clientY);
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
        // .side a[href] covers sidebar content Reddit renders from a sub's own
        // markdown (e.g. "related subreddits", moderator links) — arbitrary
        // markup we don't control the classes of. showHoverCard() already only
        // acts on an href matching /r/name/ or /user/name/ exactly, so this
        // just widens where the attempt can start from, not what it accepts.
        const a = e.target.closest && e.target.closest("a.author, .sr-bar a.choice, a.subreddit, .side a[href]");
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
      if (to && to.closest && (to.closest("#orr-hovercard") || to.closest("a.author, .sr-bar a.choice, a.subreddit, .side a[href], a.orr-parent"))) return;
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
      // a link already wrapping its media (an inline image/GIF in a new-Reddit body) — don't show it twice
      if (a.querySelector("img, video")) continue;
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

  // Give a Reddit video its sound back via proper MSE-based playback. v.redd.it
  // serves video and audio as separate DASH representations; rather than playing
  // them in two independent <video>/<audio> elements and correcting drift with JS
  // (fragile, and needed constant seeking/rate-nudging to avoid stutter on weaker
  // hardware), hand the manifest to dash.js, which demuxes both tracks into this
  // ONE <video> element via Media Source Extensions. Sync then becomes the
  // browser's own media pipeline's job, same as any ordinary muxed video — no
  // JS-driven seeking or rate correction needed. Since the video now carries a
  // real audio track, the browser's native per-video controls (mute/volume) work
  // as-is; mute is additionally exposed as ONE global toggle (#orr-mute-all,
  // see ensureUiChrome) that applies to every reddit video at once. Defaults to
  // muted (DEFAULTS.videoMuted in common.js) — safer for autoplay-in-feed — but
  // remembers an explicit unmute across sessions like any other pref.
  let orrVideoMuted = true;
  let videoLoopOn = false, videoSpeed = 1, videoVolume = null; // remembered video prefs (ui blob + videoLoop bool)
  let hoverPreviewOn = true, lastMouseX = 0, lastMouseY = 0;
  let expandImagesOn = false;
  function updateUi(patch) { dataCache.ui = Object.assign({}, dataCache.ui, patch); ORR.setPrefs({ ui: dataCache.ui }); }
  // Set both the property AND the HTML attribute: autoplay-permission checks in
  // some engines don't reliably treat a JS-only `.muted = true` the same as the
  // attribute being present, which was silently blocking autoplay-with-sound
  // videos (NotAllowedError) even though they were "muted" by the property alone.
  function applyVideoMuted(v, m) {
    v.muted = m;
    if (m) v.setAttribute("muted", ""); else v.removeAttribute("muted");
  }
  function paintMuteAllBtn() {
    const b = document.getElementById("orr-mute-all");
    if (!b) return;
    b.textContent = orrVideoMuted ? "🔇" : "🔊";
    b.setAttribute("aria-pressed", orrVideoMuted ? "true" : "false");
    const lbl = orrVideoMuted ? "unmute all videos" : "mute all videos";
    b.title = lbl;
    b.setAttribute("aria-label", lbl);
  }
  function updateMuteAllVisibility() {
    const b = document.getElementById("orr-mute-all");
    if (b) b.classList.toggle("show", !!document.querySelector("video.reddit-video[data-dash-url]"));
  }
  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < (window.innerHeight || document.documentElement.clientHeight) && r.right > 0 && r.left < (window.innerWidth || document.documentElement.clientWidth);
  }
  function setVideoMuted(m) {
    orrVideoMuted = !!m;
    document.querySelectorAll("video.reddit-video").forEach((v) => {
      applyVideoMuted(v, orrVideoMuted);
      // Toggling this button is itself a user gesture, so a currently-visible
      // video that's paused (e.g. its first autoplay attempt was rejected
      // while unmuted) can safely retry now — play() is allowed here
      // regardless of mute state since it's gesture-driven, not autoplay.
      if (autoplayOn && v.paused && v.dataset.orrWant !== "pause" && isInViewport(v)) {
        v.dataset.orrWant = "play";
        v.play().catch(() => {});
      }
    });
    paintMuteAllBtn();
    ORR.setPrefs({ videoMuted: orrVideoMuted });
  }

  // Loaded lazily (see wireRedditVideo) and only once per page — dash.js is a
  // ~740KB module, not worth fetching/parsing on pages with no video, or before
  // the user actually presses play.
  let dashModulePromise = null;
  function loadDashJs() {
    if (!dashModulePromise) dashModulePromise = import(api.runtime.getURL("vendor/dash.mediaplayer.min.js"));
    return dashModulePromise;
  }

  // dash.js's own representation-selection logic throws internally against
  // Reddit's raw manifest ("period[i.index] is undefined" / "entries() is not
  // iterable") — happens during initial selection, not just later ABR
  // switches, so disabling autoSwitchBitrate alone doesn't stop it. RES's own
  // dash.js integration avoids this by trimming the manifest to a single video
  // Representation and handing dash.js a blob: URL instead of the remote one —
  // tried that here too, but Reddit's page CSP connect-src doesn't allow
  // blob:, so dash.js's own fetch of it gets blocked outright (worse: no
  // playback at all, not just console noise). Reverted; the errors are noisy
  // but don't block actual playback, unlike the CSP wall. A real fix would
  // need dash.js's own internal manifest object shape via loadWithManifest()
  // instead of a URL — more fragile than this is worth for now.

  function wireRedditVideo(video) {
    if (!video || video.dataset.orrDashWired) return;
    const dashUrl = video.getAttribute("data-dash-url") || "";
    if (!dashUrl) return; // no separate audio track — the plain <source> already plays fine
    video.dataset.orrDashWired = "1";
    applyVideoMuted(video, orrVideoMuted);

    // If v.redd.it won't serve us the manifest (it now 403s all our contexts), the
    // player can only ever show a black box — swap in the "Watch on Reddit" fallback.
    redditVideoReachable(dashUrl).then((ok) => { if (!ok && video.isConnected) showVideoFallback(video); });

    // Don't attach dash.js (or fetch anything) until the user actually presses
    // play: this runs for every visible video on the page (e.g. every post in a
    // feed), and dash.js starts fetching the manifest+segments the moment it's
    // attached, regardless of the video's own `preload` attribute.
    video.addEventListener("play", () => {
      loadDashJs()
        .then((mod) => {
          if (!video.isConnected) return; // navigated away before dash.js finished loading
          const player = mod.MediaPlayer().create();
          video._orrDashPlayer = player;
          // We don't offer a quality picker, so at least stop dash.js from
          // evaluating bitrate switches on Reddit's short representation ladder
          // (that's where the "period[i.index] is undefined" noise comes from).
          try { player.updateSettings({ streaming: { abr: { autoSwitchBitrate: { video: false, audio: false } } } }); } catch (e) {}
          player.initialize(video, dashUrl, false);
          // attachSource (inside initialize) swaps the element's media source out
          // from under the native <source> that was already playing, so the video
          // isn't actually ready yet — resuming immediately gets silently dropped.
          // Worse: dash.js's own representation-selection bug against Reddit's raw
          // manifest ("period[i.index] is undefined") makes it abort and restart
          // the stream from scratch internally, for some videos more than once —
          // each restart re-pauses it right after we've resumed it. So this isn't
          // a one-shot resume: keep resuming every time it becomes playable again
          // (bounded, in case a given video's manifest never stops erroring),
          // converging once dash.js finally stops resetting itself. Unless
          // autoplay already paused it deliberately (scrolled out while this was
          // loading), tracked via data-orr-want (see autoplayMedia).
          let resumeAttempts = 0;
          video.addEventListener("canplay", function onCanPlay() {
            if (video.dataset.orrWant === "pause") { video.removeEventListener("canplay", onCanPlay); return; }
            if (!video.paused) return; // already playing, nothing to do
            if (++resumeAttempts > 8) { video.removeEventListener("canplay", onCanPlay); return; }
            video.play().catch(() => {});
          });
        })
        .catch(() => { /* dash.js unavailable → the plain <source src=fallback_url> keeps playing, just silent */ });
    }, { once: true });
  }

  function wireRedditVideos(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    let vids;
    try { vids = root.querySelectorAll("video.reddit-video[data-dash-url]"); } catch (e) { return; }
    // Warm the shared dash.js module (not any per-video manifest/segments — see
    // wireRedditVideo) as soon as we know a dash video exists on the page, not
    // only once the user presses play. Its ~740KB fetch is what was pushing the
    // post-swap resume play() past the browser's gesture-exemption window,
    // making it get silently rejected and forcing a second manual click.
    if (vids.length) loadDashJs().catch(() => {});
    vids.forEach(wireRedditVideo);
    updateMuteAllVisibility();
  }

  // v.redd.it now serves fragmented CMAF (not directly playable) AND 403s every
  // media request the extension can make — page fetch, content-script fetch, and
  // even the CORS-exempt background fetch (verified) — because it requires Reddit's
  // own signed-URL/app pipeline. So when a reddit-video's manifest is unreachable
  // we can't play it; replace the dead black box with a poster + "Watch on Reddit"
  // that reopens the post with the extension standing down (see #orr-native in
  // start()), letting Reddit's own player handle it. One background probe per page;
  // if Reddit ever restores open access, the probe passes and normal playback stays.
  let redditVideoReachP = null;
  function redditVideoReachable(dashUrl) {
    if (redditVideoReachP) return redditVideoReachP;
    redditVideoReachP = Promise.resolve(api.runtime.sendMessage({ type: "orr-vreddit-fetch", url: dashUrl }))
      .then((res) => !!(res && res.ok))
      .catch(() => false);
    return redditVideoReachP;
  }
  function showVideoFallback(video) {
    if (!video || video.dataset.orrFellBack) return;
    video.dataset.orrFellBack = "1";
    const container = video.closest(".expando-container") || (video.closest(".orr-video-wrap") || video).parentNode;
    if (!container) return;
    const thing = video.closest(".thing.link");
    const permalink = (thing && thing.getAttribute("data-permalink")) || location.pathname;
    const poster = video.getAttribute("poster") || "";
    const fb = document.createElement("div");
    fb.className = "orr-video-fallback";
    if (poster) { const im = document.createElement("img"); im.className = "orr-video-poster"; im.src = poster; fb.appendChild(im); }
    const a = document.createElement("a");
    a.className = "orr-watch-reddit";
    a.href = permalink.replace(/\/+$/, "") + "/#orr-native";
    a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = "▶ Watch on Reddit";
    fb.appendChild(a);
    container.textContent = "";
    container.appendChild(fb);
  }

  // ---- video niceties: playback speed, loop, remembered volume ----
  const VIDEO_SPEEDS = [1, 1.25, 1.5, 2, 0.5];
  function setVideoLoop(on) {
    videoLoopOn = !!on;
    document.querySelectorAll(".orr-video-wrap video, video.orr-directvideo, .expando video").forEach((v) => {
      v.loop = videoLoopOn || v.hasAttribute("data-orr-gif");
      if (v._orrPaintLoop) v._orrPaintLoop();
    });
    ORR.setPrefs({ videoLoop: videoLoopOn });
  }
  function addVideoControls(video) {
    if (!video || video.dataset.orrVctl) return;
    video.dataset.orrVctl = "1";
    video.loop = videoLoopOn || video.hasAttribute("data-orr-gif"); // GIFs always loop
    try { if (videoSpeed && videoSpeed !== 1) video.playbackRate = videoSpeed; } catch (e) {}
    if (videoVolume != null) { try { video.volume = videoVolume; } catch (e) {} }
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
    video.addEventListener("volumechange", () => {
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
    // Keep at least the far edge of the scaled image reachable at the viewport
    // edge, rather than letting it be dragged/panned entirely out of view.
    const maxX = Math.max(0, (img.offsetWidth * s.scale - window.innerWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * s.scale - window.innerHeight) / 2);
    s.tx = Math.min(maxX, Math.max(-maxX, s.tx));
    s.ty = Math.min(maxY, Math.max(-maxY, s.ty));
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
      // Ctrl+wheel zooms — browsers also report a trackpad pinch gesture as a
      // wheel event with ctrlKey set, so this covers both. Plain scroll (mouse
      // wheel or a two-finger swipe) pans a zoomed-in image instead, matching
      // how most image/PDF viewers split the two gestures — otherwise there
      // was no way to pan via scroll at all, only click-drag.
      if (e.ctrlKey) {
        s.scale = Math.min(8, Math.max(1, s.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (s.scale === 1) { s.tx = 0; s.ty = 0; }
      } else if (s.scale > 1) {
        s.tx -= e.deltaX;
        s.ty -= e.deltaY;
      }
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
      // #orr-lb-open is an id, not a class — html.orr-lb-open (the "lightbox is
      // open" marker, toggled below) is an ancestor of every element on the
      // page while open, so a `.orr-lb-open` CLASS selector here matched that
      // instead and swallowed every click inside the lightbox, close button
      // included, before it ever reached the logic below.
      if (e.target.closest("#orr-lb-open")) return; // let the link open
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
  function hideHoverImg() {
    clearTimeout(hoverImgTimer);
    peekPending = null;
    const el = document.getElementById("orr-hoverimg");
    if (el) el.style.display = "none";
    const pk = document.getElementById("orr-hoverpost");
    if (pk) pk.style.display = "none";
    peekFor = null;
  }
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
  // Search results: hovering a result's picture or title peeks at the post — its text,
  // its picture, where a link post points. Logged in, the row's hidden expando has it;
  // logged out, the results carry none of it, so the post is fetched (just the post, see
  // fetchPostOnly) and kept for the next hover.
  let peekFor = null, peekPending = null; // the post shown / waiting out the hover delay
  function onSearchPage() { return !!document.body && document.body.classList.contains("search-page"); }
  function peekFromRow(thing) {
    const md = thing.querySelector(".expando .md");
    const a = thing.querySelector("a.title");
    const href = (a && a.getAttribute("href")) || "";
    return postPeekHtml({
      img: hoverPreviewSrc(thing) || "",
      video: !!thing.querySelector(".expando video, .expando .orr-video"),
      link: /^https?:\/\//i.test(href) && !/^https?:\/\/([a-z0-9-]+\.)?(reddit\.com|redd\.it)\//i.test(href) ? href : "",
      html: md ? md.outerHTML : "",
    });
  }
  function peekHtmlFor(thing) {
    if (!jsonBlocked || thing.querySelector(".expando")) return Promise.resolve(peekFromRow(thing));
    const p = postOnlyCached(thing.getAttribute("data-permalink") || "");
    return p ? p.then((d) => postPeekHtml(postPeekParts(d)), () => postPeekHtml(null)) : Promise.resolve(postPeekHtml(null));
  }
  // Just a post (see fetchPostOnly), once per post: the search peek and a listing's
  // "text the feed left out" both use it. A failed fetch is forgotten, to retry later.
  const postOnlyCache = new Map(); // permalink → Promise<t3 data | null>
  function postOnlyCached(path) {
    if (!/^\/(r|user)\/[^/]+\/comments\/[a-z0-9]+\//i.test(path)) return null;
    if (postOnlyCache.has(path)) return postOnlyCache.get(path);
    const p = fetchPostOnly(path);
    p.catch(() => postOnlyCache.delete(path));
    postOnlyCache.set(path, p);
    if (postOnlyCache.size > 150) postOnlyCache.delete(postOnlyCache.keys().next().value);
    return p;
  }

  // An image / gallery / video post from a logged-out feed may have text the feed left
  // out. Once its preview is open and on screen (so "show images" doesn't fetch every
  // post on the page at once), fetch the post and add the text under the media, the way
  // old reddit-style expandos show a media post's own text.
  let textCheckObserver = null;
  function checkUnsentText(thing) {
    if (!thing || thing.getAttribute("data-orr-textcheck") !== "1") return;
    const expando = thing.querySelector(":scope > .entry > .expando");
    if (!expando) return;
    if (typeof IntersectionObserver === "undefined") { loadUnsentText(thing, expando); return; }
    if (!textCheckObserver) {
      textCheckObserver = new IntersectionObserver((entries) => entries.forEach((en) => {
        if (!en.isIntersecting) return;
        textCheckObserver.unobserve(en.target);
        const t = en.target.closest(".thing.link");
        if (t && en.target.style.display !== "none") loadUnsentText(t, en.target);
      }), { rootMargin: "200px" });
    }
    textCheckObserver.observe(expando);
  }
  function loadUnsentText(thing, expando) {
    if (thing.getAttribute("data-orr-textcheck") !== "1") return;
    thing.setAttribute("data-orr-textcheck", "loading");
    const p = postOnlyCached(thing.getAttribute("data-permalink") || "");
    if (!p) { thing.setAttribute("data-orr-textcheck", "done"); return; }
    p.then((d) => {
      thing.setAttribute("data-orr-textcheck", "done");
      if (!d || !d.selftext_html || !expando.isConnected || expando.querySelector(".orr-post-text")) return;
      expando.insertAdjacentHTML("beforeend", selfTextBox(d.selftext_html, "orr-post-text"));
      const box = expando.lastElementChild;
      linkifyEmails(box);
      inlineImages(box);
    }, () => thing.setAttribute("data-orr-textcheck", "1")); // (try again next time it opens)
  }
  function fitPeek(el) {
    el.classList.remove("orr-peek-clipped");
    el.classList.toggle("orr-peek-clipped", el.scrollHeight > el.clientHeight + 2);
    positionHoverImg(el, lastMouseX, lastMouseY);
  }
  function showPostPeek(thing) {
    if (!thing || !thing.isConnected) return;
    let el = document.getElementById("orr-hoverpost");
    if (!el) { el = document.createElement("div"); el.id = "orr-hoverpost"; document.body.appendChild(el); }
    const name = thing.getAttribute("data-fullname") || "";
    if (peekFor === name) return; // (already showing / loading it: the pointer just moved within the row's link)
    peekFor = name;
    let ready = false;
    peekHtmlFor(thing).then((html) => {
      ready = true;
      if (peekFor !== name) return; // the pointer moved on
      el.innerHTML = html;
      el.style.display = "block";
      el.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => {
        const box = img.closest(".orr-peek-media");
        if (box) box.classList.add("orr-peek-loaded");
        if (peekFor === name) fitPeek(el);
      }, { once: true }));
      el.querySelectorAll(".orr-peek-media img").forEach((img) => img.addEventListener("error", () => {
        img.closest(".orr-peek-media").remove(); // (an expired / missing image: just the text)
        if (!el.firstChild) el.innerHTML = '<div class="orr-peek-none">no description</div>';
        if (peekFor === name) fitPeek(el);
      }, { once: true }));
      fitPeek(el);
    });
    setTimeout(() => {
      if (ready || peekFor !== name) return;
      el.innerHTML = '<div class="orr-peek-none">loading…</div>';
      el.style.display = "block";
      fitPeek(el);
    }, 0);
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
      const save = buttons.querySelector(":scope > .orr-save-li");
      if (save) save.insertAdjacentElement("afterend", li); // old reddit's order: permalink save parent … reply
      else buttons.appendChild(li);
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
    if (collapse) stopHiddenMedia(thing);
    else resumeHiddenMedia(thing);
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
      if (a.querySelector("img, video")) continue; // already shows its media inline
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
        esc(base + "/DASHPlaylist.mpd") +
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
    linkifyEmails(scope || document);
    applyLoginState(scope || document);
    markOP();
    addParentLinks();
    ensureCommentNav();
    applyCollapsedState();
    autoCollapseBots();
    expandCommentMedia(scope || document);
    addDownloadButtons(scope || document);
    wireEmbedGates(scope || document);
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

  // Autoplay reddit videos/gifs in listings as they scroll into view, and pause
  // them again once they scroll out (RES). Sound is governed by the same global
  // mute toggle as every other video (orrVideoMuted, defaults muted) — no special
  // casing here. Stays observing (doesn't unobserve after the first trigger) so
  // it can re-pause/re-play across repeated scroll in/out.
  let autoplayObserver = null;
  function autoplayMedia(scope) {
    if (!autoplayOn || typeof IntersectionObserver === "undefined") return;
    if (document.querySelector(".commentarea")) return; // listings only
    const root = scope && scope.querySelectorAll ? scope : document;
    if (!autoplayObserver) {
      autoplayObserver = new IntersectionObserver((entries) => {
        // Re-check the LIVE setting, not just its value when each element was
        // first observed — the observer itself is a singleton that's never
        // torn down, so without this, posts observed while autoplay was on
        // would keep autoplaying forever after the setting is turned back off.
        if (!autoplayOn) return;
        entries.forEach((en) => {
          const btn = en.target;
          const entry = btn.closest(".entry");
          if (en.isIntersecting) {
            if (btn.classList.contains("collapsed")) btn.click(); // expand (also starts it — see the expando click handler)
            const v = entry && entry.querySelector(":scope > .expando video");
            if (v) { v.dataset.orrWant = "play"; try { v.play().catch(() => {}); } catch (e) {} }
          } else {
            const v = entry && entry.querySelector(":scope > .expando video");
            if (v) { v.dataset.orrWant = "pause"; try { v.pause(); } catch (e) {} }
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
    if (!trackRecentSubsOn) return;
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
    const recent = trackRecentSubsOn ? (dataCache.recentSubs || []).filter(Boolean) : [];
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

  // "mark unread" next to the post's comment-count/share buttons. Always shown
  // (markNewComments already recorded this visit by the time we get here, so
  // there's always something to forget) — clicking it again with nothing left
  // to reset is a harmless no-op via markThreadUnread's own guard.
  function addMarkUnreadButton() {
    const buttons = document.querySelector("#siteTable .thing.link .flat-list.buttons");
    if (!buttons || buttons.querySelector(".orr-mark-unread")) return;
    if (!document.querySelector("#siteTable .thing.link[data-fullname]")) return;
    const li = document.createElement("li");
    li.innerHTML = '<a href="javascript:void(0)" class="orr-mark-unread">mark unread</a>';
    buttons.appendChild(li);
    li.querySelector("a").addEventListener("click", (e) => {
      e.preventDefault();
      markThreadUnread();
    });
  }

  // Quick subreddit switcher (RES-style go-to), opened with `g`.
  function navigateTo(path) {
    const u = new URL(path, location.origin);
    scrollPositions[scrollKey()] = window.scrollY;
    historyNavKey = null;
    history.pushState(null, "", u.pathname + u.search);
    window.scrollTo(0, 0);
    loadPage(u, false);
  }
  // Custom "top of last N hours/days": read the input from the time menu and navigate
  // to ?hours=N or ?days=N (jsonUrlFor maps it to a bucket; buildBody filters the window).
  function submitCustomWindow(fromEl, unit) {
    const area = fromEl.closest(".menuarea") || document;
    const input = area.querySelector(unit === "hours" ? ".orr-hours-input" : ".orr-days-input");
    const n = input ? parseInt(input.value, 10) : NaN;
    if (!(n > 0)) { if (input) input.focus(); return; }
    const r = ORR.isListingRoute(new URL(location.href));
    if (!r) return;
    navigateTo(r.basePath + "/?" + unit + "=" + Math.min(n, unit === "hours" ? 8760 : 3650));
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
    markThreadNew(document); // "N new" badges + orr-has-new (so read posts with new comments aren't hidden)
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
    wireEmbedGates(document);
    if (document.querySelector(".commentarea")) rememberVisit();
    observeMores();
    linkifyEmails(document);
    applyLoginState(document);
    fetchMe().then(() => applyLoginState(document));
    schedulePinchBar(); // (a new body: redraw the pinch-zoom scrollbar if zoomed in)
  }
  function enhanceNewItems(scope) {
    linkifyEmails(scope || document);
    applyLoginState(scope || document);
    markShownRead(scope || document); // (inbox pages only)
    markVisited(scope || document);
    markThreadNew(scope || document);
    applyFilters(scope || document);
    patchTags(scope || document);
    inlineImages(scope || document);
    wireRedditVideos(scope || document);
    enhanceVideoControls(scope || document);
    addDownloadButtons(scope || document);
    autoplayMedia(scope || document);
    applySubPrefs(); // auto-expand newly-appended posts if this sub wants it
    expandImagesPass(); // "show images": expand newly-appended image posts
    wireEmbedGates(scope || document);
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
      // custom "last N hours/days" → fetch the smallest covering bucket, then filter
      const bucket = windowBucket(params) || params.t;
      if (bucket) q.set("t", bucket);
    }
    return location.origin + route.basePath + "/.json?" + q.toString();
  }

  // ---------- logged-out fallback: Reddit's own server-rendered HTML -----------
  // Reddit answers every LOGGED-OUT .json request with a 403 "You've been blocked
  // by network security" HTML page (and old.reddit.com now redirects logged-out
  // visitors to a login wall), so for them the JSON path above never works. But
  // www.reddit.com still serves its own HTML — the listing partials new Reddit
  // pages through, and each thread page — and every post/comment in it carries its
  // data as attributes (<shreddit-post score=… comment-count=…>, <shreddit-comment
  // thingid=… parentid=…>). When the .json is refused we read those instead and
  // map them onto the exact JSON shapes the builders already take, so the rest of
  // the extension doesn't know the difference.

  let jsonBlocked = false; // a .json call was network-blocked on this page → go straight to HTML

  // Reddit's network-security block is a 403 *HTML* page; a genuine API 403
  // (private/quarantined sub) comes back as JSON and must still surface as-is.
  function isJsonBlock(res) {
    return !!res && res.status === 403 && !/json/i.test((res.headers && res.headers.get("content-type")) || "");
  }

  // Parse fetched HTML inertly (DOMParser runs no scripts and loads no images).
  // Reddit defers much of a page — including most comments — inside <template>s;
  // splice each template's content back in place so everything is in document
  // order with its real nesting.
  function parseHtmlDoc(text) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    for (let i = 0; i < 25; i++) {
      const ts = doc.querySelectorAll("template");
      if (!ts.length) break;
      ts.forEach((t) => t.replaceWith(t.content));
    }
    return doc;
  }

  // Asking for Reddit's own partial rendering (what its faceplate-partial loader
  // requests) drops the page shell: ~40-60% smaller responses, same data.
  const HTML_ACCEPT = "text/vnd.reddit.partial+html, text/html;q=0.9";
  async function fetchHtmlDoc(path, init) {
    const res = await redditFetch(location.origin + path, Object.assign({ credentials: "include", headers: { Accept: HTML_ACCEPT } }, init || {}));
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      err.retryAfter = retryAfterOf(res);
      throw err;
    }
    return parseHtmlDoc(await res.text());
  }

  // Rebuild Reddit-rendered rich text (post/comment bodies) from an allowlist of
  // markdown-ish tags and attributes, unwrapping everything else — so nothing from
  // the fetched page beyond plain formatting, links and images reaches our DOM.
  const MD_KEEP = { P: 1, BR: 1, HR: 1, A: 1, EM: 1, STRONG: 1, B: 1, I: 1, DEL: 1, S: 1, SUP: 1, SUB: 1, CODE: 1, PRE: 1, BLOCKQUOTE: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TH: 1, TD: 1, SPAN: 1, IMG: 1 };
  // (screen-reader-only text would show up as stray visible text once unwrapped)
  // (not <object>: a feed wraps a post's whole text in a link to the post, and wraps each
  // link inside it in an <object> to nest them — dropping those dropped every link, words
  // and all; unwrapped like any other tag, only what's inside it is kept)
  const MD_DROP = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, IFRAME: 1, EMBED: 1, SVG: 1, BUTTON: 1, INPUT: 1, FORM: 1, TEXTAREA: 1, SELECT: 1, NOSCRIPT: 1, LINK: 1, META: 1, "FACEPLATE-SCREEN-READER-CONTENT": 1 };
  const MD_VOID = { BR: 1, HR: 1, IMG: 1 };
  // opts.headingsAsStrong: render h1/h2 as bold text (sidebar widgets title every rule with an h2)
  function cleanMd(node, opts) {
    let out = "";
    if (!node) return out;
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) { out += esc(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      let tag = n.tagName.toUpperCase();
      if (MD_DROP[tag]) return;
      // new Reddit marks spoilers with a <spoiler-text> element; old reddit's CSS hides .md-spoiler-text
      if (tag === "SPOILER-TEXT") { out += `<span class="md-spoiler-text">${cleanMd(n, opts)}</span>`; return; }
      if (tag === "SHREDDIT-PLAYER" || tag === "SHREDDIT-PLAYER-2") { out += inlinePlayerHtml(n); return; }
      if (opts && opts.headingsAsStrong && (tag === "H1" || tag === "H2")) tag = "STRONG";
      if (!MD_KEEP[tag]) { out += cleanMd(n, opts); return; } // unknown wrapper → keep its contents
      let attrs = "";
      if (tag === "A") {
        const href = n.getAttribute("href") || "";
        if (/^(https?:\/\/|\/(?!\/)|#)/i.test(href) || MAILTO_RE.test(href)) attrs += ` href="${esc(href)}"`;
      } else if (tag === "IMG") {
        const src = n.getAttribute("src") || "";
        if (!/^https:\/\//i.test(src)) return;
        attrs += ` src="${esc(src)}" alt="${esc(n.getAttribute("alt") || "")}"`;
        ["width", "height"].forEach((k) => { const v = n.getAttribute(k); if (v && /^\d+$/.test(v)) attrs += ` ${k}="${v}"`; });
      } else if (tag === "SPAN") {
        if (/\bmd-spoiler-text\b/.test(n.getAttribute("class") || "")) attrs += ' class="md-spoiler-text"';
      } else if (tag === "TH" || tag === "TD") {
        const al = n.getAttribute("align");
        if (al && /^(left|right|center)$/i.test(al)) attrs += ` align="${al.toLowerCase()}"`;
      } else if (tag === "OL") {
        const st = n.getAttribute("start");
        if (st && /^\d+$/.test(st)) attrs += ` start="${st}"`;
      }
      const t = tag.toLowerCase();
      out += MD_VOID[tag] ? `<${t}${attrs}>` : `<${t}${attrs}>${cleanMd(n, opts)}</${t}>`;
    });
    return out;
  }

  // An email link: mailto: plus an address (no other scheme, no markup characters).
  const MAILTO_RE = /^mailto:[^\s"'<>()\\]+@[^\s"'<>()\\]+$/i;
  // Email addresses written as plain text in a post / comment / sidebar become mailto:
  // links, like on new Reddit. (Logged out, Reddit's own mailto links come through
  // cleanMd; logged in, the JSON's HTML can carry them as plain text.) Built as DOM
  // nodes, never markup; text already inside a link or code is left alone.
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])/g;
  function linkifyEmails(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const mds = Array.from(root.querySelectorAll(".md"));
    if (root.matches && root.matches(".md")) mds.push(root);
    mds.forEach((md) => {
      if (md.closest(".orr-editor")) return; // (the preview links its own)
      const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
      const hits = [];
      while (walker.nextNode()) {
        const t = walker.currentNode;
        if (t.nodeValue.indexOf("@") >= 0 && !t.parentElement.closest("a, code, pre, textarea")) hits.push(t);
      }
      hits.forEach((t) => {
        const text = t.nodeValue;
        EMAIL_RE.lastIndex = 0;
        let m, last = 0, frag = null;
        while ((m = EMAIL_RE.exec(text))) {
          frag = frag || document.createDocumentFragment();
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          const a = document.createElement("a");
          a.href = "mailto:" + m[0];
          a.textContent = m[0];
          frag.appendChild(a);
          last = m.index + m[0].length;
        }
        if (!frag) return;
        frag.appendChild(document.createTextNode(text.slice(last)));
        t.replaceWith(frag);
      });
    });
  }

  // A media player inside a comment/post body. GIFs (incl. giphy) are silent MP4s on
  // Reddit's CDN → a looping inline video. Videos stream from v.redd.it (HLS) →
  // the plain v.redd.it link the JSON API gives, which expandCommentMedia expands.
  function inlinePlayerHtml(player) {
    const gif = gifPlayerSrc(player);
    if (gif) return `<video class="orr-inline-gif" src="${esc(gif)}" autoplay loop muted playsinline preload="metadata"></video>`;
    const m = /^https:\/\/v\.redd\.it\/(?:link\/[^/]+\/asset\/)?([A-Za-z0-9]+)/.exec(player.getAttribute("src") || "");
    return m ? `<a href="https://v.redd.it/${m[1]}">https://v.redd.it/${m[1]}</a>` : "";
  }

  // "2026-10-14T19:20:16.991000+0000" → epoch seconds. Normalised to strict ISO
  // first: microseconds and a colon-less offset aren't parsed by every engine.
  function isoToUtc(s) {
    if (!s) return 0;
    const t = Date.parse(String(s).replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    return isNaN(t) ? 0 : t / 1000;
  }
  function absUrl(u) {
    try { return new URL(u, location.origin).href; } catch (e) { return ""; }
  }
  function intAttr(el, name) {
    const n = parseInt(el.getAttribute(name), 10);
    return isNaN(n) ? 0 : n;
  }
  // The smallest candidate in an <img>'s srcset (thumbnails don't need the 640px one).
  function smallestSrc(img) {
    if (!img) return "";
    let best = "", bw = Infinity;
    (img.getAttribute("srcset") || img.getAttribute("data-lazy-srcset") || "").split(",").forEach((part) => {
      const m = /^\s*(\S+)\s+(\d+)w\s*$/.exec(part);
      if (m && +m[2] < bw) { bw = +m[2]; best = m[1]; }
    });
    return best || img.getAttribute("src") || img.getAttribute("data-lazy-src") || "";
  }

  // A <shreddit-player>'s packaged-media-json lists progressive MP4s (video+audio)
  // on packaged-media.redd.it. Pick the largest that's at most 720p tall.
  function packagedMp4(player) {
    let perms = [];
    try {
      const pm = JSON.parse(player.getAttribute("packaged-media-json") || "null");
      perms = (pm && pm.playbackMp4s && pm.playbackMp4s.permutations) || [];
    } catch (e) {
      return null;
    }
    const opts = perms
      .map((p) => p && p.source)
      .filter((s) => s && /^https:\/\/packaged-media\.redd\.it\//.test(s.url || ""))
      .map((s) => ({ url: s.url, width: (s.dimensions && s.dimensions.width) || 0, height: (s.dimensions && s.dimensions.height) || 0 }))
      .sort((a, b) => a.height - b.height);
    if (!opts.length) return null;
    const fit = opts.filter((o) => o.height && o.height <= 720);
    return fit.length ? fit[fit.length - 1] : opts[0];
  }

  // One <shreddit-post> → the `data` object of a t3 in Reddit's JSON.
  function postFromShreddit(el) {
    const g = (n) => el.getAttribute(n) || "";
    const fullname = g("id");
    if (!/^t3_/.test(fullname)) return null;
    const type = g("post-type");
    const permalink = g("permalink");
    const href = g("content-href");
    const sub = g("subreddit-name") || g("subreddit-prefixed-name").replace(/^r\//, "");
    // A self post: "text", or "multi_media" (text with inline images), or any post
    // that's a self.<sub> domain / links to itself — new Reddit has more types than
    // old reddit's link-vs-self split.
    const isSelf = type === "text" || type === "multi_media" || /^self\./i.test(g("domain")) ||
      (!!href && absUrl(href).replace(/\/+$/, "") === absUrl(permalink).replace(/\/+$/, ""));
    const d = {
      name: fullname, id: fullname.slice(3), permalink,
      title: g("post-title"), author: g("author"), subreddit: sub,
      domain: g("domain") || (isSelf ? "self." + sub : ""),
      score: intAttr(el, "score"), num_comments: intAttr(el, "comment-count"),
      created_utc: isoToUtc(g("created-timestamp")),
      over_18: el.hasAttribute("nsfw"), spoiler: el.hasAttribute("spoiler"),
      stickied: el.hasAttribute("stickied"), locked: el.hasAttribute("locked"),
      subreddit_nsfw: el.hasAttribute("subreddit-nsfw"),
      is_self: isSelf,
      url: absUrl(href || permalink),
    };
    if (el.hasAttribute("is-author-deleted") || !d.author) d.author = "[deleted]";
    if (type === "crosspost") {
      const xm = /\/comments\/([a-z0-9]+)/i.exec(href);
      if (xm) d.crosspost_parent = "t3_" + xm[1];
    }

    const flair = el.querySelector("shreddit-post-flair[slot='post-flair'], shreddit-post-flair");
    const flairText = flair ? flair.textContent.replace(/\s+/g, " ").trim() : "";
    if (flairText) {
      d.link_flair_text = flairText;
      const styled = flair.querySelector("[style*='background']");
      const st = styled ? styled.getAttribute("style") || "" : "";
      const bg = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8})/i.exec(st);
      if (bg) {
        d.link_flair_background_color = bg[1];
        d.link_flair_text_color = /(?:^|;)\s*color\s*:\s*(#fff(?:fff)?|white)\b/i.test(st) ? "light" : "dark";
      }
    }

    // Look for media only in the post's media slot: elsewhere the card carries
    // i.redd.it award/avatar icons that must not be mistaken for the post's image.
    const media = el.querySelector("[slot='post-media-container']") || el;
    // NSFW media comes twice: blur=40 previews (slot "blurred") and the real thing
    // (slot "revealed"). Drop the blurred copy — the extension does its own blurring.
    media.querySelectorAll("shreddit-blurred-container > [slot='blurred']").forEach((n) => n.remove());
    const player = media.querySelector("shreddit-player, shreddit-player-2");
    const gallery = media.querySelector("gallery-carousel");
    const primary = media.querySelector("img[data-post-media-primary]");
    if (player) {
      const vm = /https:\/\/v\.redd\.it\/[A-Za-z0-9]+/.exec(player.getAttribute("src") || (player.querySelector("source") || { getAttribute: () => "" }).getAttribute("src") || href);
      const posterEl = player.querySelector("img[slot='poster']");
      const poster = (posterEl && posterEl.getAttribute("src")) || player.getAttribute("poster") || "";
      const mp4 = packagedMp4(player);
      const gifMp4 = gifPlayerSrc(player);
      if (mp4) {
        // Reddit's own signed, progressive MP4 with the audio muxed in: a plain
        // <video> plays it with sound — no dash.js and no v.redd.it access needed
        // (v.redd.it itself 403s us; see redditVideoReachable).
        d.is_video = true;
        d.media = { reddit_video: { fallback_url: mp4.url, width: mp4.width, height: mp4.height, has_audio: false, orr_muxed: true } };
      } else if (gifMp4) {
        // post-type "gif": Reddit serves the GIF as a silent MP4 rendition
        d.is_video = true;
        d.media = { reddit_video: { fallback_url: gifMp4, is_gif: true, has_audio: false } };
      } else if (vm) {
        d.is_video = true;
        d.media = { reddit_video: { fallback_url: vm[0] + "/CMAF_480.mp4?source=fallback", has_audio: true } };
      }
      if (poster) { d.preview = { images: [{ source: { url: poster } }] }; d.thumbnail = poster; }
    } else if (gallery) {
      const items = [];
      gallery.querySelectorAll("li[slot^='page-']").forEach((li) => {
        const sized = li.querySelector("img[width]");
        const full = li.querySelector("img[src^='https://i.redd.it/']");
        const src = (full && full.getAttribute("src")) || (sized && (sized.getAttribute("src") || sized.getAttribute("data-lazy-src"))) || "";
        if (src) items.push({ src, w: sized ? intAttr(sized, "width") : 0, h: sized ? intAttr(sized, "height") : 0, thumb: smallestSrc(sized) });
      });
      if (items.length) {
        d.is_gallery = true;
        d.gallery_data = { items: items.map((it, i) => ({ media_id: "m" + i })) };
        d.media_metadata = {};
        items.forEach((it, i) => { d.media_metadata["m" + i] = { s: { u: it.src, x: it.w || undefined, y: it.h || undefined } }; });
        d.thumbnail = items[0].thumb || items[0].src;
      }
    } else if (primary && (type === "image" || type === "crosspost")) {
      const full = media.querySelector("img[src^='https://i.redd.it/']:not([src*='/snoovatar/'])");
      const src = (full && full.getAttribute("src")) || primary.getAttribute("src") || "";
      if (src) {
        d.post_hint = "image";
        d.preview = { images: [{ source: { url: src } }] };
        if (type === "image" && /^https:\/\/i\.redd\.it\//.test(href)) d.url = href;
      }
      d.thumbnail = smallestSrc(primary);
    } else if (primary) {
      d.thumbnail = smallestSrc(primary); // a link post's preview card: thumbnail only, like old reddit
    } else {
      const th = el.querySelector("[slot='thumbnail'] img");
      if (th) d.thumbnail = smallestSrc(th);
    }

    // An interactive Devvit app post (games, polls, live threads…): nothing to rebuild
    if (type === "customPost" || el.querySelector("devvit2-custom-post, devvit-blocks-renderer, shreddit-devvit-ui")) d.orr_app = true;

    const ownBody = el.querySelector(`[id="${fullname}-post-rtjson-content"]`);
    const body = ownBody || el.querySelector("shreddit-post-text-body [property='schema:articleBody']");
    const cleaned = body ? cleanMd(body) : "";
    // Listing feeds sometimes send a text+image post's body empty (its figure left out):
    // treat that as no body, like old reddit's empty self post, rather than an empty expando.
    const hasBody = /<img\b/i.test(cleaned) || cleaned.replace(/<[^>]*>|&nbsp;|\s/g, "") !== "";
    const bodyHtml = hasBody ? '<div class="md">' + cleaned + "</div>" : "";
    if (hasBody && (d.is_self || ownBody)) d.selftext_html = bodyHtml; // (a link post can carry body text too)
    else if (hasBody && type === "crosspost") d.crosspost_parent_list = [{ is_self: true, selftext_html: bodyHtml }]; // the original's text
    // Feeds send an image / gallery / video post without its text, even when it has some
    // (only the post's own page carries it): the listing fetches it when the preview opens.
    if (!body && !d.is_self && type !== "crosspost" && (d.post_hint === "image" || d.is_gallery || d.is_video) &&
        el.getAttribute("view-context") !== "CommentsPage") d.orr_text_unsent = true;
    return d;
  }

  // A <shreddit-player> that plays a GIF (post or comment): its src is a silent MP4
  // rendition on Reddit's image CDN. "" if this player isn't one.
  function gifPlayerSrc(player) {
    const src = (player && player.getAttribute("src")) || "";
    return (player.hasAttribute("gif") || /[?&]format=mp4\b/.test(src)) && /^https:\/\/(preview|external-preview|i)\.redd\.it\//.test(src) ? src : "";
  }

  // A subreddit page's "community highlight" cards (its stickies) → t3 data. A card
  // carries the title, permalink, vote/comment counts and sometimes a thumbnail or
  // flair — no author or post time (buildItem leaves those out of the tagline).
  // (Approach from PR #28 by @dirkaw.)
  function stickiesFromHtml(doc) {
    const out = [];
    doc.querySelectorAll("community-highlight-card").forEach((card) => {
      const m = /^highlight_card_(t3_[a-z0-9]+)$/i.exec(card.id || "");
      const a = card.closest("a[href]");
      const permalink = a ? a.getAttribute("href") || "" : "";
      const titleEl = card.querySelector("[slot='title']");
      const title = titleEl ? titleEl.textContent.replace(/\s+/g, " ").trim() : "";
      if (!m || !title || !/^\/r\/[^/]+\/comments\//.test(permalink) || out.some((d) => d.name === m[1])) return;
      const sub = (card.getAttribute("subreddit-prefixed-name") || "").replace(/^r\//i, "");
      const nums = Array.from(card.querySelectorAll("[slot='upvotes-and-comments'] faceplate-number")).map((n) => parseInt(n.getAttribute("number"), 10));
      const flair = card.querySelector("[slot='label'] [aria-label^='Flair:']");
      const thumb = card.getAttribute("src") || "";
      out.push({
        name: m[1], id: m[1].slice(3), title, permalink, url: absUrl(permalink),
        subreddit: sub, domain: "self." + sub, author: "", created_utc: 0,
        score: isNaN(nums[0]) ? 0 : nums[0], hide_score: isNaN(nums[0]), num_comments: isNaN(nums[1]) ? 0 : nums[1],
        is_self: true, stickied: true,
        link_flair_text: flair ? flair.textContent.replace(/\s+/g, " ").trim() : "",
        thumbnail: /^https:\/\//.test(thumb) ? thumb : "",
      });
    });
    return out;
  }

  // A subreddit's right-rail partial → { name, prefixedName, description,
  // weeklyVisitors, weeklyContributions, sections: [{ title, html }] }, or null.
  // Each widget is titled by an h2; its block is the largest ancestor of that
  // title holding no other widget title and not the header.
  // (Approach from PR #28 by @dirkaw.)
  function railFromHtml(doc) {
    const header = doc.querySelector("shreddit-subreddit-header");
    if (!header) return null;
    const num = (n) => { const v = parseInt(header.getAttribute(n), 10); return isNaN(v) ? null : v; };
    // widget titles sit straight in a <div>; rule titles are wrapped in <span>s
    // (usually inside <li>/<details>, but a rule without a description isn't)
    const titles = Array.from(doc.querySelectorAll("h2")).filter((h) =>
      !h.closest("li, details, shreddit-subreddit-header") && h.parentElement && h.parentElement.tagName === "DIV");
    // Find every widget's block before changing the DOM: removing a title early
    // would let later widgets climb past it and swallow their neighbours.
    const blocks = titles.map((h) => {
      let block = h;
      for (let p = block.parentElement; p && p !== doc.body; p = p.parentElement) {
        if (p.contains(header) || titles.some((t) => t !== h && p.contains(t))) break;
        block = p;
      }
      return block === h ? null : { h, block };
    });
    const sections = [];
    blocks.forEach((w) => {
      if (!w) return;
      const links = Array.from(w.block.querySelectorAll("a[href]")).map((x) => x.getAttribute("href"));
      if (links.length && links.every((x) => /^https:\/\/developers\.reddit\.com\/apps\//i.test(x))) return; // "Installed Apps" mod tooling
      const title = w.h.textContent.replace(/\s+/g, " ").trim();
      w.h.remove();
      const html = cleanMd(w.block, { headingsAsStrong: true }).trim();
      if (html.replace(/<[^>]*>/g, "").trim()) sections.push({ title, html });
    });
    return {
      name: header.getAttribute("name") || "",
      prefixedName: header.getAttribute("prefixed-name") || "",
      description: header.getAttribute("description") || "",
      weeklyVisitors: num("weekly-active-users"),
      weeklyContributions: num("weekly-contributions"),
      sections,
    };
  }

  // The HTML partial new Reddit pages listings through, or null where there's no
  // logged-out equivalent (multireddits, combined r/a+b) — those stay native.
  // Logged out, new Reddit's own front page (and r/all, which Reddit redirects
  // there) loads popular-feed. home-feed ignores sort and t, so every tab showed
  // the same multi-day "best" mix.
  function htmlListingPath(route, params, after) {
    const sort = route.sort || "hot";
    const bucket = sort === "top" || sort === "controversial" ? windowBucket(params) || params.t || "" : "";
    const sub = route.scope === "sub" ? String(route.sub || "") : "";
    const q = new URLSearchParams();
    let base;
    if (route.scope === "front" || /^(popular|all)$/i.test(sub)) {
      base = "/svc/shreddit/feeds/popular-feed?";
      q.set("sort", sort.toUpperCase());
      if (after) { q.set("after", btoa(after)); q.set("cursor", btoa(after)); }
    } else if (route.scope === "sub" && !route.combined && /^[A-Za-z0-9_]+$/.test(sub) && sub.toLowerCase() !== "all") {
      base = "/svc/shreddit/community-more-posts/" + encodeURIComponent(sort) + "/?";
      q.set("name", sub);
      if (after) q.set("after", btoa(after));
    } else {
      return null;
    }
    if (bucket) q.set("t", bucket.toUpperCase());
    return base + q.toString();
  }

  async function fetchListingHtml(route, params) {
    // Logged out, r/all is Reddit's front feed (Reddit redirects it to "/"), which
    // has "best": offer that tab there too, and make it the default like on the
    // front page. Logged in, the .json API has no r/all "best", so this only
    // happens here. (Sets it on the route the caller renders with.)
    if (route.scope === "sub" && /^all$/i.test(route.sub || "")) {
      route.bestTab = true;
      if (route.basePath === route.homeBase && !params.after) {
        route.sort = "best";
        route.basePath = route.homeBase + "/best";
      }
    }
    const first = htmlListingPath(route, params, params.after);
    if (!first) {
      const err = new Error("no logged-out listing source");
      err.status = 403;
      throw err;
    }
    const key = "html:" + first;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
    // Stickies aren't in the feed partial — only on the subreddit page itself, as
    // "community highlight" cards. Old reddit shows them atop the first hot page,
    // so fetch that page alongside (best-effort: no stickies if it fails).
    const stickiesP = route.scope === "sub" && (route.sort || "hot") === "hot" && !params.after && !/^all$/i.test(route.sub)
      ? fetchHtmlDoc("/r/" + encodeURIComponent(route.sub) + "/").then(stickiesFromHtml).catch(() => [])
      : Promise.resolve([]);
    const posts = [];
    let next = null, path = first;
    // The front page / r/popular feeds return only ~3 posts on their first call,
    // so keep paging (bounded) until there's a page's worth.
    for (let i = 0; i < 3 && path; i++) {
      const doc = await fetchHtmlDoc(path);
      doc.querySelectorAll("shreddit-post").forEach((el) => {
        if (el.parentElement && el.parentElement.closest("shreddit-post")) return; // a crosspost's embedded original
        const d = postFromShreddit(el);
        if (d && !posts.some((p) => p.name === d.name)) posts.push(d);
      });
      next = posts.length && doc.querySelector("faceplate-partial[src*='after=']") ? posts[posts.length - 1].name : null;
      if (posts.length >= 10 || !next) break;
      path = htmlListingPath(route, params, next);
    }
    // An empty feed is either a subreddit with nothing in this tab right now (r/Android's
    // top of the past 24 hours, a day after its last post) or one we can't see — banned,
    // private, or no such subreddit — whose feed is just as empty. Reddit's small
    // community hover card tells them apart (it's empty for the latter): show the empty
    // listing like old reddit, or leave the page to Reddit's own message.
    if (!posts.length && !params.after && !(route.scope === "sub" && !route.combined && (await hoverPartial("sub", route.sub)))) {
      const err = new Error("empty logged-out listing");
      err.status = 403;
      throw err;
    }
    const adult = route.scope === "sub" && !params.after && posts.length > 0 && // (an empty feed says nothing)
      (posts.some((p) => p.subreddit_nsfw) || posts.filter((p) => p.over_18).length * 2 >= posts.length);
    // A sticky that's also in the feed keeps its fuller feed data, moved to the top.
    const stickies = (await stickiesP).map((s) => {
      const i = posts.findIndex((p) => p.name === s.name);
      if (i < 0) return s;
      const p = posts.splice(i, 1)[0];
      p.stickied = true;
      return p;
    });
    const json = { kind: "Listing", data: { children: stickies.concat(posts).map((d) => ({ kind: "t3", data: d })), after: next, before: null }, orr_adult: adult };
    cache.set(key, { json, t: Date.now() });
    return json;
  }

  // Logged out, search.json is refused too: new Reddit's search results partial (posts
  // only) instead. A subreddit search with "limit my search to r/…" searches just that
  // subreddit; without it, all of Reddit, like old reddit.
  function htmlSearchPath(route, params) {
    const q = new URLSearchParams();
    q.set("q", params.q || "");
    q.set("type", "posts");
    if (params.sort && params.sort !== "relevance") q.set("sort", params.sort);
    if (params.t && params.t !== "all") q.set("t", params.t);
    const sub = route.sub && params.restrict_sr && /^[A-Za-z0-9_]+$/.test(route.sub) ? route.sub : "";
    return "/svc/shreddit" + (sub ? "/r/" + sub : "") + "/search/?" + q.toString();
  }

  // One page of new Reddit's search results (~7 posts) → t3 data, plus the partial that
  // continues it. There's no <shreddit-post> here: each result's title link sits in a
  // <search-telemetry-tracker> whose tracking JSON names the post, its author and its
  // subreddit; the card around it has the time, the vote and comment counts and a
  // thumbnail. (Nothing says what kind of post it is or where a link post points, so
  // every title opens the thread.)
  function searchPostsFromHtml(doc) {
    const posts = [];
    doc.querySelectorAll("a[data-testid='post-title']").forEach((a) => {
      const tr = a.closest("search-telemetry-tracker[data-faceplate-tracking-context]");
      let ctx = null;
      try { ctx = tr && JSON.parse(tr.getAttribute("data-faceplate-tracking-context")); } catch (e) { /* not a post */ }
      const post = (ctx && ctx.post) || {};
      if (!/^t3_[a-z0-9]+$/i.test(post.id || "") || posts.some((p) => p.name === post.id)) return;
      const card = a.closest("[data-testid='search-sdui-post'], [data-testid='search-post-with-content-preview']") || tr.parentElement || tr;
      const sr = ctx.subreddit || {};
      const href = a.getAttribute("href") || "";
      const id = post.id.slice(3);
      const d = {
        name: post.id, id,
        permalink: /^\/(r|user)\/[^/]+\/comments\/[a-z0-9]+\//i.test(href) ? href : "/comments/" + id + "/",
        title: post.title || a.getAttribute("aria-label") || a.textContent.replace(/\s+/g, " ").trim(),
        author: (ctx.profile && ctx.profile.name) || "[deleted]",
        subreddit: sr.name || (/^\/r\/([^/]+)\//.exec(href) || [])[1] || "",
        domain: "", score: 0, num_comments: 0,
        over_18: !!post.nsfw, spoiler: !!post.spoiler, subreddit_nsfw: !!sr.nsfw,
      };
      d.url = absUrl(d.permalink);
      const ts = card.querySelector("faceplate-timeago[ts]");
      d.created_utc = ts ? isoToUtc(ts.getAttribute("ts")) : 0;
      // "1.2K votes · 345 comments"
      card.querySelectorAll("[data-testid='search-counter-row'] faceplate-number").forEach((n) => {
        const v = parseInt(n.getAttribute("number"), 10);
        const num = isNaN(v) ? parseCount(n.textContent) || 0 : v;
        const what = (n.parentElement || n).textContent;
        if (/comment/i.test(what)) d.num_comments = num;
        else if (/vote/i.test(what)) d.score = num;
      });
      const th = card.querySelector("[data-testid='search_post_thumbnail']");
      const thumb = th ? smallestSrc(th) : "";
      // Old reddit draws no thumbnail where a post has none. (Which icon it would
      // get, text or link, can't be told: the results don't say what kind of post it is.)
      if (/^https:\/\//.test(thumb)) d.thumbnail = thumb;
      else if (!d.over_18) d.orr_no_thumb = true;
      posts.push(d);
    });
    const more = doc.querySelector("faceplate-partial[src*='cursor=']");
    const next = more && more.getAttribute("src");
    return { posts, next: isPartialPath(next) && /\/search\/\?/.test(next) ? next : null };
  }

  // A page of search results in the .json shape: `after` is the partial for the next page.
  async function fetchSearchHtml(route, params) {
    const first = params.after && isPartialPath(params.after) ? params.after : htmlSearchPath(route, params);
    const key = "html:" + first;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
    const posts = [];
    let next = null, path = first;
    // ~7 results a call: keep paging (bounded) until there's a page's worth
    for (let i = 0; i < 3 && path; i++) {
      const r = searchPostsFromHtml(await fetchHtmlDoc(path));
      r.posts.forEach((d) => { if (!posts.some((p) => p.name === d.name)) posts.push(d); });
      next = r.posts.length ? r.next : null;
      if (posts.length >= 10) break;
      path = next;
    }
    const json = { kind: "Listing", data: { children: posts.map((d) => ({ kind: "t3", data: d })), after: next, before: null } };
    cache.set(key, { json, t: Date.now() });
    return json;
  }

  async function fetchSearch(route, params) {
    if (!jsonBlocked) {
      const url = searchJsonUrl(route, params);
      const hit = cache.get(url);
      if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
      const res = await redditFetch(url);
      if (!isJsonBlock(res)) {
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
      jsonBlocked = true;
    }
    return fetchSearchHtml(route, params);
  }

  // Only ever fetch/POST same-origin Reddit partials taken from parsed HTML.
  function isPartialPath(p) {
    return typeof p === "string" && p.indexOf("/svc/shreddit/") === 0 && p.indexOf("..") < 0;
  }

  // "N more replies" / ?comments-remaining=N on a more-comments partial.
  function moreCountOf(p) {
    const m = /(\d[\d,]*)\s+more/i.exec(p.textContent || "") || /comments-remaining=(\d+)/.exec(p.getAttribute("src") || "");
    return m ? parseInt(m[1].replace(/,/g, ""), 10) || 0 : 0;
  }

  // <shreddit-comment>s (+ their "more" partials) under `root` → a t1/more tree in
  // Reddit's JSON shape. Comments whose parent isn't in this batch are the roots
  // (top-level comments on a thread page; the stub's own siblings in a partial).
  function commentsFromHtml(root, linkId) {
    const nodes = new Map();
    const roots = [];
    const attach = (parentId, node) => {
      const parent = parentId && nodes.get(parentId);
      (parent ? parent.data.replies.data.children : roots).push(node);
    };
    root.querySelectorAll("shreddit-comment").forEach((el) => {
      const id = el.getAttribute("thingid");
      if (!id || nodes.has(id)) return;
      const anc = el.parentElement && el.parentElement.closest("shreddit-comment");
      const parentId = el.getAttribute("parentid") || (anc && anc.getAttribute("thingid")) || linkId;
      let body = null;
      el.querySelectorAll("[slot='comment']").forEach((b) => { if (!body && b.closest("shreddit-comment") === el) body = b; });
      const deleted = el.hasAttribute("is-comment-deleted") || el.getAttribute("author") === "[deleted]";
      const html = body ? cleanMd(body) : "";
      const node = {
        kind: "t1",
        data: {
          name: id, id: id.slice(3), parent_id: parentId, link_id: linkId,
          author: el.getAttribute("author") || "[deleted]",
          score: intAttr(el, "score"), score_hidden: !el.hasAttribute("score"),
          created_utc: isoToUtc(el.getAttribute("created")),
          permalink: el.getAttribute("permalink") || "",
          body_html: html ? `<div class="md">${html}</div>` : deleted ? '<div class="md"><p>[deleted]</p></div>' : "",
          replies: { data: { children: [] } },
        },
      };
      nodes.set(id, node);
      attach(parentId, node);
    });
    root.querySelectorAll("faceplate-partial[src*='/more-comments/']").forEach((p) => {
      if (!isPartialPath(p.getAttribute("src"))) return;
      const anc = p.closest("shreddit-comment");
      const cursor = p.querySelector("input[name='cursor']");
      attach(anc ? anc.getAttribute("thingid") : null, {
        kind: "more",
        data: { count: moreCountOf(p), children: [], partial: p.getAttribute("src") || "", cursor: cursor ? cursor.value || "" : "" },
      });
    });
    return roots;
  }

  // A thread page → the [postListing, commentListing] pair the .json would return.
  // A thread link without its title slug (/r/x/comments/<id>/, /comments/<id>/) gets a
  // stub page that only redirects to the full URL; the full path it names, if it's
  // the same post on this site — else null.
  function canonicalThreadPath(doc, pathname) {
    const id = (/\/comments\/([a-z0-9]+)/i.exec(pathname) || [])[1];
    const upd = doc.getElementById("canonical-url-updater");
    let u = upd && upd.getAttribute("value");
    if (!u) {
      const call = doc.querySelector("#shreddit-redirect ac-call[method]");
      const m = call && /location\.replace\("([^"]+)"\)/.exec(call.getAttribute("method") || "");
      u = m && m[1];
    }
    if (!u || !id) return null;
    let p;
    try { p = new URL(u, "https://www.reddit.com"); } catch (e) { return null; }
    if (!/(^|\.)reddit\.com$/i.test(p.hostname)) return null;
    return new RegExp("^/r/[A-Za-z0-9_]+/comments/" + id + "/[^/?#]+/").test(p.pathname) && p.pathname !== pathname ? p.pathname : null;
  }
  async function fetchCommentsHtml(pathname, sort, commentId) {
    const s = sort === "best" ? "confidence" : sort; // new Reddit's name for "best" (from PR #28)
    const q = s ? "?sort=" + encodeURIComponent(s) : "";
    let doc = await fetchHtmlDoc(pathname + q);
    let postEl = doc.querySelector("shreddit-post");
    if (!postEl) {
      const full = canonicalThreadPath(doc, pathname); // a short link: follow its redirect once
      if (full) { doc = await fetchHtmlDoc(full + q); postEl = doc.querySelector("shreddit-post"); }
    }
    const post = postEl && postFromShreddit(postEl);
    if (!post) {
      const err = new Error("no post in thread HTML");
      err.status = 403;
      throw err;
    }
    let tree = commentsFromHtml(doc, post.name);
    if (commentId) {
      // A single comment's permalink: the page carries the whole thread, but old
      // reddit shows just the top-level thread holding that comment.
      const id = "t1_" + commentId;
      const holds = (n) => n.kind === "t1" && (n.data.name === id || n.data.replies.data.children.some(holds));
      const root = tree.find(holds);
      if (root) tree = [root];
    }
    return [
      { kind: "Listing", data: { children: [{ kind: "t3", data: post }] } },
      { kind: "Listing", data: { children: tree } },
    ];
  }

  // Just the post from a thread page, for a hover peek. The post comes first (~60 KB of a
  // page that runs to ~1 MB with its comments), so read until it's complete and stop.
  async function fetchPostOnly(pathname) {
    const res = await redditFetch(location.origin + pathname, { credentials: "include", headers: { Accept: HTML_ACCEPT } });
    if (!res.ok) {
      const err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    let text = "";
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) text = await res.text();
    else {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const from = Math.max(0, text.length - 20);
        text += dec.decode(value, { stream: true });
        if (text.indexOf("</shreddit-post>", from) >= 0 || text.length > 2e6) {
          reader.cancel().catch(() => {}); // the comments aren't needed
          break;
        }
      }
    }
    const el = parseHtmlDoc(text).querySelector("shreddit-post");
    const d = el && postFromShreddit(el);
    // a ~640px rendition for the peek, not the full-size original the expando uses
    const img = d && el.querySelector("[slot='post-media-container'] img[data-post-media-primary], gallery-carousel li[slot^='page-'] img[srcset]");
    if (img) d.orr_peek_img = srcNear(img, 640);
    return d;
  }
  // The srcset candidate closest to `want` px wide (at least it, if there is one).
  function srcNear(img, want) {
    let best = "", bw = 0;
    (img.getAttribute("srcset") || "").split(",").forEach((part) => {
      const m = /^\s*(\S+)\s+(\d+)w\s*$/.exec(part);
      if (!m) return;
      const w = +m[2];
      if (!best || (bw < want ? w > bw : w >= want && w < bw)) { best = m[1]; bw = w; }
    });
    const src = best || img.getAttribute("src") || "";
    return /^https:\/\//.test(src) ? src : "";
  }

  // ---- logged-out user profiles: Reddit's profile feed partials ----
  // overview / submitted / comments each have a feed (25 per page, after=base64
  // fullname, like listings). Sorting is a query param — the path segment is ignored.
  // The private sections (saved, upvoted…) need a login, so they stay native.
  const PROFILE_FEEDS = { overview: "profile_overview-more-posts", submitted: "profile_posts-more-posts", comments: "profile_comments-more-posts" };
  function htmlUserPath(ur, sort, t, after) {
    const feed = PROFILE_FEEDS[ur.section];
    if (!feed || !/^[A-Za-z0-9_-]+$/.test(ur.name || "")) return null;
    const s = sort || "new";
    const q = new URLSearchParams({ name: ur.name, sort: s });
    if (t && (s === "top" || s === "controversial")) q.set("t", t);
    if (after) q.set("after", btoa(after));
    return `/svc/shreddit/profiles/${feed}/${encodeURIComponent(s)}/?` + q.toString();
  }

  // One <shreddit-profile-comment> → the t1 `data` a user page's .json would carry.
  function profileCommentFromShreddit(el) {
    const id = el.getAttribute("comment-id") || "";
    if (!/^t1_/.test(id)) return null;
    const title = el.querySelector("h2 a[href]");
    const subA = Array.from(el.querySelectorAll("a[href^='/r/']")).find((a) => /^\/r\/[^/]+\/?$/.test(a.getAttribute("href")));
    const userA = el.querySelector("a[href^='/user/']");
    const um = userA && /^\/user\/([^/?#]+)/.exec(userA.getAttribute("href"));
    const row = el.querySelector("shreddit-comment-action-row[score]");
    const score = row ? parseInt(row.getAttribute("score"), 10) : NaN;
    const ts = el.querySelector("faceplate-timeago[ts]");
    const body = el.querySelector("[id$='-post-rtjson-content']");
    const post = el.querySelector("[post-id^='t3_']");
    const html = body ? cleanMd(body) : "";
    return {
      name: id, id: id.slice(3), author: um ? um[1] : "[deleted]",
      score: isNaN(score) ? 0 : score, score_hidden: isNaN(score),
      created_utc: ts ? isoToUtc(ts.getAttribute("ts")) : 0,
      permalink: el.getAttribute("href") || "",
      link_title: title ? title.textContent.replace(/\s+/g, " ").trim() : "",
      link_permalink: title ? title.getAttribute("href") || "" : "",
      link_id: post ? post.getAttribute("post-id") : "",
      subreddit: subA ? subA.getAttribute("href").split("/")[2] : "",
      body_html: html ? `<div class="md">${html}</div>` : "",
    };
  }

  async function fetchUserHtml(ur, sort, t, after) {
    const path = htmlUserPath(ur, sort, t, after);
    if (!path) {
      const err = new Error("no logged-out source for this profile section");
      err.status = 403;
      throw err;
    }
    const key = "html:" + path;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
    const doc = await fetchHtmlDoc(path);
    const children = [];
    doc.querySelectorAll("shreddit-post, shreddit-profile-comment").forEach((el) => {
      if (el.tagName.toLowerCase() === "shreddit-post") {
        if (el.parentElement && el.parentElement.closest("shreddit-post")) return; // a crosspost's embedded original
        const d = postFromShreddit(el);
        if (d) children.push({ kind: "t3", data: d });
      } else {
        const d = profileCommentFromShreddit(el);
        if (d) children.push({ kind: "t1", data: d });
      }
    });
    let emptyText = "";
    if (!children.length && !after) {
      // Nothing to show: either the account keeps its posts hidden / hasn't posted, or
      // it doesn't exist. The (cheap) hover card tells them apart — a real account
      // still gets the old-layout profile with its stats; a missing one gets Reddit's
      // own "nobody on Reddit goes by that name" page.
      if (!(await hoverPartial("user", ur.name))) {
        const err = new Error("no such user");
        err.status = 404;
        throw err;
      }
      emptyText = `there doesn't seem to be anything here — u/${ur.name} may keep their posts hidden`;
    }
    const last = children.length ? children[children.length - 1].data.name : null;
    const next = last && doc.querySelector("faceplate-partial[src*='more-posts'][src*='after=']") ? last : null;
    const posts = children.filter((c) => c.kind === "t3");
    const adult = !after && posts.length > 0 && posts.filter((c) => c.data.over_18).length * 2 >= posts.length;
    const json = { kind: "Listing", data: { children, after: next, before: null }, orr_adult: adult, orr_emptyText: emptyText };
    cache.set(key, { json, t: Date.now() });
    return json;
  }

  // Logged out, adult (NSFW) communities and posts sit behind a one-click "over 18?"
  // gate, like old reddit's interstitial (logged in, Reddit applies the account's
  // own setting). The answer is remembered on this device.
  let over18Ok = null;
  async function over18Confirmed() {
    if (over18Ok === null) {
      try {
        const r = await api.storage.local.get("over18");
        over18Ok = !!(r && r.over18);
      } catch (e) {
        over18Ok = false;
      }
    }
    return over18Ok;
  }
  function confirmOver18() {
    over18Ok = true;
    try { api.storage.local.set({ over18: true }); } catch (e) { /* this page still proceeds */ }
  }
  // Show the gate in place of the page; `proceed` renders the already-fetched page.
  function showAgeGate(sub, isPost, proceed, what) {
    active = true; // before replaceBody(): see loadListing's comment on why
    replaceBody(buildAgeGate({ sub, post: isPost, what, me: meCached }), "over 18? — old reddit");
    patchHeader();
    const yes = document.querySelector(".orr-over18-yes");
    if (yes) yes.addEventListener("click", () => {
      confirmOver18();
      window.scrollTo(0, 0);
      proceed();
    });
  }

  async function fetchListing(route, params) {
    if (jsonBlocked) return fetchListingHtml(route, params);
    const url = jsonUrlFor(route, params);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.json;
    const res = await redditFetch(url);
    if (isJsonBlock(res)) {
      jsonBlocked = true;
      return fetchListingHtml(route, params);
    }
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

  // New Reddit's own CSS must not style the rebuilt page. Its stylesheets stay in
  // <head> after the body swap, and its still-running scripts keep adding more
  // (e.g. the logged-out Google sign-in prompt's) — together they restyled
  // old-reddit's markup (capitalised labels, resized fonts: the "formatting errors"
  // reviewers saw, notably logged out). Drop them once we own the page and keep
  // dropping late arrivals. Only Reddit/Google stylesheet links and class-less
  // <style>s go: other extensions' styles (Dark Reader, Stylus…) carry a class.
  let nativeCssObserver = null;
  function isNativeCss(n) {
    if (!n || n.nodeType !== 1) return false;
    if (n.tagName === "STYLE") return !n.hasAttribute("class") && !/^orr-/.test(n.id || "");
    if (n.tagName === "LINK")
      return /(^|\s)stylesheet(\s|$)/i.test(n.getAttribute("rel") || "") &&
        /^https:\/\/([\w-]+\.)*(redditstatic\.com|reddit\.com|redditmedia\.com|gstatic\.com|google\.com)\//i.test(n.href || "");
    return false;
  }
  function purgeNativeCss() {
    document.querySelectorAll("head > style, head > link, html > style, html > link, body > style, body > link").forEach((n) => {
      if (isNativeCss(n)) n.remove();
    });
    if (typeof MutationObserver === "undefined") return;
    if (!nativeCssObserver) {
      nativeCssObserver = new MutationObserver((muts) => {
        if (!active) return; // fell back to native Reddit → leave its styles alone
        muts.forEach((m) => m.addedNodes.forEach((n) => { if (isNativeCss(n)) n.remove(); }));
      });
      if (document.head) nativeCssObserver.observe(document.head, { childList: true });
      nativeCssObserver.observe(document.documentElement, { childList: true });
    }
    // Reddit also lazy-loads component CSS as <link>s appended to <body> (seen in
    // Firefox); replaceBody swaps the body out, so re-arm on each new one.
    if (document.body) nativeCssObserver.observe(document.body, { childList: true });
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
    purgeNativeCss();
    try {
      document.title = title;
    } catch (e) {
      /* ignore */
    }
    afterRender();
  }

  function renderInto(route, json, params) {
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    const sinceUtc = windowSince(params); // custom "last N hours/days" window (null otherwise)
    const body = buildBody(route, json, { startCount, t: params.t, days: params.days, hours: params.hours, sinceUtc, me: meCached });
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
        const j = await fetchListing(route, { after, count, t: params.t, days: params.days, hours: params.hours });
        // Skip posts already on the page: "hot" re-ranks between page fetches, so a
        // post can resurface on a later page (seen live on busy subs).
        let kids = (((j && j.data) || {}).children || []).filter((c) => c.kind === "t3" && !document.getElementById("thing_" + c.data.name));
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
    if (jsonBlocked) return { about: null, rules: null }; // logged-out: these .json calls would just 403
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
    const side = document.querySelector(".side"); // this page's — a later nav swaps the body
    let v;
    try {
      v = await fetchAboutRules(sub);
    } catch (e) {
      return;
    }
    let html = v && v.about && v.about.data ? buildSidebar(v.about, v.rules) : "";
    if (!html && jsonBlocked) {
      const rail = await fetchRail(sub); // logged out: about.json is blocked
      if (rail) html = buildRailSidebar(rail);
    }
    if (html && side && side.isConnected) { side.insertAdjacentHTML("beforeend", html); linkifyEmails(side); }
  }

  async function fetchRail(sub) {
    const key = "rail:" + sub.toLowerCase();
    const hit = aboutCache.get(key);
    if (hit && Date.now() - hit.t < ABOUT_TTL) return hit.v;
    let v = null;
    try {
      v = railFromHtml(await fetchHtmlDoc("/svc/shreddit/feeds/subreddit-right-rail?name=" + encodeURIComponent(sub)));
    } catch (e) {
      /* no sidebar */
    }
    aboutCache.set(key, { v, t: Date.now() });
    return v;
  }

  function renderError(status) {
    pendingScrollRestore = null; // a failed nav must not scroll the error/old page
    const st = document.getElementById("siteTable");
    const msg = "Classic Layout for Reddit: couldn't load this page from Reddit (" + (status || "network error") + ") — try again in a moment.";
    if (st) st.innerHTML = `<div class="thing"><div class="entry"><p>${esc(msg)}</p></div></div>`;
  }

  // An in-page navigation whose data Reddit refused (e.g. a user page while logged
  // out — there's no HTML fallback for those): hand the URL to a real page load
  // instead of stranding the reader on an error stub. pushState already put this
  // URL in history, so replace() rather than add a duplicate entry; the reload's
  // first-load path then falls back to native Reddit. Transient failures (rate
  // limit / 5xx / network) keep the in-page message — a reload would hit the same wall.
  function failNav(url, status) {
    if (isTransient(status)) {
      renderError(status);
      unhideGuard();
      return;
    }
    try {
      location.replace(url.href);
    } catch (e) {
      renderError(status);
      unhideGuard();
    }
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
      hours: url.searchParams.get("hours"),
    };
    // Per-subreddit default sort/time: only on the FIRST load of a bare /r/{sub}
    // (typed/bookmarked/external). Not on SPA navs — otherwise the "hot" tab, whose
    // href is the same bare URL, would bounce straight back to the default sort.
    const sp = firstLoad && route.scope === "sub" && route.sub ? (dataCache.subPrefs || {})[route.sub.toLowerCase()] : null;
    if (sp && sp.sort && sp.sort !== "hot" && /^\/r\/[^/]+\/?$/.test(url.pathname) && !params.after && !params.before && !params.t && !params.days && !params.hours) {
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
      else failNav(url, lastStatus);
      return;
    }
    await ensureCss();
    if (json.orr_adult && !(await over18Confirmed())) {
      // logged-out adult community: old reddit's one-click "over 18?" gate first
      showAgeGate(route.sub, false, () => { try { renderInto(route, json, params); } catch (e) { /* stay on the gate */ } });
      unhideGuard();
      return;
    }
    // Never leave the page hidden if a render helper throws on some odd payload.
    try {
      // Set before rendering, not after: afterRender() synchronously synthesizes
      // clicks (expandImagesPass, applySubPrefs' autoExpand) that the delegated
      // click handler in wireNav() drops while active is still false — those
      // posts silently never expanded on a page's first load.
      active = true;
      renderInto(route, json, params);
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
    // Same pathname as the comments page we just rendered → this is a sort-order
    // change on the thread the user is already reading, not a fresh visit (see
    // markNewComments). loadPage() clears lastCommentsPathname on navigating
    // anywhere else, so a genuine later re-visit to the same thread isn't
    // mistaken for this.
    commentsResortInPlace = url.pathname === lastCommentsPathname;
    lastCommentsPathname = url.pathname;
    hideGuard();
    let watchdog = null;
    // (longer than the JSON path needs: a logged-out load reads the ~1MB thread HTML)
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 15000);
    let data;
    try {
      if (jsonBlocked) {
        data = await fetchCommentsHtml(url.pathname, sort, cr.commentId);
      } else {
        const q = new URLSearchParams({ raw_json: "1", limit: "200" });
        if (sort) q.set("sort", sort);
        const jsonUrl = location.origin + url.pathname.replace(/\/$/, "") + "/.json?" + q.toString();
        const res = await redditFetch(jsonUrl);
        if (isJsonBlock(res)) {
          jsonBlocked = true;
          data = await fetchCommentsHtml(url.pathname, sort, cr.commentId);
        } else {
          if (!res.ok) {
            const e = new Error("HTTP " + res.status);
            e.status = res.status;
            throw e;
          }
          data = await res.json();
        }
      }
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) {
        active = false;
        unhideGuard();
      } else {
        failNav(url, err.status || 0);
      }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    const render = () => {
      const body = buildCommentsBody(data, { sub: cr.sub, permalink: url.pathname, sort, me: meCached, singleComment: !!cr.commentId });
      active = true; // before replaceBody(): see loadListing's comment on why
      replaceBody(body, (body.sub ? "r/" + body.sub : "reddit") + " — comments");
      unhideGuard();
      patchHeader();
      const realSub = body.sub || cr.sub;
      rememberSub(realSub);
      rememberCommentSort(realSub, sort);
      addOtherDiscussions(data);
      addMarkUnreadButton();
      loadSidebar({ scope: "sub", sub: realSub });
      checkCommentBlock(realSub); // banned / approved users only → say so instead of a comment box
    };
    const post = data && data[0] && data[0].data && data[0].data.children && data[0].data.children[0] && data[0].data.children[0].data;
    if (jsonBlocked && post && post.over_18 && !(await over18Confirmed())) {
      // logged-out adult post: old reddit's one-click "over 18?" gate first
      showAgeGate(post.subreddit || cr.sub, true, render);
      unhideGuard();
      return;
    }
    render();
  }

  async function loadUser(url, firstLoad) {
    const ur = ORR.isUserRoute(url);
    if (!ur) return;
    const rawSort = url.searchParams.get("sort");
    const sort = USER_SORTS.indexOf(rawSort) >= 0 ? rawSort : null; // null → Reddit's default (new)
    const t = (sort === "top" || sort === "controversial") ? url.searchParams.get("t") : null;
    const params = { after: url.searchParams.get("after"), count: url.searchParams.get("count") };
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    let json;
    try {
      if (jsonBlocked) {
        json = await fetchUserHtml(ur, sort, t, params.after);
      } else {
        const q = new URLSearchParams({ raw_json: "1", limit: "25" });
        if (sort) q.set("sort", sort);
        if (t) q.set("t", t);
        if (params.after) {
          q.set("after", params.after);
          q.set("count", params.count || "25");
        }
        const jsonUrl = location.origin + ur.basePath + "/.json?" + q.toString();
        const res = await redditFetch(jsonUrl);
        if (isJsonBlock(res)) {
          jsonBlocked = true; // logged out → Reddit's profile feed partials
          json = await fetchUserHtml(ur, sort, t, params.after);
        } else {
          if (!res.ok) {
            const e = new Error("HTTP " + res.status);
            e.status = res.status;
            throw e;
          }
          json = await res.json();
        }
      }
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) {
        active = false;
        unhideGuard();
      } else {
        failNav(url, err.status || 0);
      }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    await fetchMe(); // (your own profile gets the saved / upvoted / downvoted / hidden tabs)
    if (json.orr_adult && !(await over18Confirmed())) {
      // logged-out profile that's mostly adult posts: the same one-click "over 18?" gate
      showAgeGate(null, false, () => renderUser(ur, json, params, sort, t), "profile");
      unhideGuard();
      return;
    }
    renderUser(ur, json, params, sort, t);
  }

  function renderUser(ur, json, params, sort, t) {
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    active = true; // before replaceBody(): see loadListing's comment on why
    replaceBody(buildUserPage(ur, json, { startCount, me: meCached, sort, t }), "u/" + ur.name + " — old reddit");
    unhideGuard();
    patchHeader();
    loadUserSidebar(ur.name);

    const l0 = (json && json.data) || {};
    const c0 = startCount + (l0.children || []).length;
    setupInfinite(
      async (after, count) => {
        let j2;
        if (jsonBlocked) {
          j2 = await fetchUserHtml(ur, sort, t, after);
        } else {
          const q = new URLSearchParams({ raw_json: "1", limit: "25", after, count: String(count) });
          if (sort) q.set("sort", sort);
          if (t) q.set("t", t);
          const r2 = await redditFetch(location.origin + ur.basePath + "/.json?" + q.toString());
          if (!r2.ok) { const e = new Error("HTTP " + r2.status); e.status = r2.status; e.retryAfter = retryAfterOf(r2); throw e; }
          j2 = await r2.json();
        }
        // (skip anything already on the page — the feed can shift between pages)
        const kids = (((j2 && j2.data) || {}).children || []).filter((c) => !c.data || !document.getElementById("thing_" + c.data.name));
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
    const side = document.querySelector(".side"); // this page's — a later nav swaps the body
    try {
      let about = null;
      if (jsonBlocked) {
        // logged out: about.json is blocked; the user hover-card partial has the same basics
        const h = await hoverPartial("user", name);
        if (h) about = { data: { name: h.name || name, link_karma: h.postKarma, comment_karma: h.commentKarma, created_utc: h.created } };
      } else {
        const res = await redditFetch(location.origin + "/user/" + encodeURIComponent(name) + "/about.json?raw_json=1");
        if (!res.ok) return;
        about = await res.json();
      }
      if (side && side.isConnected && about && about.data) side.insertAdjacentHTML("beforeend", buildUserSidebar(about));
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
      json = await fetchSearch(route, params);
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) {
        active = false;
        unhideGuard();
      } else {
        failNav(url, err.status || 0);
      }
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    // (logged out, a "t3_…" after can't be followed: that's page 1 again)
    const startCount = params.after && (!jsonBlocked || isPartialPath(params.after)) ? parseInt(params.count || "25", 10) || 0 : 0;
    active = true; // before replaceBody(): see loadListing's comment on why
    replaceBody(buildSearchPage(json, { route, params, startCount, me: meCached }), (params.q ? params.q + " — " : "") + "search — old reddit");
    unhideGuard();
    patchHeader();

    const l0 = (json && json.data) || {};
    const c0 = startCount + (l0.children || []).filter((c) => c.kind === "t3").length;
    setupInfinite(
      async (after, count) => {
        const j2 = await fetchSearch(route, Object.assign({}, params, { after, before: null, count }));
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
    if (autoplayObserver) { autoplayObserver.disconnect(); autoplayObserver = null; }
    // Leaving comments entirely (not just re-sorting) — a later return to the
    // same thread should count as a genuine fresh visit again.
    if (!ORR.isCommentsRoute(url)) lastCommentsPathname = null;
    if (ORR.isListingRoute(url)) return loadListing(url, firstLoad);
    if (ORR.isCommentsRoute(url)) return loadComments(url, firstLoad);
    if (ORR.isUserRoute(url)) return loadUser(url, firstLoad);
    if (ORR.isSearchRoute(url)) return loadSearch(url, firstLoad);
    if (ORR.isWikiRoute && ORR.isWikiRoute(url)) return loadWiki(url, firstLoad);
    if (ORR.isMessageRoute && ORR.isMessageRoute(url)) return loadMessages(url, firstLoad);
  }
  // The pages this extension rebuilds (everything else stays new Reddit).
  function isRebuiltRoute(url) {
    return !!(ORR.isListingRoute(url) || ORR.isCommentsRoute(url) || ORR.isUserRoute(url) || ORR.isSearchRoute(url) ||
      (ORR.isWikiRoute && ORR.isWikiRoute(url)) || (ORR.isMessageRoute && ORR.isMessageRoute(url)));
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
      if (firstLoad) { active = false; unhideGuard(); } else failNav(url, err.status || 0);
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    active = true; // before replaceBody(): see loadListing's comment on why
    replaceBody(buildWikiPage(route, json, { me: meCached }), (route.sub ? "r/" + route.sub : "reddit") + " wiki — old reddit");
    unhideGuard();
    patchHeader();
    if (route.sub) loadSidebar({ scope: "sub", sub: route.sub });
  }

  // Expand a "load more comments" stub via the morechildren API, re-nesting the
  // returned comments under their parent by parent_id. Best-effort (experimental).
  const moreTimers = new Set(); // pending comment-retry timers, cleared on navigation

  async function handleMore(el, auto) {
    // Never load into a collapsed thread. The stub is hidden inside a collapsed
    // subtree, so a load here can only come from a stale retry timer or another
    // programmatic/keyboard path — and would graft comments into a subtree the
    // user has deliberately hidden. Top-level "load more comments" has no
    // collapsed comment ancestor, so the scroll auto-loader is unaffected.
    if (el.closest(".thing.comment.collapsed")) return;
    if (el.hasAttribute("data-partial")) return loadMorePartial(el, auto);
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

  // Logged-out fallback for a "load more comments" stub: POST the more-comments
  // partial new Reddit itself uses (with its cursor) and splice the returned
  // comments in where the stub sits — they're the stub's siblings, i.e. further
  // replies to its parent (or further top-level comments).
  async function loadMorePartial(el, auto) {
    const src = el.getAttribute("data-partial");
    if (el.dataset.orrLoading || !isPartialPath(src)) return;
    el.dataset.orrLoading = "1";
    const linkId = el.getAttribute("data-link");
    el.textContent = "loading more comments…";
    let status = 0, retryAfter = 0, roots = null;
    try {
      const body = new URLSearchParams();
      const cursor = el.getAttribute("data-cursor");
      if (cursor) body.set("cursor", cursor);
      // Not required today, but it's what new Reddit's own button sends (via PR #28).
      const csrf = (/(?:^|;\s*)csrf_token=([^;]*)/.exec(document.cookie || "") || [])[1];
      if (csrf) body.set("csrf_token", decodeURIComponent(csrf));
      const res = await redditFetch(location.origin + src, {
        method: "POST", credentials: "include",
        headers: { Accept: HTML_ACCEPT, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      status = res.status;
      retryAfter = retryAfterOf(res);
      if (res.ok) roots = commentsFromHtml(parseHtmlDoc(await res.text()), linkId);
    } catch (e) {
      status = 0; // network error → treat as transient
    }
    if (!el.isConnected) return; // navigated away
    if (roots) {
      el.dataset.orrAttempt = "";
      const wrap = el.parentElement; // .morecomments
      const fresh = roots.filter((c) => c.kind !== "t1" || !document.getElementById("thing_" + c.data.name));
      const tmp = document.createElement("div");
      tmp.innerHTML = buildCommentTree(fresh, linkId, nowMsNow());
      if (wrap && wrap.parentNode) {
        while (tmp.firstElementChild) wrap.parentNode.insertBefore(tmp.firstElementChild, wrap);
        wrap.remove();
      }
      patchTags(document);
      inlineImages(document);
      enhanceComments(document);
      flagNewComments(document);
      clampReadBodies();
      observeMores();
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
    flagNewComments(document); // flag any newly-loaded comments created since your last visit
    clampReadBodies(); // give newly-loaded read bodies the "click to expand" affordance
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
    document.querySelectorAll("a.orr-more[data-children]:not([data-orr-observed]), a.orr-more[data-partial]:not([data-orr-observed])").forEach((a) => {
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

  // ---------- logged-in actions (issues #1, #11) ------------------------
  // Voting, save, hide, report, reply, edit, delete, join/leave and the inbox write
  // to Reddit's classic API the way old reddit's own JS did: same-origin POSTs with
  // your session cookie plus the modhash ("uh") from /api/me.json. Nothing is sent
  // unless you click (or press a shortcut for) the action.

  function myName() {
    const id = meIdentity(meCached);
    return id ? id.name : "";
  }
  function myModhash() {
    const d = meCached && (meCached.data || meCached);
    return (d && d.modhash) || "";
  }
  function refreshMe() {
    mePromise = null;
    return fetchMe();
  }
  function refreshHeader() {
    mePromise = null;
    patchHeader(); // re-renders the userbar (mail badge, karma) from a fresh me.json
  }
  function orrError(msg, code) {
    const e = new Error(msg);
    e.code = code || "";
    return e;
  }
  // POST a form to Reddit's API; resolves with the JSON (or {}), or throws an Error
  // whose message can be shown as is — Reddit's own text when it sends one.
  async function authedPost(path, params) {
    await fetchMe();
    if (!myName()) throw orrError("you need to log in to do that", "LOGIN");
    const once = () => {
      const mh = myModhash();
      const body = new URLSearchParams(params || {});
      body.set("uh", mh);
      return redditFetch(location.origin + path, {
        method: "POST", credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "X-Modhash": mh },
        body: body.toString(),
      });
    };
    let res;
    try { res = await once(); } catch (e) { throw orrError("network error — try again", "NETWORK"); }
    if (res.status === 403) {
      // a stale modhash (or a session that ended): fetch a fresh one and try once more
      await refreshMe();
      if (!myName()) throw orrError("you've been logged out — log in again", "LOGIN");
      try { res = await once(); } catch (e) { throw orrError("network error — try again", "NETWORK"); }
    }
    if (res.status === 429) throw orrError("Reddit says you're doing that too much — wait a minute and try again", "RATELIMIT");
    if (res.status === 403) throw orrError("Reddit refused that (403 forbidden)", "HTTP403");
    if (!res.ok) throw orrError("Reddit answered with an error (" + res.status + ")", "HTTP" + res.status);
    let j = null;
    try { j = await res.json(); } catch (e) { /* some endpoints answer with an empty body */ }
    const errs = j && j.json && j.json.errors;
    if (errs && errs.length) throw orrError(String(errs[0][1] || errs[0][0] || "Reddit refused that"), String(errs[0][0] || ""));
    return j || {};
  }
  // Full data for one post / comment (raw_json, like the rest of the page).
  async function fetchThingData(name) {
    const r = await redditFetch(location.origin + "/api/info.json?raw_json=1&id=" + encodeURIComponent(name));
    if (!r.ok) return null;
    const j = await r.json();
    const c = j && j.data && j.data.children && j.data.children[0];
    return c && c.data ? c.data : null;
  }

  // Logged in: html.orr-logged-in (CSS reveals the account buttons), your own posts /
  // comments get .orr-mine (edit / delete), and the comment box gets filled in.
  function applyLoginState(scope) {
    const me = myName();
    document.documentElement.classList.toggle("orr-logged-in", !!me);
    if (!me) return;
    const lc = me.toLowerCase();
    const root = scope && scope.querySelectorAll ? scope : document;
    const mark = (t) => t.classList.toggle("orr-mine", (t.getAttribute("data-author") || "").toLowerCase() === lc);
    if (root.matches && root.matches(".thing[data-author]")) mark(root);
    root.querySelectorAll(".thing[data-author]").forEach(mark);
    document.querySelectorAll(".orr-topform").forEach((ph) => {
      if (!ph.querySelector("form")) ph.appendChild(makeEditor("top", ph.getAttribute("data-thing") || ""));
    });
  }
  function loginNudge(what) {
    showToast("you need to log in to " + what);
    const t = document.getElementById("orr-toast");
    if (!t) return;
    const a = document.createElement("a");
    a.href = "/login/?dest=" + encodeURIComponent(location.href);
    a.textContent = "log in";
    t.appendChild(document.createTextNode(" — "));
    t.appendChild(a);
  }
  function thingOf(el) {
    return el && el.closest ? el.closest(".thing[data-fullname]") : null;
  }
  // Every action needs you logged in; nudge (and say so) when you're not.
  async function needLogin(what) {
    await fetchMe();
    if (myName()) return false;
    loginNudge(what);
    return true;
  }

  // ---- voting ----
  function setVoteUi(thing, dir) {
    const vs = dir === 1 ? "likes" : dir === -1 ? "dislikes" : "unvoted";
    const midcol = thing.querySelector(":scope > .midcol");
    [midcol, thing.querySelector(":scope > .entry")].forEach((el) => {
      if (!el) return;
      el.classList.remove("likes", "dislikes", "unvoted");
      el.classList.add(vs);
    });
    if (midcol) {
      const up = midcol.querySelector(".arrow.up, .arrow.upmod");
      const down = midcol.querySelector(".arrow.down, .arrow.downmod");
      if (up) { up.classList.toggle("upmod", dir === 1); up.classList.toggle("up", dir !== 1); up.setAttribute("aria-pressed", String(dir === 1)); }
      if (down) { down.classList.toggle("downmod", dir === -1); down.classList.toggle("down", dir !== -1); down.setAttribute("aria-pressed", String(dir === -1)); }
    }
    const base = parseInt(thing.dataset.orrBase, 10);
    thing.querySelectorAll(":scope > .midcol > .score, :scope > .entry > .tagline .score").forEach((sc) => {
      sc.classList.remove("likes", "dislikes", "unvoted");
      sc.classList.add(vs);
      if (isNaN(base)) return; // score hidden
      const n = base + dir;
      if (sc.parentElement.classList.contains("midcol")) {
        if (/^-?\d+$/.test(sc.textContent.trim())) { sc.textContent = String(n); sc.title = String(n); }
      } else if (/point/.test(sc.textContent)) {
        sc.textContent = n + (n === 1 ? " point" : " points");
      }
    });
  }
  // Clicking the arrow you already voted with takes the vote back, like old reddit.
  async function vote(thing, clicked) {
    if (!thing || (await needLogin("vote"))) return;
    if (thing.dataset.archived === "true") { showToast("this is archived — voting is closed"); return; }
    const midcol = thing.querySelector(":scope > .midcol");
    if (!midcol || thing.dataset.orrVoting) return;
    const prev = midcol.classList.contains("likes") ? 1 : midcol.classList.contains("dislikes") ? -1 : 0;
    const dir = prev === clicked ? 0 : clicked;
    // Reddit's score already counts your vote; keep the score without it to add back
    if (thing.dataset.orrBase == null && /^-?\d+$/.test(thing.dataset.score || "")) thing.dataset.orrBase = String(parseInt(thing.dataset.score, 10) - prev);
    setVoteUi(thing, dir);
    thing.dataset.orrVoting = "1";
    try {
      await authedPost("/api/vote", { id: thing.dataset.fullname, dir: String(dir), rank: "2" });
      trackUserVote(thing.getAttribute("data-author"), dir - prev);
    } catch (e) {
      setVoteUi(thing, prev);
      showToast("couldn't vote: " + e.message);
    } finally {
      delete thing.dataset.orrVoting;
    }
  }
  // RES-style vote weight: your net votes on each user, shown as [+3] after their name.
  function trackUserVote(author, delta) {
    if (!author || author === "[deleted]" || !delta) return;
    const k = author.toLowerCase();
    const v = Object.assign({}, dataCache.userVotes || {});
    v[k] = (v[k] || 0) + delta;
    if (!v[k]) delete v[k];
    dataCache.userVotes = v;
    try { ORR.setPrefs({ userVotes: v }); } catch (e) { /* ignore */ }
    patchUserVotes(document);
  }
  function patchUserVotes(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const v = dataCache.userVotes || {};
    root.querySelectorAll("a.author").forEach((a) => {
      const m = /\/user\/([^/?#]+)/.exec(a.getAttribute("href") || "");
      if (!m) return;
      const tag = a.nextElementSibling && a.nextElementSibling.classList.contains("orr-usertag") ? a.nextElementSibling : null;
      const after = tag || a;
      let badge = after.nextElementSibling && after.nextElementSibling.classList.contains("orr-uservotes") ? after.nextElementSibling : null;
      const n = v[decodeURIComponent(m[1]).toLowerCase()] || 0;
      if (!n) { if (badge) badge.remove(); return; }
      if (!badge) {
        badge = document.createElement("span");
        after.insertAdjacentElement("afterend", badge);
      }
      badge.className = "orr-uservotes " + (n > 0 ? "orr-uv-pos" : "orr-uv-neg");
      badge.textContent = "[" + (n > 0 ? "+" : "") + n + "]";
      badge.title = "your net votes on u/" + decodeURIComponent(m[1]) + "'s posts and comments";
    });
  }

  // ---- save / hide ----
  async function toggleSave(el) {
    const thing = thingOf(el);
    if (!thing || (await needLogin("save"))) return;
    if (thing.dataset.orrSaving) return;
    const was = thing.dataset.saved === "true";
    const paint = (on) => {
      if (on) thing.dataset.saved = "true"; else delete thing.dataset.saved;
      thing.querySelectorAll(":scope > .entry .flat-list.buttons .orr-save").forEach((x) => { x.textContent = on ? "unsave" : "save"; });
    };
    paint(!was);
    thing.dataset.orrSaving = "1";
    try {
      await authedPost(was ? "/api/unsave" : "/api/save", { id: thing.dataset.fullname });
    } catch (e) {
      paint(was);
      showToast("couldn't " + (was ? "unsave" : "save") + ": " + e.message);
    } finally {
      delete thing.dataset.orrSaving;
    }
  }
  // Hiding a post in a listing takes it off the page (with undo); on its comments page
  // or your "hidden" tab the button just flips to unhide / hide.
  function paintHidden(thing, on, removeFromList) {
    if (on) thing.dataset.hidden = "true"; else delete thing.dataset.hidden;
    thing.querySelectorAll(":scope > .entry .flat-list.buttons .orr-hide").forEach((x) => { x.textContent = on ? "unhide" : "hide"; });
    if (removeFromList) thing.classList.toggle("orr-hidden-post", on);
  }
  async function toggleHide(el) {
    const thing = thingOf(el);
    if (!thing || !thing.classList.contains("link") || (await needLogin("hide posts"))) return;
    if (thing.dataset.orrHiding) return;
    const was = thing.dataset.hidden === "true";
    const removeFromList = !document.querySelector(".commentarea") && !/\/hidden\/?$/.test(location.pathname);
    paintHidden(thing, !was, removeFromList);
    thing.dataset.orrHiding = "1";
    try {
      await authedPost(was ? "/api/unhide" : "/api/hide", { id: thing.dataset.fullname });
      if (!was && removeFromList) {
        showToast("post hidden", async () => {
          paintHidden(thing, false, true);
          try { await authedPost("/api/unhide", { id: thing.dataset.fullname }); }
          catch (e) { paintHidden(thing, true, true); showToast("couldn't unhide: " + e.message); }
        });
      }
    } catch (e) {
      paintHidden(thing, was, removeFromList);
      showToast("couldn't " + (was ? "unhide" : "hide") + ": " + e.message);
    } finally {
      delete thing.dataset.orrHiding;
    }
  }

  // ---- report ----
  // The choices: the subreddit's rules, then Reddit's own (both from about/rules.json),
  // then "other" with your own words.
  function reportFormHtml(rules, sub) {
    const subRules = ((rules && rules.rules) || []).map((r) => r.violation_reason || r.short_name).filter(Boolean);
    let siteRules = ((rules && rules.site_rules) || []).filter((x) => typeof x === "string" && x);
    if (!subRules.length && !siteRules.length) siteRules = ["Spam", "Personal and confidential information", "Threatening, harassing, or inciting violence"];
    const opt = (kind, text) =>
      `<label class="orr-rf-opt"><input type="radio" name="orr-reason" data-kind="${kind}" data-text="${esc(text)}"> ${esc(text)}</label>`;
    let h = `<div class="orr-rf-title">report this — why?</div>`;
    if (subRules.length) h += `<div class="orr-rf-group">it breaks r/${esc(sub)}'s rules:</div>` + subRules.map((t) => opt("rule", t)).join("");
    if (siteRules.length) h += `<div class="orr-rf-group">it breaks Reddit's rules:</div>` + siteRules.map((t) => opt("site", t)).join("");
    h += `<label class="orr-rf-opt"><input type="radio" name="orr-reason" data-kind="other"> other: ` +
      `<input type="text" name="other_reason" maxlength="100" placeholder="(maximum 100 characters)" aria-label="other reason"></label>`;
    h += `<div class="orr-rf-buttons"><button type="submit" class="orr-rf-submit" disabled>submit</button> ` +
      `<button type="button" class="orr-rf-cancel">cancel</button> <span class="status" role="status" aria-live="polite"></span></div>`;
    return h;
  }
  async function openReport(el) {
    const thing = thingOf(el);
    if (!thing || (await needLogin("report"))) return;
    const entry = thing.querySelector(":scope > .entry");
    const buttons = entry && entry.querySelector(".flat-list.buttons"); // (a post's are inside .top-matter)
    if (!buttons) return;
    const open = entry.querySelector("form.orr-reportform");
    if (open) { open.remove(); return; } // a second click closes it
    const post = document.querySelector("#siteTable > .thing.link");
    const sub = thing.getAttribute("data-subreddit") || (document.querySelector(".commentarea") && post ? post.getAttribute("data-subreddit") : "") || "";
    const form = document.createElement("form");
    form.className = "orr-reportform";
    form.action = "#";
    form.setAttribute("data-thing", thing.dataset.fullname);
    form.setAttribute("data-sub", sub);
    form.innerHTML = `<div class="orr-rf-title">loading the rules…</div>`;
    buttons.insertAdjacentElement("afterend", form);
    let rules = null;
    try { rules = sub ? (await fetchAboutRules(sub)).rules : null; } catch (e) { /* use the defaults */ }
    if (!form.isConnected) return;
    form.innerHTML = reportFormHtml(rules, sub);
  }
  async function submitReport(form) {
    const sel = form.querySelector("input[name='orr-reason']:checked");
    const status = form.querySelector(".status");
    if (!sel || form.dataset.busy) return;
    const kind = sel.getAttribute("data-kind");
    let text = sel.getAttribute("data-text") || "";
    if (kind === "other") {
      const o = form.querySelector("input[name='other_reason']");
      text = ((o && o.value) || "").trim().slice(0, 100);
      if (!text) { status.textContent = "say what's wrong"; status.classList.add("error"); if (o) o.focus(); return; }
    }
    const thingId = form.getAttribute("data-thing");
    const params = { api_type: "json", thing_id: thingId, reason: text.slice(0, 100), sr_name: form.getAttribute("data-sub") || "" };
    params[kind === "rule" ? "rule_reason" : kind === "site" ? "site_reason" : "other_reason"] = text.slice(0, 100);
    form.dataset.busy = "1";
    form.querySelectorAll("button, input").forEach((x) => { x.disabled = true; });
    status.classList.remove("error");
    status.textContent = "sending…";
    try {
      await authedPost("/api/report", params);
      const thing = document.getElementById("thing_" + thingId);
      const link = thing && thing.querySelector(":scope > .entry .flat-list.buttons .orr-report");
      if (link) { link.textContent = "reported"; link.classList.add("orr-reported"); }
      form.innerHTML = `<div class="orr-rf-done">thanks for reporting — it's on its way to the moderators.</div>`;
      setTimeout(() => form.remove(), 6000);
    } catch (e) {
      delete form.dataset.busy;
      form.querySelectorAll("button, input").forEach((x) => { x.disabled = false; });
      status.classList.add("error");
      status.textContent = e.message;
    }
  }

  // ---- reply / comment / edit (the editor) ----
  const drafts = new Map(); // "<kind>:<fullname>" → text you haven't sent (kept while this tab stays open)
  function makeEditor(kind, thing, text) {
    const tmp = document.createElement("div");
    tmp.innerHTML = editorHtml(kind, thing);
    const form = tmp.firstElementChild;
    form.querySelector("textarea").value = text != null ? text : drafts.get(kind + ":" + thing) || "";
    updatePreview(form);
    return form;
  }
  function updatePreview(form) {
    const ta = form.querySelector("textarea");
    const box = form.querySelector(".orr-ed-preview-box");
    const v = ta.value;
    if (box) {
      box.hidden = !v.trim();
      box.querySelector(".orr-ed-preview").innerHTML = v.trim() ? mdPreview(v) : "";
    }
    if (form.dataset.kind !== "edit") drafts.set(form.dataset.kind + ":" + form.dataset.thing, v);
  }
  function setEdStatus(form, text, isError) {
    const st = form.querySelector(".usertext-buttons .status");
    if (!st) return;
    st.textContent = text || "";
    st.classList.toggle("error", !!isError);
  }
  function focusEditor(form) {
    const ta = form.querySelector("textarea");
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    form.scrollIntoView({ block: "nearest", behavior: SB });
  }
  async function openReply(el) {
    const thing = thingOf(el);
    if (!thing || (await needLogin("reply"))) return;
    const name = thing.dataset.fullname;
    const isMessage = thing.classList.contains("message");
    const entry = thing.querySelector(":scope > .entry");
    const child = isMessage ? null : thing.querySelector(":scope > .child");
    const existing = (child && child.querySelector(":scope > form.orr-editor")) || (entry && entry.querySelector(":scope > form.orr-editor:not([data-kind='edit'])"));
    if (existing) { focusEditor(existing); return; }
    const form = makeEditor(isMessage ? "message" : "reply", name);
    if (child) child.insertBefore(form, child.firstChild);
    else if (entry) entry.appendChild(form); // a comment on a profile page, or an inbox item
    focusEditor(form);
  }
  async function openEdit(el) {
    const thing = thingOf(el);
    if (!thing || (await needLogin("edit"))) return;
    const entry = thing.querySelector(":scope > .entry");
    if (!entry) return;
    const open = entry.querySelector("form.orr-editor[data-kind='edit']");
    if (open) { focusEditor(open); return; }
    const name = thing.dataset.fullname;
    const isPost = /^t3_/.test(name);
    let src = null;
    try {
      const d = await fetchThingData(name); // your current markdown (the page only has the HTML)
      src = d ? (isPost ? d.selftext : d.body) : null;
    } catch (e) { /* below */ }
    if (src == null) { showToast("couldn't load the text to edit — try again"); return; }
    const form = makeEditor("edit", name, src);
    if (isPost) {
      let ex = entry.querySelector(":scope > .expando");
      if (!ex) { ex = document.createElement("div"); ex.className = "expando"; entry.appendChild(ex); }
      ex.style.display = "";
      const btn = entry.querySelector(":scope > .expando-button");
      if (btn) { btn.classList.remove("collapsed"); btn.classList.add("expanded"); btn.setAttribute("aria-expanded", "true"); }
      const body = ex.querySelector(".usertext-body");
      const box = body ? body.closest(".expando-container") || body : null;
      if (box) { box.style.display = "none"; box.insertAdjacentElement("afterend", form); }
      else ex.appendChild(form);
    } else {
      const body = entry.querySelector(":scope > .usertext-body");
      if (body) { body.style.display = "none"; body.insertAdjacentElement("afterend", form); }
      else entry.appendChild(form);
    }
    focusEditor(form);
  }
  function closeEditor(form) {
    if (form.classList.contains("orr-bigedit")) toggleBigEditor(form);
    const kind = form.dataset.kind;
    if (kind === "top") {
      form.querySelector("textarea").value = "";
      drafts.delete("top:" + form.dataset.thing);
      updatePreview(form);
      setEdStatus(form, "");
      return;
    }
    if (kind === "edit") {
      const hidden = form.previousElementSibling;
      if (hidden && hidden.style.display === "none") hidden.style.display = "";
    }
    form.remove(); // (an unsent reply stays in drafts for next time)
  }
  function toggleBigEditor(form) {
    const on = form.classList.toggle("orr-bigedit");
    document.documentElement.classList.toggle("orr-bigedit-open", !!document.querySelector(".orr-editor.orr-bigedit"));
    const a = form.querySelector(".orr-ed-big");
    if (a) a.textContent = on ? "small editor" : "big editor";
    focusEditor(form);
  }
  function toggleFormattingHelp(form, link) {
    const open = form.querySelector(".orr-markhelp");
    if (open) open.remove();
    else form.querySelector(".bottom-area").insertAdjacentHTML("afterend", MARKHELP_HTML);
    link.setAttribute("aria-expanded", open ? "false" : "true");
  }
  // What Reddit answered for a new / edited comment → its full data. Old-style
  // answers carry only a few fields, so read it back through /api/info.json.
  async function postedThing(j, fallbackName) {
    const t = j && j.json && j.json.data && j.json.data.things && j.json.data.things[0];
    const d = (t && t.data) || {};
    const name = d.name || (/^t\d_/.test(d.id || "") ? d.id : t && t.kind && d.id ? t.kind + "_" + d.id : "") || fallbackName || "";
    if (name && !/^t4_/.test(name)) {
      try { const full = await fetchThingData(name); if (full) return full; } catch (e) { /* below */ }
    }
    if (d.author && d.body_html != null) return d;
    return name ? { name, id: name.replace(/^t\d_/, "") } : null;
  }
  async function submitEditor(form) {
    if (form.dataset.busy) return;
    const ta = form.querySelector("textarea");
    const btn = form.querySelector("button.save");
    const text = ta.value;
    if (!text.trim()) { setEdStatus(form, "we need something here", true); ta.focus(); return; }
    const kind = form.dataset.kind;
    const target = form.dataset.thing;
    form.dataset.busy = "1";
    btn.disabled = true;
    ta.readOnly = true;
    setEdStatus(form, "submitting…");
    try {
      if (kind === "edit") {
        const j = await authedPost("/api/editusertext?raw_json=1", { api_type: "json", thing_id: target, text });
        applyEdit(form, target, (await postedThing(j, target)) || {}, text);
      } else {
        const j = await authedPost("/api/comment?raw_json=1", { api_type: "json", thing_id: target, text });
        drafts.delete(kind + ":" + target);
        placeNewComment(form, await postedThing(j, null), text);
      }
    } catch (e) {
      let msg = e.message;
      // (Reddit answers a comment from someone banned from the subreddit with a bare
      // "500 reddit broke!", so any HTTP error gets the subreddit checked)
      if (kind !== "edit" && /^HTTP\d|NOTALLOWED|BANNED|RESTRICTED/i.test(e.code || "")) msg = await explainCommentRefusal(form, e);
      if (form.isConnected) setEdStatus(form, msg, true);
    } finally {
      delete form.dataset.busy;
      btn.disabled = false;
      ta.readOnly = false;
    }
  }
  function placeNewComment(form, d, text) {
    const kind = form.dataset.kind;
    const note = (html) => {
      const entry = form.parentElement;
      closeEditor(form);
      if (entry) entry.insertAdjacentHTML("beforeend", `<div class="orr-sent-note">${html}</div>`);
    };
    if (kind === "message") { note("your reply has been sent."); return; }
    if (!d || !d.name) { setEdStatus(form, "posted — reload the page to see it"); if (kind === "top") form.querySelector("textarea").value = ""; return; }
    const data = Object.assign({ author: myName(), score: 1, likes: true, created_utc: Date.now() / 1000, replies: "" }, d);
    if (!data.body_html) data.body_html = '<div class="md">' + mdPreview(text) + "</div>";
    const post = document.querySelector("#siteTable > .thing.link");
    const html = buildComment(data, { linkId: post ? post.dataset.fullname : "", nowMs: Date.now() });
    if (kind === "top") {
      const st = document.querySelector(".commentarea > .sitetable");
      if (!st) return;
      st.querySelectorAll(":scope > .thing:not([data-fullname])").forEach((x) => x.remove()); // "No comments yet."
      st.insertAdjacentHTML("afterbegin", html);
      closeEditor(form); // (clears the box; it stays for the next comment)
    } else if (form.parentElement && form.parentElement.classList.contains("child")) {
      const child = form.parentElement;
      form.remove();
      child.insertAdjacentHTML("afterbegin", html);
    } else {
      note(`your reply was posted${data.permalink ? ` — <a href="${esc(data.permalink)}">view it</a>` : ""}.`);
      return;
    }
    const el = document.getElementById("thing_" + data.name);
    if (!el) return;
    patchTags(el);
    enhanceNewItems(el);
    enhanceComments(el);
    flash(el);
  }
  function applyEdit(form, name, d, text) {
    const isPost = /^t3_/.test(name);
    const html = (isPost ? d.selftext_html : d.body_html) || '<div class="md">' + mdPreview(text) + "</div>";
    const hidden = form.previousElementSibling;
    if (hidden && hidden.style.display === "none") {
      if (hidden.classList.contains("usertext-body")) hidden.innerHTML = html;
      else { const b = hidden.querySelector(".usertext-body"); if (b) b.innerHTML = html; }
      hidden.style.display = "";
    } else if (isPost) {
      form.insertAdjacentHTML("beforebegin", selfTextBox(html));
    }
    if (form.classList.contains("orr-bigedit")) toggleBigEditor(form);
    form.remove();
    const thing = document.getElementById("thing_" + name);
    if (thing) { inlineImages(thing); linkifyEmails(thing); flash(thing); }
  }

  // ---- subreddits you can't comment in (banned, or approved users only) ----
  // The thread page says so up front instead of offering a comment box that Reddit
  // would refuse; a refusal that still happens (a stale page, a reply from your
  // profile or inbox) is explained the same way.
  async function freshAbout(sub) {
    const r = await redditFetch(location.origin + "/r/" + encodeURIComponent(sub) + "/about.json?raw_json=1");
    if (!r.ok) return null;
    const about = await r.json();
    const hit = aboutCache.get(sub.toLowerCase());
    if (hit) hit.v = Object.assign({}, hit.v, { about }); // the sidebar's copy too
    return about;
  }
  function applyCommentBlock(block) {
    const area = document.querySelector(".commentarea");
    if (!area || !block) return;
    area.classList.add("orr-noreply"); // hides every reply link
    let note = area.querySelector(":scope > .orr-closed-note");
    if (!note) {
      note = document.createElement("div");
      note.className = "orr-li-only orr-closed-note orr-cant-comment";
      const top = area.querySelector(":scope > .orr-topform");
      const ta = top && top.querySelector("textarea");
      if (top && !(ta && ta.value.trim())) top.replaceWith(note);
      else area.insertBefore(note, top || area.querySelector(":scope > .sitetable")); // (keep what you typed)
    }
    note.textContent = block.text;
    // reply boxes nobody has typed in yet go too (ones with text keep it, and say why)
    area.querySelectorAll("form.orr-editor:not([data-kind='edit'])").forEach((f) => {
      if (!f.querySelector("textarea").value.trim()) f.remove();
    });
  }
  async function checkCommentBlock(sub) {
    if (!sub || jsonBlocked) return;
    await fetchMe();
    if (!myName()) return;
    let v = null;
    try { v = await fetchAboutRules(sub); } catch (e) { return; }
    const block = commentBlock(v && v.about);
    const post = document.querySelector("#siteTable > .thing.link");
    if (block && post && (post.getAttribute("data-subreddit") || "").toLowerCase() === sub.toLowerCase()) applyCommentBlock(block);
  }
  // A comment Reddit refused: say why if the subreddit tells us (banned / approved
  // only), else the likely reasons for a 403.
  async function explainCommentRefusal(form, e) {
    const target = document.getElementById("thing_" + form.dataset.thing);
    const post = document.querySelector("#siteTable > .thing.link");
    const sub = (target && target.getAttribute("data-subreddit")) || (post && post.getAttribute("data-subreddit")) || "";
    let block = null;
    if (sub) { try { block = commentBlock(await freshAbout(sub)); } catch (err) { /* below */ } }
    if (block) {
      const onThisThread = post && (post.getAttribute("data-subreddit") || "").toLowerCase() === sub.toLowerCase();
      if (onThisThread) applyCommentBlock(block);
      return block.text;
    }
    if (e.code === "HTTP403" && sub) return e.message + ` — the thread may be locked, or you may not be allowed to comment in r/${sub}.`;
    return e.message;
  }

  // ---- delete (your own) ----
  function confirmDelete(link) {
    const li = link.parentElement;
    if (!li || li.querySelector(".orr-del-confirm")) return;
    link.style.display = "none";
    const span = document.createElement("span");
    span.className = "orr-del-confirm";
    span.innerHTML = 'are you sure? <a href="javascript:void(0)" class="orr-del-yes" role="button">yes</a> / ' +
      '<a href="javascript:void(0)" class="orr-del-no" role="button">no</a>';
    li.appendChild(span);
  }
  function cancelDelete(el) {
    const li = el.closest("li");
    const span = li && li.querySelector(".orr-del-confirm");
    if (span) span.remove();
    const link = li && li.querySelector(".orr-delete");
    if (link) link.style.display = "";
  }
  async function doDelete(el) {
    const thing = thingOf(el);
    const span = el.closest(".orr-del-confirm");
    if (!thing || !span || (await needLogin("delete"))) return;
    span.textContent = "deleting…";
    try {
      await authedPost("/api/del", { id: thing.dataset.fullname });
      markDeleted(thing);
    } catch (e) {
      cancelDelete(span);
      showToast("couldn't delete: " + e.message);
    }
  }
  function markDeleted(thing) {
    const isPost = thing.classList.contains("link");
    if (isPost && !document.querySelector(".commentarea")) { thing.classList.add("orr-hidden-post"); showToast("deleted"); return; }
    const entry = thing.querySelector(":scope > .entry");
    if (!entry) return;
    const body = isPost ? entry.querySelector(":scope > .expando .usertext-body") : entry.querySelector(":scope > .usertext-body");
    if (body) body.innerHTML = '<div class="md"><p>[deleted]</p></div>';
    const author = entry.querySelector(":scope > .tagline a.author, :scope > .top-matter .tagline a.author");
    if (author) { const s = document.createElement("span"); s.textContent = "[deleted]"; author.replaceWith(s); }
    entry.querySelectorAll(".flat-list.buttons > li.orr-li-only, .flat-list.buttons > li.orr-own-only").forEach((li) => li.remove());
    thing.classList.remove("orr-mine");
    thing.setAttribute("data-author", "[deleted]");
  }

  // ---- join / leave (sidebar) ----
  async function toggleSubscribe(opt) {
    const box = opt.closest(".subscribe-button");
    if (!box || box.dataset.busy || (await needLogin("join subreddits"))) return;
    const joining = opt.classList.contains("add");
    const wasIn = box.querySelector(".option.remove").classList.contains("active");
    if (box.dataset.base == null) box.dataset.base = String((parseInt(box.getAttribute("data-subscribers"), 10) || 0) - (wasIn ? 1 : 0));
    const paint = (inSub) => {
      box.querySelector(".option.add").classList.toggle("active", !inSub);
      box.querySelector(".option.remove").classList.toggle("active", inSub);
      const num = box.parentElement && box.parentElement.querySelector(".subscribers .number");
      if (num) num.textContent = formatNumber(parseInt(box.dataset.base, 10) + (inSub ? 1 : 0));
    };
    paint(joining);
    box.dataset.busy = "1";
    try {
      await authedPost("/api/subscribe", { action: joining ? "sub" : "unsub", sr: box.getAttribute("data-sr"), skip_initial_defaults: "true" });
      aboutCache.clear(); // about.json's user_is_subscriber changed
    } catch (e) {
      paint(wasIn);
      showToast("couldn't " + (joining ? "join" : "leave") + ": " + e.message);
    } finally {
      delete box.dataset.busy;
    }
  }

  // ---- inbox ----
  // Like old reddit, opening the inbox marks what it shows as read (they keep the
  // "new" highlight on the page); "mark unread" / "mark read" flip one back.
  function markShownRead(scope) {
    const route = ORR.isMessageRoute(location);
    if (!route || route.where === "sent") return;
    const root = scope && scope.querySelectorAll ? scope : document;
    const items = Array.from(root.querySelectorAll(".thing.message[data-new='true']"));
    if (!items.length) return;
    authedPost("/api/read_message", { id: items.map((t) => t.dataset.fullname).join(",") })
      .then(() => {
        items.forEach((t) => {
          t.dataset.new = "false";
          const a = t.querySelector(":scope > .entry .flat-list.buttons .orr-markread");
          if (a) a.textContent = "mark unread";
        });
        refreshHeader();
      })
      .catch(() => { /* they stay unread */ });
  }
  async function toggleMarkRead(el) {
    const thing = thingOf(el);
    if (!thing || thing.dataset.orrMarking || (await needLogin("do that"))) return;
    const unread = thing.dataset.new === "true";
    const paint = (isUnread) => {
      thing.dataset.new = String(isUnread);
      thing.classList.toggle("new", isUnread);
      el.textContent = isUnread ? "mark read" : "mark unread";
    };
    paint(!unread);
    thing.dataset.orrMarking = "1";
    try {
      await authedPost(unread ? "/api/read_message" : "/api/unread_message", { id: thing.dataset.fullname });
      refreshHeader();
    } catch (e) {
      paint(unread);
      showToast("couldn't do that: " + e.message);
    } finally {
      delete thing.dataset.orrMarking;
    }
  }
  async function loadMessages(url, firstLoad) {
    const route = ORR.isMessageRoute(url);
    if (!route) return;
    const params = { after: url.searchParams.get("after"), count: url.searchParams.get("count") };
    hideGuard();
    let watchdog = null;
    if (firstLoad) watchdog = setTimeout(() => { if (!active) unhideGuard(); }, 8000);
    const fetchBox = async (after, count) => {
      const q = new URLSearchParams({ raw_json: "1", limit: "25", mark: "false" });
      if (after) { q.set("after", after); q.set("count", String(count || 25)); }
      const res = await redditFetch(location.origin + route.basePath + "/.json?" + q.toString());
      if (!res.ok) { const e = new Error("HTTP " + res.status); e.status = res.status; e.retryAfter = retryAfterOf(res); throw e; }
      return res.json();
    };
    let json;
    try {
      await fetchMe();
      if (!myName()) { const e = new Error("logged out"); e.status = 403; throw e; } // the inbox needs a login: leave it to Reddit
      json = await fetchBox(params.after, params.count);
    } catch (err) {
      if (watchdog) clearTimeout(watchdog);
      if (firstLoad) { active = false; unhideGuard(); } else failNav(url, err.status || 0);
      return;
    }
    if (watchdog) clearTimeout(watchdog);
    await ensureCss();
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    active = true; // before replaceBody(): see loadListing's comment on why
    replaceBody(buildMessagesPage(route, json, { me: meCached, startCount, nowMs: Date.now() }), "messages: " + route.where);
    unhideGuard();
    patchHeader();
    markShownRead(document);
    const l0 = (json && json.data) || {};
    setupInfinite(
      async (after, count) => {
        const j2 = await fetchBox(after, count);
        const kids = (((j2 && j2.data) || {}).children || []).filter((c) => c.data && !document.getElementById("thing_" + c.data.name));
        const html = kids.map((c) => buildMessage(c.data, { sent: route.where === "sent" })).join("");
        return { itemsHtml: html, after: ((j2 && j2.data) || {}).after, addedCount: kids.length };
      },
      l0.after,
      startCount + (l0.children || []).length
    );
  }

  // Clicks on the account buttons (wired from wireNav's click handler).
  function handleActionClick(e) {
    const t = e.target;
    if (!t || !t.closest) return false;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    let el;
    if ((el = t.closest(".thing > .midcol > .arrow"))) { stop(); vote(thingOf(el), el.classList.contains("up") || el.classList.contains("upmod") ? 1 : -1); return true; }
    if ((el = t.closest("a.orr-save"))) { stop(); toggleSave(el); return true; }
    if ((el = t.closest("a.orr-hide"))) { stop(); toggleHide(el); return true; }
    if ((el = t.closest("a.orr-report"))) { stop(); if (!el.classList.contains("orr-reported")) openReport(el); return true; }
    if ((el = t.closest(".orr-rf-cancel"))) { stop(); const f = el.closest("form"); if (f) f.remove(); return true; }
    if ((el = t.closest("a.orr-reply"))) { stop(); openReply(el); return true; }
    if ((el = t.closest("a.orr-edit"))) { stop(); openEdit(el); return true; }
    if ((el = t.closest("a.orr-delete"))) { stop(); confirmDelete(el); return true; }
    if ((el = t.closest("a.orr-del-yes"))) { stop(); doDelete(el); return true; }
    if ((el = t.closest("a.orr-del-no"))) { stop(); cancelDelete(el); return true; }
    if ((el = t.closest("form.orr-editor button.cancel"))) { stop(); closeEditor(el.closest("form")); return true; }
    if ((el = t.closest("a.orr-ed-big"))) { stop(); toggleBigEditor(el.closest("form")); return true; }
    if ((el = t.closest("a.orr-ed-help"))) { stop(); toggleFormattingHelp(el.closest("form"), el); return true; }
    if ((el = t.closest(".subscribe-button .option"))) { stop(); toggleSubscribe(el); return true; }
    if ((el = t.closest("a.orr-markread"))) { stop(); toggleMarkRead(el); return true; }
    return false;
  }
  function wireActions() {
    // live preview while typing
    document.addEventListener("input", (e) => {
      const f = e.target && e.target.closest && e.target.closest("form.orr-editor");
      if (f && e.target.tagName === "TEXTAREA") updatePreview(f);
    });
    // a report reason picked → can submit
    document.addEventListener("change", (e) => {
      const f = e.target && e.target.closest && e.target.closest("form.orr-reportform");
      if (!f) return;
      const b = f.querySelector(".orr-rf-submit");
      if (b) b.disabled = !f.querySelector("input[name='orr-reason']:checked");
      if (e.target.name === "orr-reason" && e.target.getAttribute("data-kind") === "other") {
        const o = f.querySelector("input[name='other_reason']");
        if (o) o.focus();
      }
    });
    document.addEventListener("focusin", (e) => { // typing an "other" reason picks "other"
      if (!(e.target && e.target.name === "other_reason")) return;
      const f = e.target.closest("form.orr-reportform");
      const r = f && f.querySelector("input[name='orr-reason'][data-kind='other']");
      if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    document.addEventListener("keydown", (e) => {
      if (!active) return;
      const t = e.target;
      // Ctrl/Cmd+Enter sends the comment; Esc leaves the big editor
      const f = t && t.closest && t.closest("form.orr-editor");
      if (f && t.tagName === "TEXTAREA") {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitEditor(f); }
        else if (e.key === "Escape" && f.classList.contains("orr-bigedit")) { e.preventDefault(); toggleBigEditor(f); }
        return;
      }
      // Enter / Space on a focused vote arrow votes
      if ((e.key === "Enter" || e.key === " ") && t && t.classList && t.classList.contains("arrow") && t.closest(".midcol")) {
        e.preventDefault();
        e.stopPropagation();
        vote(thingOf(t), t.classList.contains("up") || t.classList.contains("upmod") ? 1 : -1);
      }
    }, true);
  }
  // The keyboard shortcuts' target: the selected item, else (on a comments page) the post.
  function kbTarget() {
    return kbCurrent() || (document.querySelector(".commentarea") ? document.querySelector("#siteTable > .thing.link") : null);
  }

  function wireNav() {
    if (wired) return;
    wired = true;
    wireActions();

    document.addEventListener(
      "click",
      (e) => {
        if (!active) return;
        if (handleActionClick(e)) return; // vote / save / hide / report / reply / edit / delete / join / inbox
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
        // Expand a clamped read comment (fold-read mode) when its own body is clicked.
        // Gated on the read condition (NOT .orr-clamped) so a body revealed later —
        // by expanding a thread or load-more — is always expandable, never hidden.
        const foldBody = e.target.closest && e.target.closest(".commentarea.orr-foldread .usertext-body");
        if (foldBody && foldBody.parentElement && foldBody.parentElement.classList.contains("entry") &&
            !e.target.closest("a, button, .md-spoiler-text, input, textarea")) {
          const c = foldBody.parentElement.parentElement; // .thing.comment > .entry > .usertext-body
          if (c && c.classList.contains("comment") && !c.classList.contains("orr-new") && !c.classList.contains("orr-read-open")) {
            e.preventDefault();
            c.classList.add("orr-read-open");
            return;
          }
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
        // Quick filter/tag icons in a tagline.
        const qa = e.target.closest && e.target.closest("a.orr-qa");
        if (qa) {
          e.preventDefault();
          e.stopPropagation();
          const name = qa.dataset.qaName || "";
          if (qa.dataset.qa === "tag") promptTag(name);
          else toggleFilter(qa.dataset.qaKind, name);
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
        // Favorite/filter toggle links (inside a subreddit hover card).
        const favBtn = e.target.closest && e.target.closest(".orr-favbtn");
        if (favBtn) {
          e.preventDefault();
          e.stopPropagation();
          toggleFavoriteSub(favBtn.getAttribute("data-fav-sub") || "");
          return;
        }
        const filterBtn = e.target.closest && e.target.closest(".orr-filterbtn");
        if (filterBtn) {
          e.preventDefault();
          e.stopPropagation();
          toggleFilter(filterBtn.getAttribute("data-filter-kind") || "subreddits", filterBtn.getAttribute("data-filter-name") || "");
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
              stopHiddenMedia(expando); // display:none alone doesn't pause a <video> or silence an iframe embed
            } else {
              // Expanding a spoiler/NSFW post is a deliberate "show me" action —
              // reveal it in this one click instead of requiring a second (issue #7).
              if (expando.classList.contains("orr-spoiler") || expando.classList.contains("orr-nsfw")) expando.classList.add("orr-revealed");
              resumeHiddenMedia(expando);
              wireRedditVideos(expando); // give the video its sound
              enhanceVideoControls(expando); // speed / loop controls + remembered prefs
              addDownloadButtons(expando);
              wireEmbedGates(expando); // now visible → fetch its oEmbed preview if the platform's already permitted
              checkUnsentText(expBtn.closest(".thing.link")); // a feed's media post: its text, if it has any
              // A manual expand is a deliberate "play this" action, independent of
              // the autoplay-in-feed setting — start it immediately either way.
              expando.querySelectorAll("video").forEach((v) => { v.dataset.orrWant = "play"; try { v.play().catch(() => {}); } catch (e) {} });
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
        const hoursGo = e.target.closest && e.target.closest("a.orr-hours-go");
        if (hoursGo) {
          e.preventDefault();
          e.stopPropagation();
          submitCustomWindow(hoursGo, "hours");
          return;
        }
        const daysGo = e.target.closest && e.target.closest("a.orr-days-go");
        if (daysGo) {
          e.preventDefault();
          e.stopPropagation();
          submitCustomWindow(daysGo, "days");
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
        // Only intercept routes we rebuild; let everything else navigate normally.
        if (!isRebuiltRoute(url)) return;
        e.preventDefault();
        e.stopPropagation();
        scrollPositions[scrollKey()] = window.scrollY; // remember where we were
        historyNavKey = null;
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
        if (form && form.classList && form.classList.contains("orr-editor")) { e.preventDefault(); e.stopPropagation(); submitEditor(form); return; }
        if (form && form.classList && form.classList.contains("orr-reportform")) { e.preventDefault(); e.stopPropagation(); submitReport(form); return; }
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
        historyNavKey = null;
        history.pushState(null, "", target);
        window.scrollTo(0, 0);
        loadPage(new URL(target, location.origin), false);
      },
      true
    );

    // Enter inside the custom "last N hours/days" inputs submits it.
    document.addEventListener("keydown", (e) => {
      if (!active) return;
      const t = e.target;
      if (e.key !== "Enter" || !t || !t.classList) return;
      if (t.classList.contains("orr-hours-input")) { e.preventDefault(); e.stopPropagation(); submitCustomWindow(t, "hours"); }
      else if (t.classList.contains("orr-days-input")) { e.preventDefault(); e.stopPropagation(); submitCustomWindow(t, "days"); }
    }, true);

    window.addEventListener("popstate", () => {
      if (!active) return;
      const url = new URL(location.href);
      if (isRebuiltRoute(url)) {
        pendingScrollRestore = scrollPositions[scrollKey()] != null ? scrollPositions[scrollKey()] : 0;
        historyNavKey = scrollKey(); // put back the pages infinite scroll had added here
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
    // "Watch on Reddit" escape hatch: a #orr-native link (see showVideoFallback)
    // asks the extension to stand down for this load so Reddit's own player — the
    // only thing that can play a locked-down v.redd.it video — takes over.
    if (location.hash === "#orr-native") return;
    // Hide the page SYNCHRONOUSLY at document_start (before the async prefs read),
    // on a route we're going to rebuild — otherwise new Reddit flashes through
    // during the storage reads. Every early-return below must unhide.
    let preSupported = false;
    try {
      const preUrl = new URL(location.href);
      preSupported = isRebuiltRoute(preUrl);
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
    autoplayOn = prefs.autoplayMedia === true;
    hideReadOn = prefs.hideRead === true;
    autoCollapseBotsOn = prefs.autoCollapseBots === true;
    foldReadCommentsOn = prefs.foldReadComments === true;
    trackRecentSubsOn = prefs.trackRecentSubs !== false;
    nightAutoOn = prefs.nightAuto === true;
    applyBodyFlags(prefs);
    applyNightSchedule(); // may override nightModeOn based on time of day
    try {
      dataCache = await ORR.getData();
    } catch (e) {
      /* keep defaults */
    }
    // Tracking off → keep no recent-sub list at all (one collected earlier would
    // otherwise linger in storage and in settings exports).
    if (!trackRecentSubsOn && (dataCache.recentSubs || []).length) {
      dataCache.recentSubs = [];
      ORR.setPrefs({ recentSubs: [] });
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
    if (!isRebuiltRoute(url)) {
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
          document.querySelectorAll("video.reddit-video").forEach((v) => applyVideoMuted(v, orrVideoMuted));
          paintMuteAllBtn();
        }
      }
      if (changes.nightMode) {
        nightModeOn = changes.nightMode.newValue !== false;
        if (active && !nightAutoOn) applyNight();
      }
      if (changes.videoLoop && active) {
        videoLoopOn = changes.videoLoop.newValue === true;
        document.querySelectorAll(".orr-video-wrap video, video.orr-directvideo").forEach((v) => { v.loop = videoLoopOn; if (v._orrPaintLoop) v._orrPaintLoop(); });
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
      if (active && (changes.autoplayMedia || changes.hideRead || changes.autoCollapseBots ||
                     changes.compactView || changes.nightAuto || changes.highContrast || changes.dyslexiaFont ||
                     changes.fixedThumbnails || changes.expandImages || changes.foldReadComments || changes.trackRecentSubs)) {
        ORR.getPrefs().then((p) => {
          autoplayOn = p.autoplayMedia === true;
          hideReadOn = p.hideRead === true;
          autoCollapseBotsOn = p.autoCollapseBots === true;
          nightAutoOn = p.nightAuto === true;
          trackRecentSubsOn = p.trackRecentSubs !== false;
          applyBodyFlags(p); // includes fixedThumbnails
          applyNightSchedule();
          applyNight();
          applyFilters(document); // hideRead / re-filter
          if (changes.expandImages) { expandImagesOn = p.expandImages === true; expandImagesPass(); }
          if (changes.foldReadComments) { foldReadCommentsOn = p.foldReadComments === true; if (foldReadCommentsOn) applyReadFolding(); else unfoldReadComments(); }
          if (changes.trackRecentSubs) {
            if (!trackRecentSubsOn) dataCache.recentSubs = [];
            patchSrBar();
          }
          // Turning autoplay on only started observing posts rendered AFTER that
          // point (e.g. the next infinite-scroll batch) — sweep what's already
          // on the page too, instead of waiting for more to load in.
          if (changes.autoplayMedia && autoplayOn) autoplayMedia(document);
        });
      }
      if ((changes.filters || changes.favoriteSubs || changes.userTags || changes.threadVisits ||
           changes.subPrefs || changes.keyBindings || changes.userVotes) && active) {
        ORR.getData().then((d) => {
          dataCache = d;
          if (changes.threadVisits) markThreadNew(document); // refresh "N new" badges + orr-has-new
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
