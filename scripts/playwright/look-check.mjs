// Does the rebuilt page look like old reddit? (the 2026-11-12 store review: "thumbnails make
// link lists all wobbly", "the font is off") Firefox (temporary add-on), logged out:
//  - a listing: every row's thumbnail and title start at the same x (old reddit sizes the
//    rank / vote columns per page), scores read like old reddit's (23.8k, 439k), thumbnails
//    70px wide in their own proportions (not squashed to 70×70), the expand button under the
//    title, the logo + page name + tabs on one header line ("multi" for r/a+b), the top bar's
//    " - " / " | " separators, no blank gaps in taglines (hidden filter/tag icons take no
//    room), old reddit's flair colors, no "?" button, save / hide / report shown logged out;
//  - a subreddit with its own old-reddit theme (r/technology): its stylesheet and header
//    image, its OLD sidebar (submit button, sidebar text, "a community for…"), flair before
//    the title where the sub puts it; r/AskHistorians: its "thumbnails off" setting; r/ucla
//    (buttons drawn as boxes): a post's buttons on one line, no stray reddit logo;
//  - leaving the subreddit (in-page) drops its look; reloading it shows the look at once.
//   node look-check.mjs <ext-dir> <out-dir>   (CHROMIUM=1: Chromium build)   Exits non-zero on failure.
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ff-"));
// CHROMIUM=1: Playwright's Chromium with the unpacked Chromium build (stage-ext.mjs without --firefox)
const CHROMIUM = process.env.CHROMIUM === "1";
const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
}) : await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: { "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true, "xpinstall.signatures.required": false },
});
function rdpInstall(dir) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = "", step = 0;
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const c = buf.indexOf(":"); if (c < 0) return;
        const len = parseInt(buf.slice(0, c), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.slice(c + 1, c + 1 + len)); buf = buf.slice(c + 1 + len);
        if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
        else if (step === 1 && msg.addonsActor) { step = 2; send({ to: msg.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
        else if (step === 2 && (msg.addon || msg.error)) { sock.end(); msg.error ? reject(new Error(msg.error + ": " + msg.message)) : resolve(msg.addon); }
      }
    });
    sock.on("error", reject);
  });
}
for (let i = 0; extDir !== "-" && !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? "PASS " : "FAIL ") + msg); };
const page = await ctx.newPage();
const open = async (url) => {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3500);
};

