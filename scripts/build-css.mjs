// Rewrites relative url(...) asset references in the archived old-reddit
// stylesheet to absolute www.redditstatic.com URLs, so the sprites/icons load
// when the CSS is injected on www.reddit.com (where relative paths would 404).
//
// Input:  vendor/oldreddit.css        (verbatim 2019 archive, 344 KB)
// Output: vendor/oldreddit.bundled.css (the file the extension actually injects)
//
// Run: node scripts/build-css.mjs
import fs from "node:fs";

const SRC = "vendor/oldreddit.css";
const OUT = "vendor/oldreddit.bundled.css";
const BASE = "https://www.redditstatic.com/";

let css = fs.readFileSync(SRC, "utf8");
let rewritten = 0;
const leftovers = [];

css = css.replace(
  /url\(\s*(['"]?)\s*((?:\.\.?\/)*)([^'")]+?)\s*\1\s*\)/g,
  (m, q, _dots, path) => {
    if (/^(https?:|data:|#)/i.test(path)) return m; // already absolute / inline / fragment
    rewritten++;
    return `url(${q}${BASE}${path}${q})`;
  }
);

// sanity: any remaining relative url() that isn't http/data?
for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
  const p = m[1].trim();
  if (!/^(https?:|data:|#)/i.test(p)) leftovers.push(p);
}

fs.writeFileSync(OUT, css);
console.log(`rewrote ${rewritten} relative url() refs -> ${OUT} (${css.length} bytes)`);
console.log(leftovers.length ? `WARNING leftover relative urls: ${leftovers.slice(0, 10).join(", ")}` : "no leftover relative url() refs");
