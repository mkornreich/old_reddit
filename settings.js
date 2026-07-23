"use strict";

// Wires the toggles (shared markup in popup.html and options.html) to storage.
// The content scripts react to changes via storage.onChanged, so toggling takes
// effect live (rebuild mode reloads the page to hand it over/back).

(function () {
  const { getPrefs, setPrefs } = globalThis.ORR;

  const enabledEl = document.getElementById("enabled");
  const rebuildEl = document.getElementById("rebuild");
  const infiniteEl = document.getElementById("infinite");
  const statusEl = document.getElementById("status");

  function render(p) {
    enabledEl.checked = p.enabled;
    if (rebuildEl) rebuildEl.checked = p.rebuild;
    if (infiniteEl) {
      infiniteEl.checked = p.infiniteScroll;
      infiniteEl.disabled = !p.rebuild; // only meaningful in Rebuild mode
      const row = infiniteEl.closest(".orr-row");
      if (row) row.classList.toggle("orr-disabled", !p.rebuild);
    }
    document.body.classList.toggle("is-off", !p.enabled && !p.rebuild);
    if (statusEl) {
      statusEl.textContent = p.rebuild
        ? "Rebuild mode ON (experimental)"
        : p.enabled
          ? "Old Reddit skin is ON"
          : "Off — Reddit looks normal";
    }
  }

  async function update(patch) {
    await setPrefs(patch);
    render(await getPrefs());
  }

  enabledEl.addEventListener("change", () => update({ enabled: enabledEl.checked }));
  if (rebuildEl) rebuildEl.addEventListener("change", () => update({ rebuild: rebuildEl.checked }));
  if (infiniteEl) infiniteEl.addEventListener("change", () => update({ infiniteScroll: infiniteEl.checked }));

  getPrefs().then(render);
})();
