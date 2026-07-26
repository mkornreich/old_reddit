"use strict";

// Wires the settings UI (popup.html + options.html) to storage. Rebuild is now
// the only mode; the content script (rebuild.js) reacts to changes live.

(function () {
  const { getPrefs, setPrefs, getData } = globalThis.ORR;

  const enabledEl = document.getElementById("enabled");
  const statusEl = document.getElementById("status");

  // element id -> pref key for every boolean toggle
  const TOGGLES = {
    night: "nightMode", infinite: "infiniteScroll", redirect: "redirect",
    subredditCss: "subredditCss", autoplay: "autoplayMedia", hideRead: "hideRead",
    autoCollapseBots: "autoCollapseBots", compact: "compactView", nightAuto: "nightAuto",
    highContrast: "highContrast", dyslexia: "dyslexiaFont",
  };

  // Filter lists / advanced (options page only).
  const fSubs = document.getElementById("filter-subreddits");
  const fUsers = document.getElementById("filter-users");
  const fDomains = document.getElementById("filter-domains");
  const fKeywords = document.getElementById("filter-keywords");
  const fFlairs = document.getElementById("filter-flairs");
  const fHighlights = document.getElementById("filter-highlights");
  const fMinScore = document.getElementById("filter-minscore");
  const fMaxAge = document.getElementById("filter-maxage");
  const fHideNsfw = document.getElementById("filter-nsfw");
  const fHidePromoted = document.getElementById("filter-promoted");
  const fFavorites = document.getElementById("favorite-subs");

  function render(p) {
    if (enabledEl) enabledEl.checked = p.enabled;
    Object.keys(TOGGLES).forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.checked = p[TOGGLES[id]] === true; el.disabled = !p.enabled; }
    });
    document.body.classList.toggle("is-off", !p.enabled);
    if (statusEl) statusEl.textContent = p.enabled ? "Old Reddit is ON" : "Off — new Reddit shows as-is";
  }

  async function update(patch) {
    await setPrefs(patch);
    render(await getPrefs());
  }

  if (enabledEl) enabledEl.addEventListener("change", () => update({ enabled: enabledEl.checked }));
  Object.keys(TOGGLES).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => update({ [TOGGLES[id]]: el.checked }));
  });

  // ---- filters (options page) ----
  const toArr = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const toLines = (a) => (a || []).join("\n");
  const numOrNull = (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; };
  function saveFilters() {
    if (!fSubs) return;
    setPrefs({
      filters: {
        subreddits: toArr(fSubs.value),
        users: toArr(fUsers.value),
        domains: toArr(fDomains.value),
        keywords: toArr(fKeywords.value),
        flairs: fFlairs ? toArr(fFlairs.value) : [],
        highlights: fHighlights ? toArr(fHighlights.value) : [],
        minScore: fMinScore ? numOrNull(fMinScore.value) : null,
        maxAgeHours: fMaxAge ? numOrNull(fMaxAge.value) : null,
        hideNsfw: fHideNsfw ? fHideNsfw.checked : false,
        hidePromoted: fHidePromoted ? fHidePromoted.checked : false,
      },
    });
    if (fFavorites) setPrefs({ favoriteSubs: toArr(fFavorites.value) });
  }
  function loadFilters(d) {
    if (!fSubs) return;
    const f = d.filters || {};
    fSubs.value = toLines(f.subreddits);
    fUsers.value = toLines(f.users);
    fDomains.value = toLines(f.domains);
    fKeywords.value = toLines(f.keywords);
    if (fFlairs) fFlairs.value = toLines(f.flairs);
    if (fHighlights) fHighlights.value = toLines(f.highlights);
    if (fMinScore) fMinScore.value = f.minScore != null ? f.minScore : "";
    if (fMaxAge) fMaxAge.value = f.maxAgeHours != null ? f.maxAgeHours : "";
    if (fHideNsfw) fHideNsfw.checked = !!f.hideNsfw;
    if (fHidePromoted) fHidePromoted.checked = !!f.hidePromoted;
    if (fFavorites) fFavorites.value = toLines(d.favoriteSubs);
  }
  if (fSubs && getData) {
    getData().then(loadFilters);
    [fSubs, fUsers, fDomains, fKeywords, fFlairs, fHighlights, fMinScore, fMaxAge, fHideNsfw, fHidePromoted, fFavorites]
      .forEach((el) => el && el.addEventListener("change", saveFilters));
  }

  // ---- export / import (options page) ----
  const api = globalThis.ORR.api;
  const exportBtn = document.getElementById("export-btn");
  const importBtn = document.getElementById("import-btn");
  const importFile = document.getElementById("import-file");

  async function collectAll() {
    const local = await api.storage.local.get(null);
    let sync = {};
    try { sync = await api.storage.sync.get(null); } catch (e) { /* sync unavailable */ }
    return Object.assign({}, local, sync); // sync wins for shared keys
  }
  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      const data = await collectAll();
      const payload = { _oldreddit: 1, exported: new Date().toISOString(), data };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "old-reddit-settings.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      if (statusEl) statusEl.textContent = "Exported settings.";
    });
  }
  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      const file = importFile.files && importFile.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const data = parsed && parsed.data ? parsed.data : parsed;
        if (!data || typeof data !== "object") throw new Error("unrecognized file");
        delete data.mode; // drop legacy key
        await setPrefs(data); // routes each key to sync or local
        render(await getPrefs());
        loadFilters(await getData());
        if (statusEl) statusEl.textContent = "Imported. Reload Reddit to apply.";
      } catch (e) {
        if (statusEl) statusEl.textContent = "Import failed: " + ((e && e.message) || "invalid file");
      } finally {
        importFile.value = "";
      }
    });
  }

  getPrefs().then(render);
})();
