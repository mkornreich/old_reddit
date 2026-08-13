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
    highContrast: "highContrast", dyslexia: "dyslexiaFont", hoverPreview: "hoverPreview",
    expandImages: "expandImages", fixedThumbnails: "fixedThumbnails",
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
  const fCrossposts = document.getElementById("filter-crossposts");
  const fTypeBoxes = {
    image: document.getElementById("filter-type-image"),
    video: document.getElementById("filter-type-video"),
    text: document.getElementById("filter-type-text"),
    link: document.getElementById("filter-type-link"),
  };
  const fFavorites = document.getElementById("favorite-subs");

  function render(p) {
    if (enabledEl) enabledEl.checked = p.enabled;
    Object.keys(TOGGLES).forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.checked = p[TOGGLES[id]] === true; el.disabled = !p.enabled; }
    });
    document.body.classList.toggle("is-off", !p.enabled);
    if (statusEl) statusEl.textContent = p.enabled ? "Classic Layout is ON" : "Off — new Reddit shows as-is";
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
        hideCrossposts: fCrossposts ? fCrossposts.checked : false,
        postTypes: Object.keys(fTypeBoxes).filter((k) => fTypeBoxes[k] && fTypeBoxes[k].checked),
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
    if (fCrossposts) fCrossposts.checked = !!f.hideCrossposts;
    const pt = Array.isArray(f.postTypes) ? f.postTypes : [];
    Object.keys(fTypeBoxes).forEach((k) => { if (fTypeBoxes[k]) fTypeBoxes[k].checked = pt.indexOf(k) >= 0; });
    if (fFavorites) fFavorites.value = toLines(d.favoriteSubs);
  }
  if (fSubs && getData) {
    getData().then(loadFilters);
    [fSubs, fUsers, fDomains, fKeywords, fFlairs, fHighlights, fMinScore, fMaxAge, fHideNsfw, fHidePromoted, fFavorites,
     fCrossposts, fTypeBoxes.image, fTypeBoxes.video, fTypeBoxes.text, fTypeBoxes.link]
      .forEach((el) => el && el.addEventListener("change", saveFilters));
  }

  // ---- layout sliders, per-subreddit prefs, keybindings (options page) ----
  const uiWidth = document.getElementById("ui-width");
  const uiWidthOut = document.getElementById("ui-width-out");
  const uiFont = document.getElementById("ui-font");
  const uiFontOut = document.getElementById("ui-font-out");
  const subPrefsEl = document.getElementById("sub-prefs");
  const keybindList = document.getElementById("keybind-list");
  const KEY_ACTIONS_UI = [
    ["next", "Next item", "j"], ["prev", "Previous item", "k"], ["open", "Open selected", "o"],
    ["expand", "Expand / collapse", "x"], ["comments", "Open comments", "c"], ["goto", "Go to subreddit", "g"],
    ["nextNew", "Next new comment", "n"], ["prevNew", "Prev new comment", "p"],
    ["collapseTop", "Collapse/expand all threads", "["], ["focusThread", "Focus this thread", "]"], ["help", "Toggle help", "?"],
  ];

  function paintSliderOut() {
    if (uiWidthOut && uiWidth) uiWidthOut.textContent = parseInt(uiWidth.value, 10) > 0 ? uiWidth.value + "px" : "default";
    if (uiFontOut && uiFont) uiFontOut.textContent = uiFont.value + "%";
  }
  function saveUi() {
    const patch = {};
    if (uiWidth) patch.contentWidth = parseInt(uiWidth.value, 10) || 0;
    if (uiFont) patch.fontSize = parseInt(uiFont.value, 10) || 100;
    getData().then((d) => setPrefs({ ui: Object.assign({}, d.ui, patch) })); // keep videoSpeed/volume
    paintSliderOut();
  }
  function parseSubPrefs(text) {
    const out = {};
    (text || "").split("\n").forEach((line) => {
      line = line.trim(); if (!line) return;
      const idx = line.indexOf(":");
      const sub = (idx >= 0 ? line.slice(0, idx) : line).trim().replace(/^\/?r\//i, "").toLowerCase();
      if (!sub) return;
      const o = {};
      (idx >= 0 ? line.slice(idx + 1) : "").split(/[,\s]+/).forEach((tok) => {
        tok = tok.trim(); if (!tok) return;
        if (tok.toLowerCase() === "night") o.night = true;
        else if (tok.toLowerCase() === "expand") o.autoExpand = true;
        else if (/^sort=/i.test(tok)) o.sort = tok.slice(5).toLowerCase();
        else if (/^t=/i.test(tok)) o.t = tok.slice(2).toLowerCase();
      });
      out[sub] = o;
    });
    return out;
  }
  function stringifySubPrefs(sp) {
    return Object.keys(sp || {}).map((sub) => {
      const o = sp[sub] || {}, toks = [];
      if (o.night) toks.push("night");
      if (o.sort) toks.push("sort=" + o.sort);
      if (o.t) toks.push("t=" + o.t);
      if (o.autoExpand) toks.push("expand");
      return sub + ": " + toks.join(", ");
    }).join("\n");
  }
  function saveSubPrefs() { if (subPrefsEl) setPrefs({ subPrefs: parseSubPrefs(subPrefsEl.value) }); }
  function buildKeybinds(current) {
    if (!keybindList) return;
    keybindList.innerHTML = "";
    KEY_ACTIONS_UI.forEach((row) => {
      const action = row[0], label = row[1], def = row[2];
      const lab = document.createElement("label");
      lab.className = "orr-field-inline";
      const span = document.createElement("span"); span.textContent = label;
      const inp = document.createElement("input");
      inp.type = "text"; inp.maxLength = 1; inp.dataset.action = action;
      inp.placeholder = def; inp.value = (current && current[action]) || "";
      inp.addEventListener("input", () => { if (inp.value.length > 1) inp.value = inp.value.slice(-1); });
      inp.addEventListener("change", saveKeybinds);
      lab.appendChild(span); lab.appendChild(inp);
      keybindList.appendChild(lab);
    });
  }
  function saveKeybinds() {
    if (!keybindList) return;
    const kb = {};
    keybindList.querySelectorAll("input[data-action]").forEach((inp) => {
      const v = inp.value.trim();
      if (v) kb[inp.dataset.action] = v;
    });
    setPrefs({ keyBindings: kb });
  }
  function loadUiPrefs(d) {
    const ui = (d && d.ui) || {};
    if (uiWidth) uiWidth.value = ui.contentWidth > 0 ? ui.contentWidth : 0;
    if (uiFont) uiFont.value = ui.fontSize > 0 ? ui.fontSize : 100;
    paintSliderOut();
    if (subPrefsEl) subPrefsEl.value = stringifySubPrefs(d && d.subPrefs);
    buildKeybinds((d && d.keyBindings) || {});
  }
  if ((uiWidth || subPrefsEl || keybindList) && getData) {
    getData().then(loadUiPrefs);
    if (uiWidth) { uiWidth.addEventListener("input", paintSliderOut); uiWidth.addEventListener("change", saveUi); }
    if (uiFont) { uiFont.addEventListener("input", paintSliderOut); uiFont.addEventListener("change", saveUi); }
    if (subPrefsEl) subPrefsEl.addEventListener("change", saveSubPrefs);
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
        const fresh = await getData();
        loadFilters(fresh);
        loadUiPrefs(fresh);
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
