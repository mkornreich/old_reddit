// Build a thread.json (Reddit's /r/<sub>/comments/<id>/.json shape) for fixture-thread.mjs
// from the public Arctic Shift archive — Reddit's own .json is blocked logged out. The
// archive keeps the API's fields (body, body_html, media_metadata, …), but its scores are
// from when it was archived. Comments are given as top-level comments, in the order listed;
// a comment whose body is just a link gets the body_html Reddit gives it (the archive
// renders its own).
//   node arctic-fixture.mjs <out thread.json> <post id36> <comment id36> [<comment id36> …]
// e.g. node arctic-fixture.mjs /tmp/t.json 1y0tlcm 19swjbnf6m084 19swqesmunwys
import fs from "node:fs";

const [out, postId, ...commentIds] = process.argv.slice(2);
if (!out || !/^[a-z0-9]+$/.test(postId || "") || commentIds.some((c) => !/^[a-z0-9]+$/.test(c))) {
  console.error("usage: node arctic-fixture.mjs <out thread.json> <post id36> <comment id36> …");
  process.exit(2);
}
const API = "https://arctic-shift.photon-reddit.com/api";
async function get(p) {
  const res = await fetch(API + p, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j || !Array.isArray(j.data)) throw new Error(`${p}: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const [post] = await get(`/posts/ids?ids=${postId}&md2html=true`);
if (!post) throw new Error("post not in the archive: " + postId);
const got = commentIds.length ? await get(`/comments/ids?ids=${commentIds.join(",")}&md2html=true`) : [];
const comments = commentIds.map((id) => got.find((c) => c.id === id)).filter(Boolean);
comments.forEach((c) => {
  c.replies = ""; c.likes = null;
  const link = /^\s*(https:\/\/[^\s<>"]+)\s*$/.exec(c.body || "");
  if (link) c.body_html = `<div class="md"><p><a href="${esc(link[1])}">${esc(link[1])}</a></p>\n</div>`;
});
post.likes = null;
const thread = [
  { kind: "Listing", data: { children: [{ kind: "t3", data: post }], after: null } },
  { kind: "Listing", data: { children: comments.map((c) => ({ kind: "t1", data: c })), after: null } },
];
fs.writeFileSync(out, JSON.stringify(thread));
console.log(`${out}: r/${post.subreddit} "${post.title}" + ${comments.length}/${commentIds.length} comments` +
  (comments.length < commentIds.length ? " (missing: " + commentIds.filter((id) => !got.some((c) => c.id === id)).join(", ") + ")" : ""));
