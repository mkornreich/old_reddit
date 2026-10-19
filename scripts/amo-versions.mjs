// The add-on's latest versions on addons.mozilla.org — channel and review status
// ("unreviewed" = in Mozilla's queue, "public" = live) — and which one the store serves.
// Uses the AMO v5 API with the same JWT credentials as `web-ext sign`:
//   (set -a; source ./creds.sh; set +a; node scripts/amo-versions.mjs)
import crypto from "node:crypto";
const b64 = (x) => Buffer.from(x).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const body = b64(JSON.stringify({ iss: process.env.JWT_ISSUER, jti: crypto.randomBytes(8).toString("hex"), iat: now, exp: now + 240 }));
const sig = crypto.createHmac("sha256", process.env.JWT_SECRET).update(head + "." + body).digest("base64url");
const auth = { Authorization: "JWT " + head + "." + body + "." + sig };
const guid = encodeURIComponent("old-reddit-redirect@extension.local");
const r = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${guid}/versions/?filter=all_with_unlisted&page_size=5`, { headers: auth });
const j = await r.json();
for (const v of j.results || []) console.log(v.version, v.channel, v.file && v.file.status, v.file && v.file.created);
const a = await (await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${guid}/`, { headers: auth })).json();
console.log("current public:", a.current_version && a.current_version.version);
