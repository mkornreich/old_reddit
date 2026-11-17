// The extension's runtime files — what ships in a package / gets loaded unpacked —
// and the Chromium (Chrome/Edge/Opera/Brave) manifest. Shared by
// build-chromium-zip.mjs and playwright/stage-ext.mjs.
export const EXT_FILES = [
  "manifest.json", "common.js", "rebuild.js", "no-google-prompt.js", "redirect.js", "settings.js", "settings.css",
  "popup.html", "options.html", "background.js", "permission-prompt.html", "permission-prompt.js",
  "vendor/oldreddit.bundled.css", "vendor/dash.mediaplayer.min.js",
  "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png", "icons/icon.svg",
];

// The repo's manifest.json is Firefox's (what web-ext lints, builds and signs):
// background.scripts + browser_specific_settings. Chromium wants a background
// service_worker instead — Edge's store rejects background.scripts in MV3, and
// Firefox's validator warns about an (ignored) service_worker key — so the
// Chromium build swaps them.
export function chromiumManifest(firefoxManifest) {
  const m = JSON.parse(JSON.stringify(firefoxManifest));
  delete m.browser_specific_settings;
  const bg = m.background || {};
  const sw = bg.service_worker || (Array.isArray(bg.scripts) && bg.scripts.length === 1 ? bg.scripts[0] : null);
  if (!sw) throw new Error("can't derive a background service_worker from manifest.background");
  m.background = { service_worker: sw };
  return m;
}
