// Runs in the page's own world (manifest: "world": "MAIN"), before Reddit's scripts.
//
// Reddit's scripts keep running under the rebuilt page, and for logged-out visitors they
// ask for Google's "Sign in to Reddit with Google" prompt (One Tap). In Chrome that goes
// through the browser (FedCM: navigator.credentials.get({ identity })), which shows it as
// its own popup at the top of the window — out of reach of rebuild.js, which lives in the
// extension's world and can only take the in-page version (Firefox's) off the page. Old
// reddit never prompted, so on a page the add-on is rebuilding (its hiding style,
// #orr-rebuild-guard, goes in at the very start: Google's script can ask before the new page
// is in) or has rebuilt (html.orr-rebuilt) the request is refused, the way it is when the
// prompt is turned off in the browser's settings. Anywhere else — Reddit's own login page, a
// page the add-on left alone or gave back to Reddit — it goes through untouched.
(() => {
  const creds = typeof navigator !== "undefined" ? navigator.credentials : null;
  if (!creds || typeof creds.get !== "function") return;
  const get = creds.get;
  creds.get = function (options) {
    const root = document.documentElement;
    const ours = !!root && (root.classList.contains("orr-rebuilt") || !!document.getElementById("orr-rebuild-guard"));
    if (options && options.identity && ours) {
      return Promise.reject(new DOMException("Classic Layout for Reddit: no sign-in prompt on the rebuilt page", "NotAllowedError"));
    }
    return get.apply(this, arguments);
  };
})();
