"use strict";

// Content script: applies the old-Reddit skin to new Reddit IN PLACE, but only
// when the user's chosen mode is "skin". Runs at document_start on new-Reddit
// hosts (never on old.reddit.com).
//
// Why it's built this way:
//  - New Reddit ("shreddit") renders through web components. Some content sits
//    inside Shadow DOM, which page-level <style> tags cannot reach. To get in,
//    we inject a copy of the stylesheet into each OPEN shadow root as well as the
//    main document. (Closed shadow roots are unreachable by anything — a hard
//    limit, not a bug.)
//  - Reddit's SPA swaps content in continuously, so a MutationObserver re-injects
//    into newly added components/shadow roots.
//  - Everything is removable: switching away from "skin" mode strips every
//    injected <style>, restoring plain new Reddit with no reload.

(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const CSS = globalThis.ORR_SKIN_CSS || "";
  const MARK = "orr-skin-style";

  let injected = [];
  let observer = null;
  let active = false;

  function makeStyle() {
    const s = document.createElement("style");
    s.className = MARK;
    s.textContent = CSS;
    return s;
  }

  // Inject one <style> into a Document or ShadowRoot if not already present.
  function injectInto(root) {
    if (!root) return;
    let target;
    if (root === document) {
      target = document.head || document.documentElement;
    } else {
      target = root; // ShadowRoot
    }
    if (!target) return;
    let already;
    try {
      already = target.querySelector("style." + MARK);
    } catch (e) {
      already = null;
    }
    if (already) return;
    const s = makeStyle();
    target.appendChild(s);
    injected.push(s);
  }

  // Inject into a root and recurse into every open shadow root beneath it.
  function walk(root) {
    injectInto(root === document ? document : root);
    const scope = root === document ? document : root;
    let els;
    try {
      els = scope.querySelectorAll("*");
    } catch (e) {
      return;
    }
    for (const el of els) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  }

  // --- Compact-feed expando --------------------------------------------
  // A [+]/[–] toggle injected onto each feed post. Clicking it toggles the
  // .orr-expanded class on the <shreddit-post>; the skin CSS reveals that
  // post's hidden media/self-text purely by class (so this code never has to
  // know which media element the post contains). The permalink/detail post is
  // left alone.
  const EXPANDO_BTN = "orr-expando-btn";
  const REVEALABLE = '[slot="post-media-container"],[slot="text-body"]';

  function decoratePost(post) {
    if (!post || !post.dataset) return;
    if (post.dataset.orrExpando) return; // "1" (done) or "skip"
    if (post.getAttribute && post.getAttribute("view-context") === "CommentsPage") {
      post.dataset.orrExpando = "skip";
      return;
    }
    let hasMedia = false;
    try {
      hasMedia = !!post.querySelector(REVEALABLE);
    } catch (e) {
      hasMedia = false;
    }
    if (!hasMedia) {
      post.dataset.orrExpando = "skip"; // link/text rows: nothing to reveal
      return;
    }
    post.dataset.orrExpando = "1";

    const btn = document.createElement("span");
    btn.className = EXPANDO_BTN;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Toggle media");
    const toggle = (e) => {
      e.preventDefault();
      e.stopPropagation();
      post.classList.toggle("orr-expanded");
    };
    btn.addEventListener("click", toggle);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") toggle(e);
    });

    let anchor = null;
    let title = null;
    try {
      anchor = post.querySelector('[slot="credit-bar"]');
    } catch (e) {
      anchor = null;
    }
    if (!anchor) {
      try {
        title = post.querySelector('a[slot="title"], h1[slot="title"]');
      } catch (e) {
        title = null;
      }
    }
    if (anchor) anchor.prepend(btn);
    else if (title && title.parentNode) title.parentNode.insertBefore(btn, title);
    else post.prepend(btn);
  }

  function scanPosts(scope) {
    if (!scope || !scope.querySelectorAll) return;
    let posts;
    try {
      posts = scope.querySelectorAll("shreddit-post");
    } catch (e) {
      return;
    }
    for (const p of posts) decoratePost(p);
  }

  function undecorate() {
    try {
      document.querySelectorAll("." + EXPANDO_BTN).forEach((b) => b.remove());
      document.querySelectorAll("shreddit-post.orr-expanded").forEach((p) => p.classList.remove("orr-expanded"));
      document.querySelectorAll("shreddit-post[data-orr-expando]").forEach((p) => {
        delete p.dataset.orrExpando;
      });
      document.querySelectorAll(".orr-hidden-promo").forEach((el) => el.classList.remove("orr-hidden-promo"));
    } catch (e) {
      /* ignore */
    }
  }

  // --- Hide the logged-out "Join the most real place on the internet" signup
  // promo. Identified by its user-facing TEXT (survives class churn), then the
  // whole card is hidden via the .orr-hidden-promo class — which the skin
  // stylesheet turns into display:none, so teardown is automatic when the skin
  // is switched off. Debounced so a busy feed doesn't trigger repeated scans.
  const PROMO_RE = /Join the most real place on the internet/i;
  let promoTimer = null;

  function promoCard(el) {
    // Only ever hide the promo's <faceplate-tracker> wrapper. If we can't find
    // one within a few levels, hide NOTHING — never fall back to hiding an
    // arbitrary container (that risks blanking the whole page, since the promo
    // sits inside the page's grid/left-rail landmarks).
    let node = el.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const tag = (node.tagName || "").toLowerCase();
      if (tag === "faceplate-tracker") return node;
      if (/^(body|main|shreddit-app|shreddit-feed|html)$/.test(tag)) break;
      node = node.parentElement;
    }
    return null;
  }

  function hidePromos(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    let candidates;
    try {
      candidates = root.querySelectorAll("h1,h2,h3,h4,p,span,div,faceplate-tracker,[role='heading']");
    } catch (e) {
      return;
    }
    for (const el of candidates) {
      let txt;
      try {
        txt = (el.textContent || "").trim();
      } catch (e) {
        continue;
      }
      if (txt.length > 160 || !PROMO_RE.test(txt)) continue;
      const card = promoCard(el);
      if (card && card.classList && !card.classList.contains("orr-hidden-promo")) {
        card.classList.add("orr-hidden-promo");
      }
    }
  }

  function schedulePromoScan() {
    if (promoTimer) return;
    promoTimer = setTimeout(() => {
      promoTimer = null;
      hidePromos(document);
    }, 400);
  }

  function enable() {
    if (active) return;
    active = true;
    document.documentElement.classList.add("orr-skin");
    walk(document);
    scanPosts(document);
    hidePromos(document);

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.shadowRoot) walk(n.shadowRoot);
          let els;
          try {
            els = n.querySelectorAll ? n.querySelectorAll("*") : [];
          } catch (e) {
            els = [];
          }
          for (const el of els) if (el.shadowRoot) walk(el.shadowRoot);

          // Decorate any posts that just loaded into the feed.
          if (n.matches && n.matches("shreddit-post")) decoratePost(n);
          scanPosts(n);
        }
      }
      schedulePromoScan();
      // Re-assert the document-level style if a head swap dropped it.
      if (!(document.head && document.head.querySelector("style." + MARK))) {
        injectInto(document);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function disable() {
    if (!active) return;
    active = false;
    document.documentElement.classList.remove("orr-skin");
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (promoTimer) {
      clearTimeout(promoTimer);
      promoTimer = null;
    }
    for (const s of injected) {
      try {
        s.remove();
      } catch (e) {
        /* ignore */
      }
    }
    injected = [];
    undecorate();
  }

  async function sync() {
    let enabled = true;
    try {
      enabled = (await globalThis.ORR.getPrefs()).enabled;
    } catch (e) {
      enabled = true; // fail safe: skin on
    }
    if (enabled) enable();
    else disable();
  }

  try {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && (changes.enabled || changes.mode)) sync();
    });
  } catch (e) {
    /* ignore */
  }

  sync();
})();