// 1) a combined listing
await open("https://www.reddit.com/r/pics+technology/");
const L = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll("#siteTable > .thing.link")).filter((t) => t.offsetParent);
  const x = (el) => el ? Math.round(el.getBoundingClientRect().left * 10) / 10 : null;
  const imgs = rows.map((t) => t.querySelector(":scope > .thumbnail img")).filter((i) => i && i.complete && i.naturalWidth);
  const hbl = document.getElementById("header-bottom-left");
  const qa = document.querySelector("#siteTable a.orr-qa");
  const flair = document.querySelector("#siteTable .linkflairlabel:not([style])");
  return {
    n: rows.length,
    thumbX: [...new Set(rows.map((t) => x(t.querySelector(":scope > .thumbnail"))).filter((v) => v != null))],
    entryX: [...new Set(rows.map((t) => x(t.querySelector(":scope > .entry"))))],
    scores: rows.map((t) => (t.querySelector(":scope > .midcol .score") || {}).textContent),
    rawScores: rows.map((t) => +t.getAttribute("data-score")),
    squashed: imgs.filter((i) => Math.abs(i.height - Math.floor(70 * i.naturalHeight / i.naturalWidth)) > 1 || i.width !== 70).map((i) => `${i.width}x${i.height} of ${i.naturalWidth}x${i.naturalHeight}`),
    btnInTopMatter: rows.filter((t) => t.querySelector(".expando-button")).every((t) => !!t.querySelector(".top-matter > p.title + .expando-button")),
    btnCount: rows.filter((t) => t.querySelector(".expando-button")).length,
    logoInHeaderLine: !!(hbl && hbl.querySelector("#header-img")) && Math.abs(hbl.querySelector("#header-img").getBoundingClientRect().bottom - hbl.querySelector(".tabmenu").getBoundingClientRect().bottom) < 8,
    pagename: (document.querySelector("#header .pagename") || {}).textContent,
    srbar: (document.querySelector("#sr-header-area .sr-list") || {}).textContent,
    qaShown: qa ? getComputedStyle(qa).display : "none",
    flairBg: flair ? getComputedStyle(flair).backgroundColor : null,
    helpBtn: !!document.getElementById("orr-help-btn"),
    saveShown: (() => { const s = document.querySelector("#siteTable .thing.link .orr-save"); return !!s && s.offsetParent !== null; })(),
    loggedIn: document.documentElement.classList.contains("orr-logged-in"),
    themed: !!document.getElementById("orr-sub-css"),
  };
});
console.log(JSON.stringify(L));
ok(L.n >= 20, `listing rebuilt (${L.n} rows)`);
ok(L.thumbX.length === 1, `every thumbnail at one x: ${JSON.stringify(L.thumbX)}`);
ok(L.entryX.length <= 2, `titles start at one x (two with thumbnail-less rows): ${JSON.stringify(L.entryX)}`);
ok(L.scores.every((sc, i) => sc === "•" || (L.rawScores[i] >= 100000 ? /^\d+k$/.test(sc) : L.rawScores[i] >= 10000 ? /^\d+\.\dk$/.test(sc) : /^-?\d{1,4}$/.test(sc))), `scores read like old reddit's: ${L.scores.slice(0, 6).join(" ")}`);
ok(L.squashed.length === 0, `thumbnails in their own proportions: ${JSON.stringify(L.squashed.slice(0, 3))}`);
ok(L.btnCount > 0 && L.btnInTopMatter, `expand buttons under the title (${L.btnCount})`);
ok(L.logoInHeaderLine && L.pagename === "multi", `logo, page name, tabs on one line, page name "${L.pagename}"`);
ok(/popular\s*-\s*all\s*-\s*users\s*\|\s*AskReddit\s*-\s*funny/i.test(L.srbar || ""), `top bar separators: ${(L.srbar || "").slice(0, 60)}`);
ok(L.qaShown === "none", `filter/tag icons take no room until pointed at (${L.qaShown})`);
ok(!L.flairBg || L.flairBg === "rgb(245, 245, 245)", `old reddit's flair color (${L.flairBg})`);
ok(!L.helpBtn, `no always-on "?" button`);
ok(L.loggedIn || L.saveShown, "save / hide / report shown logged out");
ok(!L.themed, "no subreddit theme on a combined listing");
await page.screenshot({ path: path.join(outDir, "multi.png") });

// 2) a subreddit with its own theme
await open("https://www.reddit.com/r/technology/");
await page.waitForTimeout(2500); // (its look and old sidebar arrive with one more fetch)
const T = await page.evaluate(() => {
  const st = document.getElementById("orr-sub-css");
  const img = document.querySelector("#header-img-a img#header-img");
  const lab = document.querySelector("#siteTable .thing.link p.title > .orr-linkflair");
  return {
    css: st ? st.textContent.length : 0, last: !!st && document.head.lastElementChild === st,
    substyle: document.documentElement.classList.contains("orr-substyle"),
    header: img ? `${img.complete && img.naturalWidth > 0} ${img.src.slice(0, 60)}` : null,
    defaultHidden: !document.querySelector("#header-bottom-left a.default-header:not([hidden])"),
    side: (document.querySelector(".side") || {}).innerText ? document.querySelector(".side").innerText.replace(/\s+/g, " ") : "",
    titlebox: !!document.querySelector(".side .titlebox .usertext-body .md"),
    age: ((document.querySelector(".side .titlebox .bottom") || {}).textContent || ""), // (its stylesheet may hide it, as on old reddit)
    weekly: /weekly visitors/i.test((document.querySelector(".side") || {}).innerText || ""),
    pagename: (document.querySelector("#header .pagename") || {}).textContent,
    flairFirst: lab ? lab.nextElementSibling && lab.nextElementSibling.matches("a.title") : null,
    bodyFont: getComputedStyle(document.querySelector("#siteTable a.title")).fontFamily,
  };
});
console.log(JSON.stringify(Object.assign({}, T, { side: T.side.slice(0, 140) })));
ok(T.css > 1000 && T.last && T.substyle, `r/technology's own stylesheet applied, last (${T.css} chars)`);
ok(!!T.header && T.header.startsWith("true") && T.defaultHidden, `its header image (${T.header})`);
ok(T.titlebox && /submit a new link/i.test(T.side) && /a community for/i.test(T.age) && !T.weekly, "its old sidebar (submit, sidebar text, age), not new Reddit's widgets");
ok(T.flairFirst !== false, "flair before the title, as r/technology puts it");
ok(/^Verdana/i.test(T.bodyFont), `its font (${T.bodyFont})`);
await page.screenshot({ path: path.join(outDir, "technology.png") });

