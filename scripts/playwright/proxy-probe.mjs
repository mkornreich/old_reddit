// Through each proxy (a real Firefox): does the page load, and do the requests the
// extension makes (the .json, the feed partial) work? Plus the exit IP's country / network.
import "./hidden-display.mjs";
import { firefox } from "playwright";
import fs from "node:fs";
const [listFile, out] = process.argv.slice(2);
const proxies = fs.readFileSync(listFile, "utf8").split("\n").map((l) => l.trim().split(" ")).filter((x) => x[0]);
const browser = await firefox.launch({ headless: false, proxy: { server: "http://per-context" } });
const rows = [];
await Promise.all(proxies.map(async ([server, curlCode]) => {
  const row = { server: server.replace(/:\/\/(\d+\.\d+)\.\d+\.\d+/, "://$1.x.x"), curlCode };
  let ctx;
  try {
    ctx = await browser.newContext({ proxy: { server } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const ip = await page.goto("https://ipinfo.io/json", { timeout: 25000 }).then((r) => r.json()).catch(() => null);
    row.where = ip ? (ip.country || "?") + " " + (ip.org || "").slice(0, 34) : "?";
    const resp = await page.goto("https://www.reddit.com/r/pics/", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(3000);
    row.doc = resp ? resp.status() : 0;
    row.page = await page.evaluate(() => { const t = (document.body && document.body.innerText || "").replace(/\s+/g, " "); return { title: document.title.slice(0, 28), shreddit: !!document.querySelector("shreddit-app"), blocked: /blocked by network security/i.test(t), challenge: /prove your humanity/i.test(t), url: location.pathname + location.search.slice(0, 20) }; });
    row.api = await page.evaluate(async () => {
      const g = async (u, h) => { try { const r = await fetch(u, { credentials: "include", headers: h }); const t = await r.text(); return r.status + (/blocked by network security/i.test(t) ? " BLOCKED" : "") + (/<shreddit-post /.test(t) ? " posts=" + (t.match(/<shreddit-post /g) || []).length : ""); } catch (e) { return "ERR " + String(e).slice(0, 30); } };
      return { json: await g("/r/pics/.json?limit=3", { Accept: "application/json" }), feed: await g("/svc/shreddit/community-more-posts/hot/?name=pics", { Accept: "text/vnd.reddit.partial+html, text/html;q=0.9" }) };
    });
  } catch (e) { row.error = String(e.message || e).split("\n")[0].slice(0, 80); }
  if (ctx) await ctx.close().catch(() => {});
  rows.push(row);
  console.log(JSON.stringify(row));
}));
fs.writeFileSync(out, JSON.stringify(rows, null, 1));
await browser.close();
