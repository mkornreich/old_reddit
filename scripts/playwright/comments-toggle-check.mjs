// "Infinite scroll for comments" (issue #35, 2026-11-27): a switch in the popup and Options,
// like the one for posts. Firefox (temporary add-on) or Chromium (CHROMIUM=1), logged out,
// one thread with "load more comments" inside it:
//  - Chromium: the popup has the switch, on by default, and a click turns it off (Firefox
//    can't open moz-extension:// pages, so there the setting is written over the debugging
//    protocol, into storage.sync like the popup does)
//  - off: sitting where the comments begin, then reading down to the end of the thread,
//    nothing loads by itself (no more-comments requests); a click still loads one
//  - switched on with the thread open: the replies below the screen start loading
//  - switched off again: they stop (what was already loading may finish)
// A page that isn't rebuilt (Reddit's CAPTCHA or block page) is reported as not tested.
//   node comments-toggle-check.mjs <ext-dir> <out-dir> [<thread url>]   (exits non-zero on failure)
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { firefox, chromium } from "playwright";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [extDir, outDir, argUrl] = process.argv.slice(2);
const url = argUrl || "https://www.reddit.com/r/AlignmentChartFills/comments/1y0tlcm/finally_who_is_poor_now_and_grew_up_poor/";
fs.mkdirSync(outDir, { recursive: true });
const CHROMIUM = process.env.CHROMIUM === "1";
const PORT = 6000 + Math.floor(Math.random() * 1000);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orr-ctc-"));
const ctx = CHROMIUM ? await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: false, viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${path.resolve(extDir)}`, `--load-extension=${path.resolve(extDir)}`, "--window-position=-3000,0"],
}) : await firefox.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1400, height: 900 },
  args: ["-start-debugger-server", String(PORT)],
  firefoxUserPrefs: {
    "devtools.debugger.remote-enabled": true, "devtools.debugger.prompt-connection": false, "devtools.chrome.enabled": true,
    "xpinstall.signatures.required": false,
    "extensions.background.idle.timeout": 3600000, // keep the add-on's event page up for addonEval
  },
});

// ---- Firefox: install the add-on and write its storage over the Remote Debugging Protocol ----
function rdp(handler, ms = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
    const timer = setTimeout(() => { sock.destroy(); reject(new Error("RDP timeout")); }, ms);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const c = buf.indexOf(58); if (c < 0) return;
        const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
        const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
        let r; try { r = handler(msg, send); } catch (e) { clearTimeout(timer); sock.destroy(); return reject(e); }
        if (r !== undefined) { clearTimeout(timer); sock.end(); return resolve(r); }
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
function rdpInstall(dir) {
  let step = 0;
  return rdp((m, send) => {
    if (step === 0) { step = 1; send({ to: "root", type: "getRoot" }); }
    else if (step === 1 && m.addonsActor) { step = 2; send({ to: m.addonsActor, type: "installTemporaryAddon", addonPath: dir }); }
    else if (step === 2 && m.error) throw new Error(m.error + ": " + m.message);
    else if (step === 2 && m.addon) return m.addon;
  });
}
const ADDON_ID = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8")).browser_specific_settings?.gecko?.id;
function addonEval(js) {
  let step = 0;
  return rdp((m, send) => {
    if (step === 0) { step = 1; send({ to: "root", type: "listAddons" }); }
    else if (step === 1 && m.addons) { step = 2; send({ to: m.addons.find((a) => a.id === ADDON_ID).actor, type: "getWatcher" }); }
    else if (step === 2 && m.actor) { step = 3; send({ to: m.actor, type: "watchTargets", targetType: "frame" }); }
    else if (step === 3 && m.type === "target-available-form" && /^moz-extension:/.test(m.target.url || "")) {
      step = 4; send({ to: m.target.consoleActor, type: "evaluateJSAsync", text: js, mapped: { await: true } });
    } else if (step === 3 && m.from && !m.type) throw new Error("addonEval: the add-on's background page isn't running");
    else if (step === 4 && m.type === "evaluationResult") {
      if (m.hasException || m.topLevelAwaitRejected) throw new Error("addonEval: " + JSON.stringify(m.exceptionMessage || "rejected"));
      return m.result === undefined ? null : m.result;
    } else if (m.error) throw new Error(m.error + ": " + (m.message || ""));
  });
}
for (let i = 0; !CHROMIUM && i < 20; i++) { try { await rdpInstall(path.resolve(extDir)); break; } catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 500)); } }

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? "PASS " : "FAIL ") + msg); };

// ---- the switch: Chromium flips it in the popup itself; Firefox writes storage.sync ----
let popup = null;
if (CHROMIUM) {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
  popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  await popup.waitForTimeout(800);
  const row = await popup.evaluate(() => {
    const el = document.getElementById("infiniteComments");
    return el && { checked: el.checked, title: el.closest("label").querySelector(".orr-row-title").textContent };
  });
  ok(row && row.checked, `the popup has "${row && row.title}", on by default`);
  await popup.locator("label:has(#infiniteComments)").click();
  await popup.waitForTimeout(500);
  const stored = await popup.evaluate(() => chrome.storage.sync.get("infiniteComments"));
  ok(stored.infiniteComments === false, `a click in the popup turns it off (stored ${JSON.stringify(stored)})`);
  await popup.screenshot({ path: path.join(outDir, "popup.png") });
}
const setSwitch = async (on) => {
  if (CHROMIUM) await popup.evaluate((on) => { const el = document.getElementById("infiniteComments"); if (el.checked !== on) el.click(); }, on);
  else await addonEval(`(browser.storage.sync || browser.storage.local).set({ infiniteComments: ${on} }).then(() => "ok")`);
};
if (!CHROMIUM) await setSwitch(false);

const page = await ctx.newPage();
const reqs = []; // every "load more comments" request: [time, url]
page.on("request", (r) => { if (/\/svc\/shreddit\/more-comments\/|\/api\/morechildren/.test(r.url())) reqs.push([Date.now(), r.url()]); });
const STUBS = ".commentarea a.orr-more[data-partial], .commentarea a.orr-more[data-children]";
const state = () => page.evaluate((sel) => ({
  comments: document.querySelectorAll(".commentarea .thing.comment").length,
  stubs: [...document.querySelectorAll(sel)].filter((a) => a.getBoundingClientRect().height > 0).length,
  loading: [...document.querySelectorAll(sel)].filter((a) => a.dataset.orrLoading).length,
  // inside threads, just below the screen, not loaded (with the switch on, none should be)
  ahead: [...document.querySelectorAll(sel)].filter((a) => {
    const r = a.getBoundingClientRect();
    return a.closest(".child") && !a.dataset.orrLoading && !a.dataset.orrNoAuto && r.height > 0 && r.top >= innerHeight && r.top < innerHeight + 1000;
  }).length,
}), STUBS);
const toCommentsTop = () => page.evaluate(() => { const c = document.querySelector(".commentarea .thing.comment"); window.scrollTo(0, c.getBoundingClientRect().top + scrollY - 40); });

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
const rebuilt = await page.waitForSelector("html.orr-rebuilt .commentarea .thing.comment", { timeout: 40000 }).then(() => true).catch(() => false);
if (!rebuilt) {
  console.log(`NOT TESTED ${url}: not rebuilt (Reddit's CAPTCHA or block page?)`);
} else {
  await page.waitForTimeout(1500);
  // 1) off: sit where the comments begin, then read down to the end
  await toCommentsTop();
  const first = await state();
  await page.waitForTimeout(10000);
  for (let i = 0; i < 30; i++) {
    const atEnd = await page.evaluate(() => { window.scrollBy(0, 350); return scrollY + innerHeight >= document.documentElement.scrollHeight - 2; });
    await page.waitForTimeout(700);
    if (atEnd) break;
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); // (the top-level one at the end)
  await page.waitForTimeout(5000);
  const off = await state();
  console.log(`  off: ${JSON.stringify(first)} → ${JSON.stringify(off)}; requests: ${reqs.length}`);
  ok(first.stubs > 0, `the thread has "load more comments" to test with (${first.stubs})`);
  ok(reqs.length === 0 && off.comments === first.comments && off.loading === 0,
    `switched off, nothing loads by itself, sitting still or reading down to the end (${reqs.length} requests, ${first.comments} → ${off.comments} comments)`);
  await page.screenshot({ path: path.join(outDir, "off.png") });

  // 2) a click still loads one
  const clicked = await page.evaluate((sel) => {
    const a = [...document.querySelectorAll(sel)].find((x) => x.getBoundingClientRect().height > 0);
    if (!a) return false;
    window.scrollBy(0, a.getBoundingClientRect().top - innerHeight / 2);
    a.click();
    return true;
  }, STUBS);
  await page.waitForTimeout(6000);
  const afterClick = await state();
  ok(clicked && reqs.length >= 1 && afterClick.comments > off.comments, `a click still loads one (${reqs.length} request(s), ${off.comments} → ${afterClick.comments} comments)`);

  // 3) switched on with the thread open: the ones below the screen start loading
  const beforeUp = reqs.length;
  await toCommentsTop();
  await page.waitForTimeout(2000);
  const beforeOn = reqs.length;
  ok(beforeOn === beforeUp, `still nothing by itself after scrolling back up (${beforeOn - beforeUp})`);
  await setSwitch(true);
  await page.waitForTimeout(10000);
  const on = await state();
  ok(reqs.length > beforeOn && on.comments > afterClick.comments && on.ahead === 0,
    `switched on, the replies just below the screen load (${reqs.length - beforeOn} requests, ${afterClick.comments} → ${on.comments} comments, ${on.ahead} left there)`);
  const beforeRead = reqs.length;
  for (let i = 0; i < 12; i++) { await page.evaluate(() => window.scrollBy(0, 350)); await page.waitForTimeout(1500); }
  ok(reqs.length > beforeRead, `…and more load ahead while reading down (${reqs.length - beforeRead} requests)`);

  // 4) switched off again: they stop
  await setSwitch(false);
  const offAt = Date.now();
  await page.waitForTimeout(3000);
  for (let i = 0; i < 8; i++) { await page.evaluate(() => window.scrollBy(0, 350)); await page.waitForTimeout(700); }
  await page.waitForTimeout(4000);
  const late = reqs.filter(([t]) => t > offAt + 1000);
  ok(late.length === 0, `switched off again, they stop (${late.length} request(s) after the switch)`);
  await page.screenshot({ path: path.join(outDir, "off-again.png") });
}

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(fails.length ? `${fails.length} FAILED` : "all passed");
process.exit(fails.length ? 1 : 0);
