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
  const DEFAULTS = Object.freeze({ enabled: true, infiniteScroll: true, nightMode: false });

  const SORTS_SUB = ["hot", "new", "rising", "controversial", "top"];
  const SORTS_FRONT = ["hot", "new", "rising", "controversial", "top", "best"];

  async function getPrefs() {
    const stored = await api.storage.local.get({
      enabled: undefined,
      infiniteScroll: undefined,
      nightMode: undefined,
      mode: undefined, // legacy
    });
    let enabled = stored.enabled;
    if (enabled === undefined) enabled = stored.mode === "off" ? false : true;
    return {
      enabled: enabled !== false,
      infiniteScroll: stored.infiniteScroll !== false, // default on
      nightMode: stored.nightMode === true, // default off
    };
  }

  // Larger data blobs (kept out of getPrefs). All default to empty.
  async function getData() {
    const d = await api.storage.local.get({ filters: null, userTags: null, threadVisits: null });
    return {
      filters: d.filters || { subreddits: [], users: [], domains: [], keywords: [], flairs: [] },
      userTags: d.userTags || {},
      threadVisits: d.threadVisits || {},
    };
  }

  async function setPrefs(patch) {
    await api.storage.local.set(patch);
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
    getPrefs, setPrefs, getData, isListingRoute, isCommentsRoute, isUserRoute, isSearchRoute,
  };
})();
