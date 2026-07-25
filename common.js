"use strict";

// Shared prefs + route parsing. Loaded by the settings UI (settings.js) and by
// the content scripts (restyle.js skinner, rebuild.js frontend-rebuilder).
//
// Two features, layered:
//   enabled  — the CSS "skin" (restyle.js) repaints new Reddit in place.
//   rebuild  — experimental: on listing routes, rebuild.js throws away new
//              Reddit's DOM and renders old Reddit's real frontend from the JSON
//              API. On routes rebuild doesn't handle, the skin still applies.

(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;

  // Rebuild is now the only mode.
  const DEFAULTS = Object.freeze({ enabled: true, infiniteScroll: true, nightMode: false, redirect: true, videoMuted: false });

  const SORTS_SUB = ["hot", "new", "rising", "controversial", "top"];
  const SORTS_FRONT = ["hot", "new", "rising", "controversial", "top", "best"];

  // Small settings + filter lists follow the user across devices via storage.sync.
  // userTags and the large per-device blobs stay in storage.local — userTags can
  // grow past storage.sync's ~8KB/item quota, and a quota failure must not risk
  // leaving a stale copy in sync that getData would then prefer.
  const SYNC_KEYS = ["enabled", "infiniteScroll", "nightMode", "redirect", "videoMuted", "filters"];

  function syncArea() {
    return api.storage && api.storage.sync ? api.storage.sync : api.storage.local;
  }
  async function areaGet(area, keys) {
    try {
      return await area.get(keys);
    } catch (e) {
      return {};
    }
  }

  async function getPrefs() {
    const want = { enabled: undefined, infiniteScroll: undefined, nightMode: undefined, redirect: undefined, videoMuted: undefined, mode: undefined };
    const sync = await areaGet(syncArea(), want);
    const local = await areaGet(api.storage.local, want);
    // Per-key merge: sync wins where set, local fills the rest. (An all-or-nothing
    // fallback would orphan pre-migration local settings once ANY one key is synced.)
    const stored = {};
    Object.keys(want).forEach((k) => { stored[k] = sync[k] !== undefined ? sync[k] : local[k]; });
    let enabled = stored.enabled;
    if (enabled === undefined) enabled = stored.mode === "off" ? false : true;
    return {
      enabled: enabled !== false,
      infiniteScroll: stored.infiniteScroll !== false, // default on
      nightMode: stored.nightMode === true, // default off
      redirect: stored.redirect !== false, // default on: send old.reddit/i.reddit → www
      videoMuted: stored.videoMuted === true, // default off (sound on)
    };
  }

  // Larger data blobs (kept out of getPrefs). All default to empty.
  async function getData() {
    const s = await areaGet(syncArea(), { filters: null });
    const l = await areaGet(api.storage.local, {
      filters: null, userTags: null, threadVisits: null, visitedPosts: null, collapsedComments: null,
    });
    return {
      filters: s.filters || l.filters || { subreddits: [], users: [], domains: [], keywords: [], flairs: [] },
      userTags: l.userTags || {},
      threadVisits: l.threadVisits || {},
      visitedPosts: l.visitedPosts || {},
      collapsedComments: l.collapsedComments || {},
    };
  }

  async function setPrefs(patch) {
    const syncPatch = {}, localPatch = {};
    Object.keys(patch).forEach((k) => {
      if (SYNC_KEYS.indexOf(k) >= 0) syncPatch[k] = patch[k];
      else localPatch[k] = patch[k];
    });
    const jobs = [];
    if (Object.keys(syncPatch).length) {
      const keys = Object.keys(syncPatch);
      // On a sync failure (e.g. quota) fall back to local, but first drop the keys
      // from sync so a stale sync copy can't shadow the local one in getData/getPrefs.
      jobs.push(
        Promise.resolve(syncArea().set(syncPatch)).catch(() =>
          Promise.resolve(syncArea().remove(keys)).catch(() => {}).then(() => api.storage.local.set(syncPatch))
        )
      );
    }
    if (Object.keys(localPatch).length) jobs.push(api.storage.local.set(localPatch));
    await Promise.all(jobs);
  }

  // Returns a route descriptor for listing pages the rebuilder supports, else null.
  // Accepts a URL, a {pathname}, or a pathname string.
  function isListingRoute(loc) {
    const pathname = loc && loc.pathname != null ? loc.pathname : String(loc || "");
    const segs = pathname.split("/").filter(Boolean);

    if (segs.length === 0) return { scope: "front", sub: null, sort: "hot", basePath: "" };
    if (segs.length === 1 && SORTS_FRONT.includes(segs[0]))
      return { scope: "front", sub: null, sort: segs[0], basePath: "/" + segs[0] };
    if (segs[0] === "r" && segs.length === 2)
      return { scope: "sub", sub: segs[1], sort: "hot", basePath: "/r/" + segs[1] };
    if (segs[0] === "r" && segs.length === 3 && SORTS_SUB.includes(segs[2]))
      return { scope: "sub", sub: segs[1], sort: segs[2], basePath: "/r/" + segs[1] + "/" + segs[2] };
    return null; // user pages, search, wiki, etc. — not rebuilt
  }

  // Returns a comments-route descriptor for a post permalink, else null.
  //   /r/{sub}/comments/{id}/{slug}/[{commentId}]/  or  /comments/{id}/...
  function isCommentsRoute(loc) {
    const pathname = loc && loc.pathname != null ? loc.pathname : String(loc || "");
    const segs = pathname.split("/").filter(Boolean);
    if (segs[0] === "r" && segs[2] === "comments" && segs[3])
      return { scope: "comments", sub: segs[1], postId: segs[3], commentId: segs[5] || null, permalink: pathname };
    if (segs[0] === "comments" && segs[1])
      return { scope: "comments", sub: null, postId: segs[1], commentId: segs[3] || null, permalink: pathname };
    return null;
  }

  const USER_SECTIONS = ["overview", "submitted", "comments", "gilded", "upvoted", "downvoted", "hidden", "saved"];

  // Returns a user-profile route descriptor, else null.
  //   /user/{name}[/{section}]/  (or the /u/ alias)
  function isUserRoute(loc) {
    const pathname = loc && loc.pathname != null ? loc.pathname : String(loc || "");
    const segs = pathname.split("/").filter(Boolean);
    if ((segs[0] === "user" || segs[0] === "u") && segs[1]) {
      let section = segs[2] || "overview";
      if (!USER_SECTIONS.includes(section)) section = "overview";
      return {
        scope: "user",
        name: segs[1],
        section,
        basePath: "/user/" + segs[1] + (section === "overview" ? "" : "/" + section),
      };
    }
    return null;
  }

  // Reddit Answers (/answers/…) — not an old-reddit feature and not rebuildable
  // (it's a shadow-DOM app), but we frame it in an old-reddit-style top bar.
  function isAnswersRoute(loc) {
    const pathname = loc && loc.pathname != null ? loc.pathname : String(loc || "");
    const segs = pathname.split("/").filter(Boolean);
    return segs[0] === "answers" ? { scope: "answers" } : null;
  }

  // /search  or  /r/{sub}/search  (query params read at load time from the URL)
  function isSearchRoute(loc) {
    const pathname = loc && loc.pathname != null ? loc.pathname : String(loc || "");
    const segs = pathname.split("/").filter(Boolean);
    if (segs.length === 1 && segs[0] === "search") return { scope: "search", sub: null, basePath: "/search" };
    if (segs[0] === "r" && segs[2] === "search" && segs.length === 3)
      return { scope: "search", sub: segs[1], basePath: "/r/" + segs[1] + "/search" };
    return null;
  }

  globalThis.ORR = {
    api, DEFAULTS, SORTS_SUB, SORTS_FRONT, USER_SECTIONS,
    getPrefs, setPrefs, getData, isListingRoute, isCommentsRoute, isUserRoute, isSearchRoute, isAnswersRoute,
  };
})();
