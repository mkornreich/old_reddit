# Playwright checks & Reddit probes

Tools used to diagnose and verify the **logged-out** rebuild (v3.16): Reddit
answers every logged-out `.json` request with a `403` "blocked by network security"
page, so `rebuild.js` falls back to parsing the HTML Reddit still serves. Every
script runs a **fresh, logged-out profile**. Nothing here is packaged into the
extension (`web-ext-config.cjs` ignores `scripts/`).

## Setup

```bash
cd scripts/playwright
npm install
npx playwright install chromium firefox
node stage-ext.mjs            # copies the extension's runtime files into ./ext (Chromium manifest)
node stage-ext.mjs ../.. ./ext-ff --firefox   # same, with the repo's Firefox manifest, for firefox*.mjs
```

Re-run `stage-ext.mjs` after every source change. Reddit bot-challenges headless
browsers, so run headed under a virtual display. Also, IPv6 to reddit timed out on
the dev machine; Chromium falls back to IPv4 on its own.

```bash
env -u WAYLAND_DISPLAY xvfb-run -a -s "-screen 0 1600x1000x24" node <script> …
```

On a Wayland desktop, `xvfb-run` alone isn't enough: it only swaps `DISPLAY`, so
browsers pick up `WAYLAND_DISPLAY` and open real windows on your screen. Every
script imports `hidden-display.mjs` first, which drops the Wayland variables, and
the `env -u` above does the same. New scripts should import it too.

## Verification scripts (load the extension)

