"use strict";

// Shared prefs module. Loaded by the settings UI (settings.js) and by the
// content script (restyle.js). The extension is now a pure CSS skin — a single
// on/off preference, no redirect / declarativeNetRequest anymore.

(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const DEFAULTS = Object.freeze({ enabled: true });

  async function getPrefs() {
    const stored = await api.storage.local.get({ enabled: undefined, mode: undefined });
    let enabled = stored.enabled;
    if (enabled === undefined) {
      // Migrate from the pre-2.0 tri-state `mode` ("redirect"/"skin"/"off").
      enabled = stored.mode === "off" ? false : true;
    }
    return { enabled: enabled !== false };
  }

  async function setPrefs(patch) {
    await api.storage.local.set(patch);
  }

  globalThis.ORR = { api, DEFAULTS, getPrefs, setPrefs };
})();
