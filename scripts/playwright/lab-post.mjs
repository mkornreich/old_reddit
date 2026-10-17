// Offline: run a saved thread page's <shreddit-post> through the extension's parser +
// postExpando and print what the post would show.   node lab-post.mjs <repo> <saved.html>
import "./hidden-display.mjs"; // keep browser windows off the desktop (Wayland)
import { chromium } from "playwright"; import fs from "node:fs"; import path from "node:path";
const [repo, file] = process.argv.slice(2);
const b = await chromium.launch({ channel: "chromium" }); const p = await b.newPage();
await p.route("https://www.reddit.com/lab", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<html><head></head><body></body></html>" }));
await p.goto("https://www.reddit.com/lab");
await p.addScriptTag({ content: "globalThis.chrome={runtime:{getURL:(x)=>x,sendMessage:()=>Promise.resolve()},storage:{local:{get:(k,c)=>c&&c({}),set:()=>{}},sync:{get:(k,c)=>c&&c({}),set:()=>{}},onChanged:{addListener:()=>{}}}};" });
for (const f of ["common.js", "rebuild.js"]) await p.addScriptTag({ content: fs.readFileSync(path.join(repo, f), "utf8") });
console.log(JSON.stringify(await p.evaluate((html) => {
  const R = globalThis.ORR_REBUILD; const doc = R.parseHtmlDoc(html);
  const el = doc.querySelector("shreddit-post"); const d = R.postFromShreddit(el); const ex = R.postExpando(d);
  return { type: el.getAttribute("post-type"), is_self: d.is_self, hint: d.post_hint || "", selftext: (d.selftext_html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140),
    expandoType: ex && ex.type, expandoHasImg: !!ex && /<img/.test(ex.html), expandoHasText: !!ex && /usertext-body|class="md"/.test(ex.html) };
}, fs.readFileSync(file, "utf8")), null, 1));
await b.close();