| Script | What it checks |
|---|---|
| `run.mjs <ext> <out> <url>…` | Per URL, whether it was rebuilt or left native, plus post/comment/stub counts, the `.json`/partial responses, console errors and a screenshot. Writes `<out>/results.json`. `HEADED=1` runs it headed. |
| `interact.mjs <ext> <out> [sub]` | Infinite scroll; in-page navigation from a listing to a thread; a nested "load more comments" stub; auto-loading top-level comments at the bottom; no duplicate IDs; no new-Reddit CSS left on the page. |
| `live-extras.mjs <ext> <out> <sub> <videoSub>` | Stickies listed first in old-reddit green, the right-rail sidebar, and a video playing inline with audio from Reddit's packaged MP4 (checks `currentTime` and decoded audio bytes). |
| `render-sweep.mjs <ext> <out> <url>…` | Opens every expando on each page and checks what rendered: broken images, videos that never load, the same media shown twice, empty expandos, page errors. Writes `<out>/render.json` and screenshots. |
| `nsfw-gate.mjs <ext> <out> [sub]` | Logged-out over-18 gate: an adult sub shows old reddit's interstitial; **continue** renders the listing in place (no reroute) and is remembered across navigation and reloads; a direct NSFW thread in a fresh profile gets the post gate; expanded media is the real source, not Reddit's `blur=40` preview; "no thank you" goes to the front page. Exits non-zero on failure. |
| `popup-check.mjs <ext> <out>` | Opens the extension's own popup and options pages and checks every image on them loaded (the popup logo was once missing from the Chrome build). |
| `quick-actions.mjs <ext> <out>` | Tagline filter/tag icons (PR #29 + follow-up), live and logged out: hidden until hover, filter → hide + toast + undo, tag → badge with stable icon order across reloads, logged-out hover cards with karma/cake day and weekly visitors, tag-only icons on comment pages. Exits non-zero on failure. |
| `user-pages.mjs <ext> <out> [user]` | Logged-out user profiles in the old layout: overview (posts + comments "on <post> in r/sub"), submitted, comments sorted by top, the karma and cake-day sidebar, infinite scroll without duplicates, clicking a listing author, and a profile whose posts are hidden (old layout plus a message). Exits non-zero on failure. |
| `front-tabs.mjs <ext> <out>` | Logged-out front page and r/all sort tabs really sort (PR #30): post ages per tab (new ≈ 0 h, top/hour < 1.5 h), the "best" default, tab tooltips, front-page infinite scroll. Exits non-zero on failure. |
| `firefox-scroll.mjs <ext> <out> <url> [steps]`, `chromium-scroll.mjs` (same args) | Scroll a page step by step and log comment/stub counts, page height, scroll jumps, page/console errors and failed requests. |
| `hover-scroll.mjs firefox\|chromium <ext> <out> <url>` | Scroll in small steps with the pointer resting over the content, and count hover cards / image previews that pop up and the hover-card fetches they trigger. |
| `firefox-csp.mjs <ext> <out> <url>` | Firefox: the document's CSP and every CSP console message. The "blocked … default-src 'none'" errors on logged-out `.json` come from Reddit's 403 block page, not the page's real policy. |
| `media-checks.mjs <ext>` | A GIF post loops muted, the reCAPTCHA badge stays hidden, and a single-comment permalink shows just that thread with the infobar. |
| `expand.mjs <ext> <out> <url> [n]` | Clicks the first *n* expandos (image, gallery, video) and screenshots them. |
| `firefox.mjs <ext> <out> <listing> <thread>` | Installs the extension as a temporary add-on in Playwright's Firefox (over the Remote Debugging Protocol) and runs the listing, thread and load-more checks. |
| `firefox-page.mjs <ext> <out> <url>` | Firefox (temporary add-on): what one page's post media actually rendered and whether each image/video loaded, plus a screenshot. |
| `inspect-css.mjs <ext> <url> <selector>` | Lists every stylesheet in the rebuilt page and the rules that style one element. |
| `css-timeline.mjs <ext> <out> <url>…` | Samples the page's `<style>`/`<link>` elements over time. This found new Reddit's CSS leaking in after the body swap. |
| `offline.mjs <repo> <saved.html>…` | Runs the parsers exposed on `ORR_REBUILD` against saved HTML with no network: post types, dates, comment-tree integrity, sanitiser (spoilers, screen-reader text), packaged-MP4 video, and, by fixture file name, right-rail sidebars (`*right_rail*`) and stickies (`_r_<sub>_.html`). Exits non-zero on failure. Also checks that a post with both media and its own text shows both, and that no post gets an empty body. |
| `lab-post.mjs <repo> <saved.html>` | Offline: runs a saved page's first `<shreddit-post>` through `postFromShreddit` + `postExpando` and prints what the post would show (type, body text, whether the expando has an image and/or text). |

## Probes (no extension, raw Reddit behaviour)

| Script | Finding |
|---|---|
| `probe.mjs [sub]` | `.json` → 403 HTML; `.rss` → 200; the HTML page and `/svc/shreddit/community-more-posts/…` → 200. |
| `probe2.mjs`, `probe3.mjs` | `shreddit-post` attributes; the 403 body text; old.reddit redirects logged-out visitors to `/login`. |
| `probe4.mjs <out.json>`, `probe5.mjs <out.json>` | Thread pages hold their comments inside `<template>`s; more-comments partials are POST requests. |
| `probe6.mjs <outdir>` | Feed endpoints per route (front page → `home-feed`, r/popular → `popular-feed`; r/all and `a+b` have none) and markup samples for each post type. |
| `probe7.mjs <out.json>` | Logged-out POST to more-comments works with just the `cursor` field (no CSRF token). |
| `probe8.mjs` | Paging: `after=base64(fullname)`, 25 per page; the feeds return 3 posts on their first call. |
| `probe9.mjs` | `Accept: text/vnd.reddit.partial+html` shrinks responses by 40–60%. |
| `probe10.mjs [sub]` | The right-rail sidebar partial (`/svc/shreddit/feeds/subreddit-right-rail?name=`); stickies exist only as `community-highlight-card`s on the sub page; `shreddit-player`'s `packaged-media-json` lists signed progressive MP4s (H.264 + AAC). |
| `sweep.mjs <repo> <out> [maxThreads]` | Broad parser sweep: about 65 subreddits' listings plus a thread from each, run through `ORR_REBUILD`. Flags unknown post types, bodies or media in the raw HTML that weren't parsed, dropped comments, empty comment bodies and unhandled post attributes, and saves the raw HTML of anything flagged. Found `multi_media`, `gif`, `customPost`, crosspost bodies, `stickied`/`locked` and comment GIFs. |
| `probe11.mjs [sub]` | NSFW logged out: listing partials and thread pages carry full data (`nsfw` + `subreddit-nsfw` attributes). Media sits in `shreddit-blurred-container`, with `slot="blurred"` (blur=40 previews) and `slot="revealed"` (the real thing). |
| `probe12.mjs [user] [sub]` | Logged-out hover-card data: `/svc/shreddit/user-hover-card/<name>` (~8 KB: cake day, post + comment karma) and `/svc/shreddit/community-hover-card/<sub>` (~5 KB: description, weekly visitors and contributions), versus the 37–74 KB right-rail partial. |
| `probe13.mjs <out> [user]` | Logged-out profiles: the page HTML has only ~8 items, but the feed partials `/svc/shreddit/profiles/profile_{overview,posts,comments}-more-posts/…` serve 25 at a time (`shreddit-post` + `shreddit-profile-comment`), with no bot check. |
| `probe14.mjs [user]` | Profile feed paging (`after=base64(fullname)`) and sorting. Sorting is a query parameter (`&sort=top&t=all`); the path segment is ignored. |
| `probe15.mjs` | Front-page feeds logged out: `home-feed` ignores `sort`/`t` (every sort is the same 0.8–91 h mix); `popular-feed` honours them (new = 0 h, top/hour 0.4–1 h, controversial ratio ≈ 0.5). |
| `probe16.mjs <permalink>` | Follows a thread's top-level "more comments" chain to the end and counts comments by depth. Shows where Reddit's own chain stops, e.g. r/Salary: 15 + 8 + 48 top-level. |
| `probe17.mjs` | Multi_media (text + inline image) posts in subreddit listing feeds: body text, images in the body, `<object>` embeds (links), media-slot images. Listing feeds can send such a post's body empty, with no image anywhere; only the thread page has the figure. |
| `feed-one.mjs <sub> <t3_id> [<out>]` | Walks a subreddit's logged-out listing feed (hot/new/top, a few pages each) to find one post and saves its card as `card-<id>.html`, for `offline.mjs` / `lab-post.mjs`. |
| `save.mjs <outdir> <path>…` | Saves raw HTML of Reddit paths (input for `offline.mjs`). `ACCEPT_PARTIAL=1` requests Reddit's partial rendering, like the extension does. |

Saved HTML and screenshots are Reddit content and test output, so they're gitignored.
Capture fresh samples with `save.mjs` when needed.
