"use strict";

// The old-Reddit "skin" stylesheet, kept as a string so restyle.js can inject it
// into both the main document AND every open shadow root (shreddit's web
// components), and so it can be toggled on/off per the user's chosen mode.
//
// This is deliberately an APPROXIMATION of old.reddit.com — new Reddit's DOM is
// nothing like old Reddit's, so this repaints colours, typography and density
// rather than reproducing the exact layout. Selectors target shreddit's custom
// element tag names + attributes (which are far more stable than its hashed
// class names). Expect to tune these as Reddit changes its markup.

globalThis.ORR_SKIN_CSS = `
/* ============================================================
   Old Reddit skin — base look
   ============================================================ */

/* The single biggest "old reddit" cue: white page, Verdana, small text. */
html, body, :host,
shreddit-app, shreddit-feed, main, #main-content {
  background: #ffffff !important;
  color: #1a1a1b !important;
  font-family: Verdana, Arial, Helvetica, sans-serif !important;
}
html, body { font-size: 12px !important; line-height: 1.4 !important; }

/* Old reddit is flat: no rounded cards, no drop shadows anywhere. */
*, *::before, *::after {
  border-radius: 0 !important;
  box-shadow: none !important;
}

/* Classic link blues; visited links go purple like old reddit titles. */
a, a * { color: #0000cc !important; text-decoration: none !important; }
a:hover { text-decoration: underline !important; }
a:visited, a:visited * { color: #551a8b !important; }

/* ============================================================
   Top header → classic light-blue band (#cee3f8 / #5f99cf)
   ============================================================ */
reddit-header-large,
reddit-header-action-items,
shreddit-header,
#reddit-header-container,
header[role="banner"],
#header {
  background: #cee3f8 !important;
  border-bottom: 1px solid #5f99cf !important;
  color: #000000 !important;
  min-height: 0 !important;
  height: auto !important;
}
reddit-header-large a, #header a { color: #336699 !important; }

/* Search box + buttons → squared-off, plain. */
input, textarea, select, button, [role="button"], [role="search"] {
  border-radius: 0 !important;
}

/* ============================================================
   Feed / posts → compact rows, thin separators, no cards
   ============================================================ */
shreddit-feed { max-width: none !important; }

article,
shreddit-post,
[data-testid="post-container"] {
  background: #ffffff !important;
  border: 0 !important;
  border-bottom: 1px solid #ededed !important;
  margin: 0 !important;
  padding: 3px 6px !important;
}

/* Post titles: old-reddit blue, normal weight, tighter. */
shreddit-post [slot="title"],
shreddit-post a[slot="title"],
a[data-click-id="body"],
h1, h2, h3 {
  color: #0000cc !important;
  font-weight: normal !important;
  font-size: 14px !important;
  line-height: 1.3 !important;
}

/* Post meta (author / subreddit / time) → small grey. */
shreddit-post [slot="credit-bar"],
time, faceplate-timeago,
[data-testid="post_author_link"] {
  font-size: 10px !important;
  color: #888888 !important;
}

/* Vote arrows → orangered up, periwinkle down (old reddit palette). */
[aria-label*="upvote" i], [icon-name="upvote-outline"], [icon-name="upvote-fill"] {
  color: #ff4500 !important;
}
[aria-label*="downvote" i], [icon-name="downvote-outline"], [icon-name="downvote-fill"] {
  color: #7193ff !important;
}

/* ============================================================
   Left nav + right sidebar → plain, dense (no boxes/borders)
   ============================================================ */
left-nav-top-section, #left-sidebar, nav[aria-label] {
  background: #ffffff !important;
  font-size: 11px !important;
}
#right-sidebar-container, [data-testid="subreddit-sidebar"] {
  background: #ffffff !important;
  font-size: 11px !important;
}

/* Generic buttons → old grey 3D-ish. */
button, [role="button"] {
  background: #f0f0f0 !important;
  border: 1px solid #a5a5a5 !important;
  color: #333333 !important;
  font-size: 11px !important;
}

/* Comments: thin left rule per nesting level, tight spacing. */
shreddit-comment {
  border-left: 1px solid #dddddd !important;
  margin: 0 0 0 6px !important;
  padding: 2px 0 2px 6px !important;
}

/* Images: no rounding (old reddit thumbnails were square). */
img { border-radius: 0 !important; }

/* ============================================================
   Compact feed (old-reddit style): in the FEED only, hide the big
   inline image / video / gallery / self-text so each post is just a
   title + byline line. Small link thumbnails are kept. Reveal a
   single post's media with the injected [+] expando (adds
   .orr-expanded) or by opening the post. Every rule is gated by
   :not(.orr-expanded) and scoped to the feed, so the permalink /
   comments page is never affected.
   Selectors verified against live shreddit DOM (2026-07).
   ============================================================ */

/* PRIMARY — big inline media + self-text, scoped by the feed ancestor. */
shreddit-feed shreddit-post:not(.orr-expanded) [slot="post-media-container"],
shreddit-feed shreddit-post:not(.orr-expanded) [slot="text-body"] {
  display: none !important;
}

/* SECONDARY — feed posts Reddit renders outside <shreddit-feed>.
   Excludes the permalink post by view-context. */
shreddit-post[view-context]:not([view-context="CommentsPage"]):not(.orr-expanded) [slot="post-media-container"],
shreddit-post[view-context]:not([view-context="CommentsPage"]):not(.orr-expanded) [slot="text-body"] {
  display: none !important;
}

/* FALLBACK — if Reddit renames the media slot, hit the concrete media
   elements directly (still feed- and :not(.orr-expanded)-scoped). */
shreddit-feed shreddit-post:not(.orr-expanded) gallery-carousel,
shreddit-feed shreddit-post:not(.orr-expanded) shreddit-player,
shreddit-feed shreddit-post:not(.orr-expanded) shreddit-player-2,
shreddit-feed shreddit-post:not(.orr-expanded) shreddit-media-lightbox-listener,
shreddit-feed shreddit-post:not(.orr-expanded) zoomable-img,
shreddit-feed shreddit-post:not(.orr-expanded) img.preview-img,
shreddit-feed shreddit-post:not(.orr-expanded) img#post-image,
shreddit-feed shreddit-post:not(.orr-expanded) shreddit-post-text-body,
shreddit-feed shreddit-post:not(.orr-expanded) [id$="-post-rtjson-content"] {
  display: none !important;
}

/* The old-reddit-style [+]/[–] expando box, injected per feed post. */
.orr-expando-btn {
  display: inline-block !important;
  box-sizing: border-box !important;
  width: 22px !important;
  height: 22px !important;
  margin: 2px 6px 2px 2px !important;
  border: 1px solid #808080 !important;
  background: #ffffff !important;
  color: #808080 !important;
  font: 15px/20px monospace !important;
  text-align: center !important;
  cursor: pointer !important;
  vertical-align: middle !important;
  -webkit-user-select: none !important;
  user-select: none !important;
}
.orr-expando-btn::before { content: "+"; }
shreddit-post.orr-expanded .orr-expando-btn::before { content: "–"; }

/* ============================================================
   Hide the logged-out "Join the most real place on the internet"
   signup promo. Verified live: it's a single light-DOM card wrapped
   in <faceplate-tracker noun="static_left_rail_banner"> in the LEFT
   rail. NOTE: never hide #left-sidebar-container itself — when logged
   in that same container holds the real left navigation.
   ============================================================ */
faceplate-tracker[noun="static_left_rail_banner"],
#left-sidebar-container faceplate-tracker[source="xpromo"] {
  display: none !important;
}

/* Reclaim the empty left column the banner leaves (logged-out upsell grid only). */
.grid-container.flex-nav-upsell {
  grid-template-columns: 0 minmax(0, 1fr) !important;
}

/* JS fallback (restyle.js): if Reddit renames the noun, the promo's
   <faceplate-tracker> ancestor is tagged with this class by text match. */
.orr-hidden-promo { display: none !important; }
`;
