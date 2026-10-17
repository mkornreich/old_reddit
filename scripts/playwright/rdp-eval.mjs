// Evaluate JS in a running Firefox's tab over the Remote Debugging Protocol.
//   node rdp-eval.mjs <port> [<js>] [<out-file>]   (no js: list tabs; out-file: write the
//   string result there instead of printing it — for big results)
import net from "node:net";
const [port, js, outFile] = process.argv.slice(2);
import fs from "node:fs";
const sock = net.connect(+port, "127.0.0.1");
let buf = Buffer.alloc(0), step = 0, consoleActor = null;
const send = (o) => { const s = JSON.stringify(o); sock.write(Buffer.byteLength(s) + ":" + s); };
const done = (x) => {
  if (outFile && typeof x === "string") { fs.writeFileSync(outFile, x); console.log("wrote " + x.length + " chars to " + outFile); }
  else console.log(typeof x === "string" ? x : JSON.stringify(x, null, 1));
  sock.end(); process.exit(0);
};
let longStr = null; // { actor, length, parts }
setTimeout(() => done("timeout"), 20000);
sock.on("data", (d) => {
  buf = Buffer.concat([buf, d]); // lengths are in bytes
  for (;;) {
    const c = buf.indexOf(58); if (c < 0) return;
    const len = parseInt(buf.subarray(0, c).toString(), 10); if (buf.length < c + 1 + len) return;
    const msg = JSON.parse(buf.subarray(c + 1, c + 1 + len).toString("utf8")); buf = buf.subarray(c + 1 + len);
    if (step === 0) { step = 1; send({ to: "root", type: "listTabs" }); }
    else if (step === 1 && msg.tabs) {
      if (!js) return done(msg.tabs.map((t) => ({ url: t.url, title: t.title, selected: t.selected })));
      const t = msg.tabs.find((t) => t.selected) || msg.tabs[0];
      step = 2; send({ to: t.actor, type: "getTarget" });
    } else if (step === 2 && msg.frame) { consoleActor = msg.frame.consoleActor; step = 3; send({ to: consoleActor, type: "evaluateJSAsync", text: js, mapped: { await: true } }); }
    else if (step === 3 && msg.type === "evaluationResult") {
      if (msg.exception) return done({ exception: msg.exceptionMessage });
      const r = msg.result;
      if (r && r.type === "longString") { longStr = { actor: r.actor, length: r.length, got: "" }; step = 4; send({ to: r.actor, type: "substring", start: 0, end: Math.min(r.length, 500000) }); }
      else done(r);
    } else if (step === 4 && msg.from === longStr.actor && typeof msg.substring === "string") {
      longStr.got += msg.substring;
      if (longStr.got.length >= longStr.length) done(longStr.got);
      else send({ to: longStr.actor, type: "substring", start: longStr.got.length, end: Math.min(longStr.length, longStr.got.length + 500000) });
    }
  }
});
sock.on("error", (e) => done("error " + e.message));
