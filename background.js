"use strict";

// Inline previews for Bluesky, Twitter/X, and Giphy content that Reddit's own
// page CSP blocks as cross-origin iframes, or (for Giphy) that connect-src
// blocks fetching directly from the content script — see issue #20. Modifying
// the CSP itself doesn't work: Firefox always merges an extension's CSP edit
// with the original (by design, to stop extensions loosening a page's policy
// — see https://bugzilla.mozilla.org/show_bug.cgi?id=1462989), and Chrome's
// MV3 replacement (declarativeNetRequest) can only overwrite a header
// wholesale, not extend it. So instead — matching how RES handles Bluesky and
// Twitter — we never embed a cross-origin iframe for these at all: fetch each
// platform's own oEmbed endpoint and hand the content script the fields it
// needs to render the post as its OWN same-origin DOM. That fetch has to
// happen here, not in the content script — a content-script fetch is also
// bound by the page's CSP connect-src, which only allows *.giphy.com
// (subdomains), not the bare giphy.com domain the oEmbed endpoint is actually
// on, and doesn't list the other two hosts at all.
//
// We deliberately return STRUCTURED DATA, never the provider's raw HTML, so the
// content script can rebuild the preview with textContent + scheme-validated
// attributes and never inject third-party markup into the logged-in reddit.com
// origin (see rebuild.js renderOembedNode).
//
// Twitch clips and Imgur galleries don't get this treatment: Twitch has no
// public oEmbed endpoint (RES doesn't solve that one either — it still just
// embeds a plain iframe, which Reddit's CSP blocks the same way ours would),
// and a working Imgur fix means calling Imgur's own API, which needs a
// registered API client ID — a manual, one-time setup step for whoever runs
// this, not something to hardcode. Both just get an "open externally" link.

const isFirefox = typeof browser !== "undefined";
const api = isFirefox ? browser : chrome;

// Per platform: the optional host permission it needs, a display label, a guard
// that the href really belongs to the platform (defense in depth — the fetch
// target is a fixed endpoint regardless, but don't hand an unrelated URL to a
// provider's oEmbed service), the oEmbed request URL, and a mapper from the
// oEmbed JSON to a SAFE structured descriptor the content script renders
// natively. `html` is passed through ONLY for the quote providers and is parsed
// inertly (never injected) content-side to pull out the post text.
const OEMBED = {
  bluesky: {
    origin: "https://embed.bsky.app/*",
    label: "Bluesky",
    match: (href) => /^https?:\/\/(?:[\w-]+\.)*bsky\.app\/profile\/[^/]+\/post\/[A-Za-z0-9]+/i.test(href),
    url: (href) => "https://embed.bsky.app/oembed?url=" + encodeURIComponent(href.replace(/\/+$/, "")),
    toData: (data) =>
      data && typeof data.html === "string"
        ? { kind: "quote", author: typeof data.author_name === "string" ? data.author_name : "", html: data.html }
        : null,
  },
  twitter: {
    origin: "https://publish.twitter.com/*",
    label: "Twitter/X",
    match: (href) => /^https?:\/\/(?:[\w-]+\.)*(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i.test(href),
    url: (href) => "https://publish.twitter.com/oembed?omit_script=true&url=" + encodeURIComponent(href),
    toData: (data) =>
      data && typeof data.html === "string"
        ? { kind: "quote", author: typeof data.author_name === "string" ? data.author_name : "", html: data.html }
        : null,
  },
  giphy: {
    origin: "https://giphy.com/*",
    label: "Giphy",
    match: (href) => /^https?:\/\/(?:www\.)?giphy\.com\/gifs\/[\w-]+/i.test(href),
    url: (href) => "https://giphy.com/services/oembed?url=" + encodeURIComponent(href),
    // Giphy's oEmbed has no html field, just a direct media URL.
    toData: (data) => {
      if (!data || typeof data.url !== "string") return null;
      return {
        kind: "media",
        mediaType: data.type === "video" ? "video" : "img",
        url: data.url,
        width: Number.isFinite(data.width) ? data.width : null,
        height: Number.isFinite(data.height) ? data.height : null,
      };
    },
  },
};

async function fetchOembedData(platform, href) {
  const spec = OEMBED[platform];
  if (!spec) throw new Error("unknown platform: " + platform);
  if (typeof href !== "string" || !spec.match(href)) throw new Error("href does not match platform");
  const res = await fetch(spec.url(href), { credentials: "omit" });
  if (!res.ok) throw new Error("oEmbed request failed: " + res.status);
  const data = await res.json();
  const out = spec.toData(data);
  if (!out) throw new Error("oEmbed response missing usable content");
  return out;
}

// Both Firefox and Chrome refuse permissions.request() unless it's a
// synchronous click on an extension-owned page — calling it here in response
// to a content-script message doesn't count. permission-prompt.html, a small
// popup with its own button, provides that click; once it closes, check the
// real permission state rather than trusting anything it reports (it may be
// closed without completing the request).
//
// Scoped per platform deliberately, even though it means two separate grant
// flows if the user wants both Bluesky and Twitter/X: a button labeled
// "Enable Bluesky previews" should only ever grant Bluesky, not silently
// bundle in Twitter/X too.
function requestViaPopup(platform) {
  const spec = OEMBED[platform];
  if (!spec) return Promise.resolve(false);
  const permSet = { origins: [spec.origin] };
  return new Promise((resolve) => {
    let winId = null;
    function finish() {
      api.windows.onRemoved.removeListener(onClosed);
      api.permissions.contains(permSet)
        .then((has) => resolve(!!has))
        .catch(() => resolve(false));
    }
    function onClosed(windowId) {
      if (windowId === winId) finish();
    }
    const url = api.runtime.getURL("permission-prompt.html") +
      "?origin=" + encodeURIComponent(spec.origin) + "&label=" + encodeURIComponent(spec.label);
    api.windows
      .create({ url, type: "popup", width: 420, height: 260 })
      .then((win) => { winId = win.id; api.windows.onRemoved.addListener(onClosed); })
      .catch(() => resolve(false));
  });
}

if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "orr-check-embed-permission") {
      const spec = OEMBED[msg.platform];
      if (!spec) { sendResponse({ granted: false }); return; }
      api.permissions.contains({ origins: [spec.origin] })
        .then((has) => sendResponse({ granted: !!has }))
        .catch(() => sendResponse({ granted: false }));
      return true; // keep the message channel open for the async response
    }
    if (msg.type === "orr-request-embed-permission") {
      requestViaPopup(msg.platform).then((granted) => sendResponse({ granted: !!granted }));
      return true;
    }
    if (msg.type === "orr-fetch-oembed") {
      fetchOembedData(msg.platform, msg.href)
        .then((data) => sendResponse({ data }))
        .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    }
  });
}
