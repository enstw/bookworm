// Delete a published book from the worker: chapters, manifest, cached TTS
// audio, the shelf index rows and every reader's position. The server does
// the work a page at a time (R2 takes 1000 keys per delete call and a book
// with a big audio cache is thousands of objects), so this script just drives
// the same paged endpoint the /admin page drives.
//
// Takes the book's URL slug — including a former one, since those still
// resolve — and looks up the id it is stored under.
//
// Usage: node scripts/delete-book.mjs <slug> --url <worker-url> --token <ADMIN_TOKEN> [--yes]

import { parseArgs } from "node:util";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    yes: { type: "boolean", default: false },
  },
});
const slug = positionals[0];
if (!slug || !opts.url || !opts.token) {
  console.error("usage: node scripts/delete-book.mjs <slug> --url <worker-url> --token <ADMIN_TOKEN> [--yes]");
  process.exit(1);
}
const base = opts.url.replace(/\/+$/, "");
const auth = { authorization: `Bearer ${opts.token}` };

const bres = await fetch(`${base}/api/books/${encodeURIComponent(slug)}`);
if (!bres.ok) {
  console.error(`error: no book at "${slug}" (HTTP ${bres.status}) — nothing to delete`);
  console.error(`hint: if the shelf index is stale, rebuild it from /admin first`);
  process.exit(1);
}
const book = (await bres.json()).book;
console.log(`《${book.title}》 (${book.slug}, id ${book.id}) — ${book.chapters} chapters`);
if (!opts.yes) {
  console.error("refusing to delete without --yes");
  process.exit(1);
}

// ?sweep=1 on every round after the first says "keep going": without it, a
// call that finds nothing left is a 404, which is what a typo deserves
let removed = 0, positions = 0;
for (let round = 0; ; round++) {
  if (round > 5000) throw new Error("no progress — aborted");
  const url = `${base}/api/admin/books/${encodeURIComponent(book.id)}${round ? "?sweep=1" : ""}`;
  const res = await fetch(url, { method: "DELETE", headers: auth });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${data.error ?? ""}`);
  removed += data.removed ?? 0;
  if (data.done) { positions = data.positions ?? 0; break; }
  if (round % 5 === 0) console.log(`  ${removed} objects removed…`);
}
console.log(`✓ deleted 《${book.title}》: ${removed} objects, ${positions} bookmarks`);
