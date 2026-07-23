# Old Reddit Skin

A small, dependency-free browser extension — **Firefox and Chrome / Chromium
(Edge, Brave, Opera)** — that **repaints new Reddit in place to look like old
Reddit** — no redirect, just CSS (plus a little JS to reach the parts CSS can't). It
stays on `www.reddit.com` / `sh.reddit.com` and restyles the page.

What it does:

- **Classic styling** — white page, Verdana, flat rows (no rounded cards or
  shadows), the light-blue header band, blue links, compact spacing.
- **Compact feed** — in listings, each post is just a **title + byline line**;
  inline images/videos/galleries and self-text are hidden. Click the little
  **`[+]`** expando on a post to reveal its media inline, or open the post to see
  everything. Small link thumbnails are kept.
- **No signup nag** — hides the logged-out "Join the most real place on the
  internet" promo card.

> Earlier versions of this extension *redirected* to `old.reddit.com`. That has
> been removed — this is now purely the in-place skin. If you want the genuine
> classic site instead, the well-known [Old Reddit
> Redirect](https://addons.mozilla.org/firefox/addon/old-reddit-redirect/) add-on
> does that.

---

## Please read — this is an approximation

New Reddit is a fundamentally different page from old Reddit, so this skin **shifts
colours/typography/density and hides clutter** rather than reproducing old Reddit
exactly. It is inherently fragile:

- It **can't restyle everything.** Parts of new Reddit live inside *closed* Shadow
  DOM that no extension can reach. The skin injects into the main document and
  every *open* shadow root it can find; closed roots stay unstyled.
- It targets shreddit's **custom-element tag names, slot names, and user-facing
  text** (all more stable than Reddit's hashed class names), but Reddit can still
  **break it on any deploy**. When that happens, the fix is updating the selectors
  in [oldreddit-skin-css.js](oldreddit-skin-css.js) / [restyle.js](restyle.js).
- It will **never be a pixel match** for `old.reddit.com`.

---

## Install on Firefox

### Option 1 — Permanent, from the signed `.xpi` (recommended)

1. Download the latest **`old-reddit-skin-*.xpi`** from the
   [**Releases**](https://github.com/mkornreich/old_reddit/releases/latest) page.
2. Install it, either way:
   - **Drag** the `.xpi` onto any Firefox window → click **Add**, or
   - `about:addons` → the gear ⚙️ → **Install Add-on From File…** → pick the `.xpi`.
3. Open `https://www.reddit.com/r/pics` — it should be restyled. Toggle the skin
   on/off from the toolbar button or `about:addons` → **Preferences**.

The `.xpi` is signed by Mozilla, so it installs permanently on regular Firefox and
survives restarts.

### Option 2 — Temporary, from source (no signing, great for hacking)

1. Clone this repo.
2. Open **`about:debugging`** → **This Firefox** → **Load Temporary Add-on…**.
3. Select **`manifest.json`** in the repo.
4. It runs until you restart Firefox.

### Option 3 — Build & sign it yourself

Firefox only installs a *permanent* add-on if it's signed by Mozilla. To produce
your own signed `.xpi` with [`web-ext`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/):

```bash
npm install
npm run lint
npm run sign:unlisted   # needs AMO API key + secret; produces a signed .xpi
```

AMO credentials (a JWT **issuer** + **secret**) come from
<https://addons.mozilla.org/developers/addon/api/key/>, passed via the
`WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` environment variables. Then install the
resulting `.xpi` as in Option 1.

> **Note:** requires Firefox **142+** (set in `manifest.json`).

---

## Install on Chrome (and Edge / Brave / Opera)

There's no Chrome Web Store listing yet, so install it **unpacked** from a clone of
this repo. Chrome, Edge, Brave, and Opera are all Chromium-based, so the **same
folder** loads in every one of them — no separate build.

1. Clone or download this repo to a folder you'll **keep in place** (Chrome
   remembers the path; if you move or delete the folder, the extension breaks on
   next launch).
2. Open the extensions page by typing one of these in the address bar (these
   can't be clickable links):
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
   - Opera: `opera://extensions`
3. Turn on **Developer mode** (toggle top-right on Chrome/Brave/Opera; left sidebar on Edge).
4. Click **Load unpacked** and select the **repo folder** (the one containing
   `manifest.json` — the folder itself, not a file).
5. Open `https://www.reddit.com/r/pics` — it should be restyled. Pin the toolbar
   button via the puzzle-piece 🧩 icon to toggle the skin, or use **Details →
   Extension options**.

> **Heads-up:** unpacked extensions run in Developer mode. A browser update or
> profile reload can auto-disable a dev-mode extension — just re-enable it at
> `chrome://extensions` if that happens.
>
> **Polished option:** publishing to the Chrome Web Store ($5 one-time developer
> fee) gives one-click installs that survive updates and need no Developer mode.
> Edge, Brave, and Opera can all install from the Chrome Web Store too.

### Publishing to the Chrome Web Store

A ready-to-upload package is checked in at
**[`dist/old-reddit-skin-chrome-2.1.0.zip`](dist/)** (`manifest.json` at the zip
root, Chrome-validated, Firefox-only manifest keys stripped). To publish:

1. Register once at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole/)
   (one-time $5 USD fee).
2. **New item** → upload the zip.
3. Fill in the listing: a ≥1280×800 screenshot, a description, and the privacy
   section — declare **no data collected** (the extension only reads Reddit pages
   to restyle them and stores a single on/off flag locally).
4. Submit for review.

To rebuild the zip after changes:

```bash
npm run build                                   # web-ext build -> web-ext-artifacts/*.zip
# then strip the Firefox key + repackage into dist/ (see the release build for exact steps)
```

The **same zip** also uploads to the free [Edge Add-ons](https://partner.microsoft.com/dashboard/microsoftedge/)
store if you ever want an Edge listing.

---

## Develop

```bash
npm install
npm start          # web-ext run: live-reloading test profile
npm run lint       # web-ext lint
npm run build      # distributable .zip in web-ext-artifacts/
```

---

## Options

Click the toolbar button (or open the add-on's preferences in `about:addons`):

- **Old Reddit skin** — a single on/off switch. Toggling takes effect live, no
  reload. Stored in `storage.local`.

---

## How it works

A single content script runs at `document_start` on new-Reddit hosts (never on
`old.reddit.com`):

- **Styling** — [oldreddit-skin-css.js](oldreddit-skin-css.js) holds the skin as a
  string; [restyle.js](restyle.js) injects it into the main document *and* into
  every open shadow root, and re-injects as Reddit's SPA renders (via a
  `MutationObserver`).
- **Compact feed** — CSS hides `[slot="post-media-container"]` / `[slot="text-body"]`
  scoped to `<shreddit-feed>` (plus a `view-context` backstop so the permalink page
  keeps its media), gated by `:not(.orr-expanded)`. A `[+]` button injected per post
  toggles that class to reveal media — the reveal is class-gated, so it survives a
  media selector changing.
- **Signup promo** — found by its text ("Join the most real place on the internet")
  and hidden via a class, so it works regardless of Reddit's class names.

Everything is removable: turning the skin off strips the injected styles, expando
buttons, and hide-classes with no reload.

---

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (Firefox), registers the content script |
| `oldreddit-skin-css.js` | The old-Reddit skin stylesheet (as a string) |
| `restyle.js` | Content script: injects the skin, compact-feed expando, promo hide |
| `common.js` | Shared on/off pref (read by the content script + settings UI) |
| `settings.js` | Wires the on/off toggle to storage |
| `popup.html` / `options.html` / `settings.css` | Toolbar popup and options UI |
| `icons/icon.svg` | Source vector icon |
| `icons/icon-{16,32,48,128}.png` | Extension icons (PNG — required by Chrome) |

No build step and no third-party runtime dependencies.

---

## License

MIT — see [LICENSE](LICENSE).
