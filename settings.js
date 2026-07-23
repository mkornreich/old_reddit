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
  if (fSubs && getData) {
    getData().then((d) => {
      fSubs.value = toLines(d.filters.subreddits);
      fUsers.value = toLines(d.filters.users);
      fDomains.value = toLines(d.filters.domains);
      fKeywords.value = toLines(d.filters.keywords);
    });
    [fSubs, fUsers, fDomains, fKeywords].forEach((el) => el.addEventListener("change", saveFilters));
  }

  getPrefs().then(render);
})();
