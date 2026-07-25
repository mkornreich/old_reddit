"use strict";

// Wires the settings UI (popup.html + options.html) to storage. Rebuild is now
// the only mode; the content script (rebuild.js) reacts to changes live.

(function () {
  const { getPrefs, setPrefs, getData } = globalThis.ORR;

  const enabledEl = document.getElementById("enabled");
  const nightEl = document.getElementById("night");
  const infiniteEl = document.getElementById("infinite");
  const statusEl = document.getElementById("status");

  // Filter lists (options page only).
  const fSubs = document.getElementById("filter-subreddits");
  const fUsers = document.getElementById("filter-users");
  const fDomains = document.getElementById("filter-domains");
  const fKeywords = document.getElementById("filter-keywords");

  function render(p) {
    if (enabledEl) enabledEl.checked = p.enabled;
    if (nightEl) {
      nightEl.checked = p.nightMode;
      nightEl.disabled = !p.enabled;
    }
    if (infiniteEl) {
      infiniteEl.checked = p.infiniteScroll;
      infiniteEl.disabled = !p.enabled;
    }
    document.body.classList.toggle("is-off", !p.enabled);
    if (statusEl) statusEl.textContent = p.enabled ? "Old Reddit is ON" : "Off — new Reddit shows as-is";
  }

  async function update(patch) {
    await setPrefs(patch);
    render(await getPrefs());
  }

  if (enabledEl) enabledEl.addEventListener("change", () => update({ enabled: enabledEl.checked }));
  if (nightEl) nightEl.addEventListener("change", () => update({ nightMode: nightEl.checked }));
  if (infiniteEl) infiniteEl.addEventListener("change", () => update({ infiniteScroll: infiniteEl.checked }));

  // ---- filters (options page) ----
  const toArr = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
  const toLines = (a) => (a || []).join("\n");
  function saveFilters() {
    setPrefs({
      filters: {
        subreddits: toArr(fSubs.value),
        users: toArr(fUsers.value),
        domains: toArr(fDomains.value),
        keywords: toArr(fKeywords.value),
        flairs: [],
      },
    });
  }
  function loadFilters(d) {
    if (!fSubs) return;
    fSubs.value = toLines(d.filters.subreddits);
    fUsers.value = toLines(d.filters.users);
    fDomains.value = toLines(d.filters.domains);
    fKeywords.value = toLines(d.filters.keywords);
  }
  if (fSubs && getData) {
    getData().then(loadFilters);
    [fSubs, fUsers, fDomains, fKeywords].forEach((el) => el.addEventListener("change", saveFilters));
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
