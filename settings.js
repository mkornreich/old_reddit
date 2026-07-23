"use strict";

// Wires the single on/off toggle (shared markup in popup.html and options.html)
// to storage. The content script (restyle.js) reacts to the `enabled` change via
// storage.onChanged, so toggling takes effect live without a reload.

(function () {
  const { getPrefs, setPrefs } = globalThis.ORR;

  const enabledEl = document.getElementById("enabled");
  const statusEl = document.getElementById("status");

  function render(p) {
    enabledEl.checked = p.enabled;
    document.body.classList.toggle("is-off", !p.enabled);
    if (statusEl) {
      statusEl.textContent = p.enabled
        ? "Old Reddit skin is ON"
        : "Off — Reddit looks normal";
    }
  }

  async function update(patch) {
    await setPrefs(patch);
    render(await getPrefs());
  }

  enabledEl.addEventListener("change", () => update({ enabled: enabledEl.checked }));

  getPrefs().then(render);
})();
