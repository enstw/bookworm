#!/usr/bin/env node
// Apply the import-time body normalization (normalizeBody in split-core:
// blank-line runs collapse to one line break) to books ALREADY in the store,
// through the worker's admin API — no bucket credentials, no redeploy.
//
// For every book (or just the slugs/ids given): fetch each chapter, collapse,
// PUT back only what changed, then PUT the manifest last with fresh
// chars/bytes/totalChars/generatedAt — the new generatedAt is what busts the
// reader's ?v= chapter caches, and the manifest PUT re-registers the D1 shelf
// row so totals stay honest. A republished manifest is not 新書上架 (the
// worker skips the push), and bookmarks drift forward only by the number of
// blank lines that used to sit before them.
//
//   node scripts/renormalize-books.mjs --url http://localhost:8787 [--token T]
//        [--dry-run] [slug-or-id …]         (token also via BOOKWORM_ADMIN_TOKEN)

import { parseArgs } from "node:util";
import { normalizeBody } from "../public/split-core.mjs";

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    // CI passes this: a public repo's Actions logs are world-readable, and
    // the shelf's titles are nobody's business — slugs give away far less
    "slugs-only": { type: "boolean", default: false },
    concurrency: { type: "string", default: "6" },
    help: { type: "boolean", short: "h" },
  },
});

if (opts.help) {
  console.log("usage: node scripts/renormalize-books.mjs --url <worker-url> [--token T] [--dry-run] [--slugs-only] [slug-or-id …]");
  process.exit(0);
}

const base = (opts.url ?? die("--url required (e.g. http://localhost:8787)")).replace(/\/+$/, "");
const token = opts.token ?? process.env.BOOKWORM_ADMIN_TOKEN ?? die("--token or BOOKWORM_ADMIN_TOKEN required");

async function req(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
    if (res.ok) return res;
    if (res.status === 401) die("unauthorized — check ADMIN_TOKEN");
    if (attempt >= 3) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}

const { books } = await (await req("/api/books")).json();
const wanted = positionals.length
  ? books.filter((b) => positionals.includes(b.slug) || positionals.includes(b.id))
  : books;
if (!wanted.length)
  die(positionals.length ? `no book matches ${positionals.join(", ")}` : "the shelf is empty");

const enc = new TextEncoder();
const label = (b) => (opts["slugs-only"] ? b.slug : `${b.title} (${b.slug})`);
let touched = 0;

for (const b of wanted) {
  const man = await (await req(`/books/${encodeURIComponent(b.id)}/manifest.json`)).json();
  const chapters = man.chapters ?? [];
  let changed = 0;
  let removed = 0;

  const queue = [...chapters];
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(Number(opts.concurrency), queue.length)) }, async () => {
      while (queue.length) {
        const c = queue.shift();
        const old = await (await req(`/books/${encodeURIComponent(b.id)}/${encodeURIComponent(c.file)}`)).text();
        const now = normalizeBody(old);
        if (now === old) continue;
        changed++;
        removed += old.length - now.length;
        c.chars = now.length;
        c.bytes = enc.encode(now).length;
        if (!opts["dry-run"])
          await req(`/api/admin/objects/${encodeURIComponent(b.id)}/${encodeURIComponent(c.file)}`, {
            method: "PUT",
            headers: { "content-type": "text/plain; charset=utf-8" },
            body: now,
          });
      }
    }),
  );

  if (!changed) {
    console.log(`  ${label(b)}: already clean`);
    continue;
  }
  touched++;
  man.totalChars = chapters.reduce((a, c) => a + (c.chars ?? 0), 0);
  man.generatedAt = new Date().toISOString();
  // manifest last: readers must never see new chars totals before the
  // chapters that add up to them
  if (!opts["dry-run"])
    await req(`/api/admin/objects/${encodeURIComponent(b.id)}/manifest.json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(man, null, 2) + "\n",
    });
  console.log(
    `${opts["dry-run"] ? "· would rewrite" : "✓"} ${label(b)}: ` +
    `${changed}/${chapters.length} chapters, −${removed.toLocaleString()} chars`,
  );
}

console.log(
  opts["dry-run"]
    ? `dry run: ${touched}/${wanted.length} book(s) would change`
    : `done: ${touched}/${wanted.length} book(s) rewritten`,
);
