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
      `</div></div><div class="clearleft"></div></div>`
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

  function navButtonsHtml(route, listing, count) {
    const parts = [];
    if (listing.before) {
      parts.push(
        `<a href="${route.basePath}/?count=${count}&before=${esc(listing.before)}" rel="prev nofollow">&lsaquo; prev</a>`
      );
    }
    if (listing.after) {
      parts.push(
        `<a href="${route.basePath}/?count=${count}&after=${esc(listing.after)}" rel="next nofollow">next &rsaquo;</a>`
      );
    }
    if (!parts.length) return "";
    return `<div class="nav-buttons"><span class="nextprev">view more: ${parts.join(" ")}</span></div>`;
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
      `<div id="siteTable" class="sitetable linklisting">` +
      (items || `<div class="thing">Nothing here.</div>`) +
      `</div>` +
      navButtonsHtml(route, listing, count) +
      `</div>`;

    return { className: `listing-page ${route.sort}-page`, inner };
  }

  globalThis.ORR_REBUILD = { esc, formatAge, thumbnailHtml, buildItem, tabmenuHtml, navButtonsHtml, buildBody };

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

  function renderInto(route, json, params) {
    const startCount = params.after ? parseInt(params.count || "25", 10) : 0;
    const body = buildBody(route, json, { startCount });
    const fresh = document.createElement("body");
    fresh.className = body.className;
    fresh.innerHTML = body.inner;
    if (document.body) document.documentElement.replaceChild(fresh, document.body);
    else document.documentElement.appendChild(fresh);
    document.documentElement.classList.add("orr-rebuilt");
    const sub = route.scope === "front" ? "reddit" : "r/" + route.sub;
    try {
      document.title = sub + " — old reddit";
    } catch (e) {
      /* ignore */
    }
  }

  function renderError(status) {
    const st = document.getElementById("siteTable");
    const msg =
      status === 403
        ? "Old Reddit Skin: the Reddit JSON API returned 403 (are you logged in? Reddit blocks logged-out .json). Turn off Rebuild mode to use normal Reddit."
        : "Old Reddit Skin: couldn't load this page from the Reddit API (" + status + ").";
    if (st) st.innerHTML = `<div class="thing"><div class="entry"><p>${esc(msg)}</p></div></div>`;
  }

  async function loadRoute(url, firstLoad) {
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

  function wireNav() {
    if (wired) return;
    wired = true;

    document.addEventListener(
      "click",
      (e) => {
        if (!active) return;
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
        if (!ORR.isListingRoute(url)) return; // comments/user/etc → let new Reddit handle it
        e.preventDefault();
        e.stopPropagation();
        history.pushState(null, "", url.pathname + url.search);
        window.scrollTo(0, 0);
        loadRoute(url, false);
      },
      true
    );

    window.addEventListener("popstate", () => {
      if (!active) return;
      const url = new URL(location.href);
      if (ORR.isListingRoute(url)) loadRoute(url, false);
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
    if (!ORR.isListingRoute(url)) return; // unsupported route → restyle.js skins it
    wireNav();
    loadRoute(url, true);
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
