# Old Reddit Skin (Firefox)

A small, dependency-free Firefox extension that **repaints new Reddit in place to
look like old Reddit** — no redirect, just CSS (plus a little JS to reach the parts
CSS can't). It stays on `www.reddit.com` / `sh.reddit.com` and restyles the page.

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
| `icons/icon.svg` | Extension icon |

No build step and no third-party runtime dependencies.

---

## License

MIT — see [LICENSE](LICENSE).
