"use strict";

// Runs at document_start on old.reddit.com and i.reddit.com. Redirects them to
// www.reddit.com so the rebuilt frontend takes over, and unwraps the
// /login?...&dest=<url> interstitial straight to its destination. Gated by the
// `redirect` pref (default on). Hides the page during the brief pref read so
// there's no flash of the old site.

(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const host = location.hostname;
  if (!/(?:^|\.)(?:old|i)\.reddit\.com$/i.test(host)) return;

  // A JS anti-bot / WAF challenge is mid-handshake — don't redirect. Swapping the
  // host would carry the one-time challenge params (js_challenge / solution+token /
  // jsc_orig_r) onto www and break the handshake. Let it complete on this host,
  // then it redirects to the real URL and we take over normally.
  try {
    const csp = new URLSearchParams(location.search);
    if (csp.has("js_challenge") || csp.has("jsc_orig_r") || (csp.has("solution") && csp.has("token"))) return;
  } catch (e) { /* ignore */ }

  function targetUrl() {
    // /login?...&dest=<encoded> → jump straight to the destination on www.
    if (/\/login\/?$/i.test(location.pathname)) {
      const dest = new URLSearchParams(location.search).get("dest");
      if (dest) {
        try {
          const d = new URL(dest, "https://www.reddit.com");
          // ONLY trust http(s) dests. For non-special schemes (javascript:, data:,
          // …) new URL() keeps an opaque path so setting .hostname is a no-op and the
          // scheme would survive into location.replace() — a DOM-XSS vector. Ignore
          // those and fall through to the plain host-swap below.
          if (d.protocol === "https:" || d.protocol === "http:") {
            d.hostname = "www.reddit.com";
            return d.href;
          }
        } catch (e) { /* fall through */ }
      }
    }
    const u = new URL(location.href);
    u.hostname = "www.reddit.com"; // old.reddit.com / i.reddit.com → www.reddit.com
    return u.href;
  }

  const dest = targetUrl();
  if (!dest || dest === location.href) return; // nothing to change

  // Hide the page while we check the toggle, so redirecting shows no flash.
  let guard = null;
  try {
    guard = document.createElement("style");
    guard.textContent = "html{display:none!important}";
    document.documentElement.appendChild(guard);
  } catch (e) { /* ignore */ }

  function finish(go) {
    if (go) {
      location.replace(dest);
      // If the navigation somehow doesn't happen, don't leave the page hidden.
      setTimeout(() => { if (guard && guard.remove) guard.remove(); }, 3000);
    } else if (guard && guard.remove) {
      guard.remove();
    }
  }

  async function redirectPref() {
    // Setting lives in storage.sync (falls back to local); default on.
    try {
      const s = await api.storage.sync.get({ redirect: undefined });
      if (s && s.redirect !== undefined) return s.redirect;
    } catch (e) { /* sync unavailable */ }
    try {
      const l = await api.storage.local.get({ redirect: undefined });
      if (l && l.redirect !== undefined) return l.redirect;
    } catch (e) { /* ignore */ }
    return true;
  }

  redirectPref().then((r) => finish(r !== false)).catch(() => finish(true));
})();
