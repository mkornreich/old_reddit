// Drive an already-running Firefox (started with --start-debugger-server=<port>) over the
// Remote Debugging Protocol only: install the extension as a temporary add-on, open a URL
// in the selected tab, scroll it step by step and log what changes, with screenshots and
// the page's errors. For a window you're logged in to (e.g. firefox-loggedin.mjs's), where
// Playwright can't see the login (private browsing).
//   node rdp-scroll.mjs <port> <ext-dir|-> <out-dir> <url> [steps]
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const [port, extDir, outDir, url, stepsArg] = process.argv.slice(2);
const STEPS = parseInt(stepsArg || "20", 10);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sock = net.connect(+port, "127.0.0.1");
let buf = Buffer.alloc(0); // lengths are in bytes
const waiters = []; // { pred, resolve }
const events = [];
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const c = buf.indexOf(58); if (c < 0) return; // ":"
    const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
    const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else events.push(msg);
  }
});
const wait = (pred, ms = 30000) => new Promise((resolve, reject) => {
  const j = events.findIndex(pred);
  if (j >= 0) return resolve(events.splice(j, 1)[0]);
  const w = { pred, resolve };
  waiters.push(w);
  setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); reject(new Error("timeout")); } }, ms);
});
const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
const req = (to, type, extra = {}) => { send({ to, type, ...extra }); return wait((m) => m.from === to && (!m.type || m.error)); };

await wait((m) => m.from === "root" && m.applicationType);
const root = await req("root", "getRoot");
if (extDir !== "-") {
  const r = await req(root.addonsActor, "installTemporaryAddon", { addonPath: path.resolve(extDir) });
  console.log("installed", r.addon ? r.addon.id : JSON.stringify(r));
}
const target = async () => {
  const { tabs } = await req("root", "listTabs");
  const t = tabs.find((x) => x.selected) || tabs[tabs.length - 1];
  return (await req(t.actor, "getTarget")).frame;
};
let frame = await target();
await req(frame.actor, "navigateTo", { url });
await sleep(9000);
frame = await target();
const evaluate = async (text) => {
  send({ to: frame.consoleActor, type: "evaluateJSAsync", text, mapped: { await: true } });
  const ack = await wait((m) => m.from === frame.consoleActor && m.resultID);
  const r = await wait((m) => m.type === "evaluationResult" && m.resultID === ack.resultID);
  if (r.exception) throw new Error(r.exceptionMessage);
  return typeof r.result === "string" ? JSON.parse(r.result) : r.result;
};
const shot = async (name) => {
  if (!root.screenshotActor) return;
  try {
    const r = await req(root.screenshotActor, "capture", { args: { browsingContextID: frame.browsingContextID, fullpage: false, snapshotScale: 1 } });
    const data = (r.value && r.value.data) || "";
    if (data) fs.writeFileSync(path.join(outDir, name), Buffer.from(data.replace(/^data:image\/png;base64,/, ""), "base64"));
  } catch (e) { console.log("screenshot failed", e.message); }
};
const SNAP = `JSON.stringify({
  url: location.pathname.slice(0, 60), rebuilt: !!document.querySelector("#siteTable, .commentarea"),
  user: (document.querySelector("#header-bottom-right .user a") || {}).textContent || "",
  y: Math.round(scrollY), h: document.documentElement.scrollHeight,
  comments: document.querySelectorAll(".commentarea .thing.comment").length,
  stubs: document.querySelectorAll(".commentarea .morecomments a, a.orr-more").length,
  loading: Array.from(document.querySelectorAll("a.orr-more")).filter((a) => a.dataset.orrLoading).map((a) => a.textContent.slice(0, 40)),
  failedStubs: Array.from(document.querySelectorAll("a.orr-more, .morecomments a")).filter((a) => /failed|rate-limited|error/i.test(a.textContent)).map((a) => a.textContent.slice(0, 60)),
})`;
const rows = [];
let prev = await evaluate(SNAP);
rows.push({ step: 0, ...prev });
await shot("scroll-00.png");
for (let i = 1; i <= STEPS; i++) {
  await evaluate("window.scrollBy(0, 1500); 1");
  await sleep(1800);
  const s = await evaluate(SNAP);
  rows.push({ step: i, ...s, jump: s.y - prev.y < 0 ? "UP " + (s.y - prev.y) : "" });
  prev = s;
  if (i % 4 === 0) await shot(`scroll-${String(i).padStart(2, "0")}.png`);
}
await sleep(3000);
rows.push({ step: "end", ...(await evaluate(SNAP)) });
for (const r of rows) console.log(JSON.stringify(r));
await shot("scroll-end.png");
const res = await evaluate(`JSON.stringify(performance.getEntriesByType("resource").filter((e) => /\\.json|\\/api\\/|\\/svc\\/shreddit\\/(more-comments|comments)/.test(e.name)).map((e) => (e.responseStatus || "?") + " " + e.name.replace(/^https:\\/\\/[^/]+/, "").replace(/\\?.*/, "").slice(0, 90)))`);
const counts = {}; res.forEach((k) => { counts[k] = (counts[k] || 0) + 1; });
console.log("api", JSON.stringify(counts, null, 1));
const cached = await req(frame.consoleActor, "getCachedMessages", { messageTypes: ["PageError", "ConsoleAPI"] }).catch(() => ({ messages: [] }));
const msgs = (cached.messages || []).map((m) => m.pageError ? "pageerror: " + String(m.pageError.errorMessage).slice(0, 200) : m.message ? m.message.level + ": " + JSON.stringify(m.message.arguments).slice(0, 200) : "").filter((x) => x && !/^(log|debug|info)/.test(x));
console.log("errors", JSON.stringify(msgs.slice(0, 25), null, 1));
sock.end();
process.exit(0);
