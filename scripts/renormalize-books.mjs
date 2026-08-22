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
import { normalizeBody, spaceHeading, spaceHeadingLine, GHOST_CHARS } from "../public/split-core.mjs";

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

// Characters that certainly take ink: CJK (BMP + supplementary planes), kana,
// hangul, printable ASCII, CJK/fullwidth punctuation, common symbols/emoji. A
// kept line with NONE of these is suspicious — it will render as an empty (or
// tofu) paragraph the normalization rule doesn't yet understand. Reporting
// such lines by codepoint leaks nothing: by construction they contain no text.
const VISIBLE = new RegExp(
  "[\\u0021-\\u007e\\u2010-\\u2027\\u2030-\\u205e\\u2460-\\u27bf" +
  "\\u3001-\\u303f\\u3040-\\u30ff\\u3105-\\u312f\\u3400-\\u4dbf\\u4e00-\\u9fff" +
  "\\uac00-\\ud7a3\\uf900-\\ufaff\\ufe30-\\ufe4f\\uff01-\\uff60\\uffe0-\\uffe6" +
  "\\u{1f000}-\\u{1faff}\\u{20000}-\\u{2ffff}]", "u");
const lineCodepoints = (line) =>
  [...new Set([...line.trim()])].slice(0, 6)
    .map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");

for (const b of wanted) {
  const man = await (await req(`/books/${encodeURIComponent(b.id)}/manifest.json`)).json();
  const chapters = man.chapters ?? [];
  let changed = 0;
  let removed = 0;
  // what got cut, by codepoint, plus which chapters (1-based) — numbers are
  // safe in a public log where titles are not, and they answer "was it ch N?"
  const ghosts = new Map();
  const changedAt = [];
  const suspicious = [];

  const queue = chapters.map((c, i) => [c, i]);
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(Number(opts.concurrency), queue.length)) }, async () => {
      while (queue.length) {
        const [c, ci] = queue.shift();
        const old = await (await req(`/books/${encodeURIComponent(b.id)}/${encodeURIComponent(c.file)}`)).text();
        // the heading rule too (spaceHeading): the title in the manifest and
        // the heading line in the body move together, or the reader shows
        // the heading twice
        const now = spaceHeadingLine(normalizeBody(old));
        const title = spaceHeading(c.title ?? "");
        const titleChanged = title !== c.title;
        if (titleChanged) c.title = title;
        now.split("\n").forEach((line, li) => {
          if (line.trim() && !VISIBLE.test(line) && suspicious.length < 20)
            suspicious.push(`ch ${ci + 1} line ${li + 1} (${line.length} chars): ${lineCodepoints(line)}`);
        });
        if (now === old) { if (titleChanged) { changed++; changedAt.push(ci + 1); } continue; }
        changed++;
        removed += old.length - now.length;
        changedAt.push(ci + 1);
        for (const m of old.match(GHOST_CHARS) ?? []) {
          const cp = "U+" + m.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
          ghosts.set(cp, (ghosts.get(cp) ?? 0) + 1);
        }
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

  // lines the rule KEEPS that hold no certainly-visible character — the
  // rendered-as-empty candidates the rule doesn't cover yet
  for (const s of suspicious) console.log(`    ? ${s}`);
  if (suspicious.length === 20) console.log("    ? …more suppressed");

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
  const where = changedAt.length <= 12
    ? ` (ch ${changedAt.sort((x, y) => x - y).join(", ")})`
    : "";
  const cut = ghosts.size
    ? `; ghosts: ${[...ghosts].map(([cp, n]) => `${cp}×${n}`).join(" ")}`
    : "";
  console.log(
    `${opts["dry-run"] ? "· would rewrite" : "✓"} ${label(b)}: ` +
    // `removed` goes negative when a rule ADDS characters (spaceHeading);
    // print the sign the reader expects rather than "−-1,191"
    `${changed}/${chapters.length} chapters${where}, ${removed < 0 ? "+" : "−"}${Math.abs(removed).toLocaleString()} chars${cut}`,
  );
}

console.log(
  opts["dry-run"]
    ? `dry run: ${touched}/${wanted.length} book(s) would change`
    : `done: ${touched}/${wanted.length} book(s) rewritten`,
);