// 3) reload: the look is there at once (kept in storage), not after a fetch
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#siteTable .thing.link", { timeout: 30000 }).catch(() => {});
const early = await page.evaluate(() => !!document.getElementById("orr-sub-css") && document.documentElement.classList.contains("orr-substyle"));
ok(early, "after a reload the look is on as soon as the listing is");

// 4) leave in-page (the top bar's "popular"): the look goes
await page.click("#sr-header-area a[href='/r/popular/']");
await page.waitForTimeout(3500);
const P = await page.evaluate(() => ({ href: location.pathname, css: !!document.getElementById("orr-sub-css"), substyle: document.documentElement.classList.contains("orr-substyle"), custom: !!document.getElementById("header-img-a"), logo: !!document.querySelector("#header-bottom-left a#header-img.default-header:not([hidden])") }));
console.log(JSON.stringify(P));
ok(P.href.startsWith("/r/popular") && !P.css && !P.substyle && !P.custom && P.logo, "r/popular: the subreddit's look is gone, reddit's logo back");

// 5) a subreddit with thumbnails turned off
await open("https://www.reddit.com/r/AskHistorians/");
await page.waitForTimeout(2500);
const A = await page.evaluate(() => ({ off: document.documentElement.classList.contains("orr-nothumbs"), shown: Array.from(document.querySelectorAll("#siteTable .thing.link > .thumbnail")).filter((t) => t.offsetParent).length }));
ok(A.off && A.shown === 0, `r/AskHistorians: no thumbnails, its setting (${JSON.stringify(A)})`);
await page.screenshot({ path: path.join(outDir, "askhistorians.png") });

// 6) a theme that draws the post buttons as boxes (r/ucla): all on one line — save / hide /
// report shown logged out used to be forced inline and stacked one per line — and the plain
// reddit logo stays hidden behind the subreddit's header image (its style shows header links)
await open("https://www.reddit.com/r/ucla/");
await page.waitForTimeout(2500);
const U = await page.evaluate(() => {
  const t = document.querySelector("#siteTable .thing.link");
  const tops = t ? Array.from(t.querySelectorAll(".flat-list.buttons > li")).filter((li) => li.offsetParent).map((li) => Math.round(li.getBoundingClientRect().top)) : [];
  const def = document.querySelector("#header-bottom-left a.default-header");
  return { themed: !!document.getElementById("orr-sub-css"), tops, logo: def ? getComputedStyle(def).display : "gone", custom: !!document.getElementById("header-img-a") };
});
ok(U.themed && U.tops.length >= 4 && new Set(U.tops).size === 1, `r/ucla: the post's buttons on one line (${JSON.stringify(U.tops)})`);
ok(!U.custom || U.logo === "none" || U.logo === "gone", `r/ucla: no stray reddit logo beside its header image (${U.logo})`);
await page.screenshot({ path: path.join(outDir, "ucla.png") });

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? "FAIL\n  " + fails.join("\n  ") : "PASS");
process.exit(fails.length ? 1 : 0);
