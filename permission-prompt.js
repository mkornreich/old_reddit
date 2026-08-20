"use strict";

// Both Firefox and Chrome only allow permissions.request() from a
// synchronous click on an extension-owned page — a background script
// responding to a message from the content script doesn't count (see
// background.js's requestViaPopup). This popup window exists solely to
// provide that click, scoped to exactly the one origin background.js asked
// for — never bundling in a second platform's permission unasked.
const api = typeof browser !== "undefined" ? browser : chrome;

const params = new URLSearchParams(location.search);
const origin = params.get("origin");
const label = params.get("label") || "this site";

document.getElementById("title").textContent = "Enable " + label + " previews";
document.getElementById("explanation").textContent =
  "Reddit's own page policy blocks " + label + " posts from loading as embeds. Instead, Classic Layout " +
  "for Reddit fetches the post directly from " + label + "'s own preview service and shows it inline. " +
  "Your browser requires a click on a page like this one — not the extension's popup — to grant " +
  "permission to contact " + label + ".";

const btn = document.getElementById("grant");
const status = document.getElementById("status");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  status.textContent = "Requesting…";
  try {
    const granted = origin ? await api.permissions.request({ origins: [origin] }) : false;
    status.textContent = granted ? "Granted — closing…" : "Not granted.";
    setTimeout(() => { try { window.close(); } catch (e) {} }, granted ? 400 : 1200);
  } catch (e) {
    status.textContent = "Error: " + ((e && e.message) || String(e));
    btn.disabled = false;
  }
});
