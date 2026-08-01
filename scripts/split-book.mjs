#!/usr/bin/env node
// Prepare a book for publishing: per-chapter UTF-8 files + a manifest.
//
// Input can be either:
//   • one big .txt        — chapters are detected by heading regex
//   • a directory of      — files are taken as chapters, ordered by their
//     NN_<title>.txt files  numeric prefix (e.g. a pre-split book unzipped
//                           into its own folder)
//
//   node scripts/split-book.mjs path/to/book.txt  --title "書名" [--slug my-book]
//   node scripts/split-book.mjs path/to/chapters/ --title "書名" --slug my-book
//                               [--charset gbk] [--pattern '^第.+章'] [--out out]
//                               [--s2t]
//
// --s2t converts Simplified → Traditional (Taiwan standard, OpenCC cn→tw)
// before splitting, so chapter headings, filenames, and the manifest all come
// out Traditional too.
//
// Output: <out>/<slug>/manifest.json + NNNN_<sanitized-chapter-title>.txt
// Chapter files are always UTF-8, regardless of input charset.
//
// The split logic itself lives in public/split-core.mjs, shared with the
// /admin upload page.

import {
  readFileSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  deriveSlug, shortSlug, newBookId,
  splitTextIntoPieces, piecesToEntries, buildManifest,
} from "../public/split-core.mjs";

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string" },
    slug: { type: "string" },
    charset: { type: "string", default: "utf-8" },
    out: { type: "string", default: "out" },
    pattern: { type: "string" },
    s2t: { type: "boolean", default: false },
    "max-chars": { type: "string", default: "150000" },
    help: { type: "boolean", short: "h" },
  },
});

if (opts.help || positionals.length !== 1) {
  console.log(
    `usage: node scripts/split-book.mjs <book.txt | chapters-dir> [--title T] [--slug S] ` +
    `[--charset utf-8|gbk|big5|...] [--pattern REGEX] [--s2t] [--max-chars N] [--out DIR]`,
  );
  process.exit(opts.help ? 0 : 1);
}

const srcPath = positionals[0].replace(/\/+$/, "");
const isDir = statSync(srcPath).isDirectory();
const baseName = basename(srcPath).replace(/\.[^.]*$/, "");
let title = opts.title ?? baseName;
// explicit --slug is used as-is; otherwise the house rule, the title's pinyin
// initials (no server to dedup against here — /admin's upload path does that)
const slug = opts.slug ? deriveSlug(opts.slug) : shortSlug(baseName);
if (!slug) die("could not derive a slug; pass --slug");

let decoder;
try {
  decoder = new TextDecoder(opts.charset, { fatal: false });
} catch {
  die(`unsupported charset "${opts.charset}" (try utf-8, gbk, gb18030, big5, shift_jis)`);
}

let toTrad = (s) => s;
if (opts.s2t) {
  const OpenCC = await import("opencc-js").catch(() =>
    die("--s2t needs opencc-js: pnpm add -D opencc-js"),
  );
  const convert = OpenCC.Converter({ from: "cn", to: "tw" });
  // convert line-by-line: keeps peak memory flat on 30MB+ books and never
  // hands OpenCC a phrase spanning a line break
  toTrad = (s) => s.split("\n").map(convert).join("\n");
}

const decode = (buf) =>
  toTrad(decoder.decode(buf).replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
title = toTrad(title);

// --- collect chapters as { title, body } pieces ---
let pieces;

if (isDir) {
  // Pre-split book: one file per chapter, ordered by numeric prefix.
  const files = readdirSync(srcPath)
    .filter((f) => f.endsWith(".txt"))
    .sort((a, b) => {
      const na = parseInt(a, 10);
      const nb = parseInt(b, 10);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.localeCompare(b);
    });
  if (!files.length) die(`no .txt files in ${srcPath}`);
  pieces = files.map((f) => ({
    title: toTrad(f.replace(/^\d+[_\- ]*/, "").replace(/\.txt$/, "").trim() || f),
    body: decode(readFileSync(join(srcPath, f))),
  }));
} else {
  const text = decode(readFileSync(srcPath));
  const res = splitTextIntoPieces(text, {
    pattern: opts.pattern,
    maxChars: Number(opts["max-chars"]),
    bookTitle: title,
  });
  if (res.headingCount < 3) {
    console.warn(
      `only ${res.headingCount} heading match(es) — falling back to size-based parts ` +
      `(pass --pattern to teach it this book's heading style)`,
    );
  }
  pieces = res.pieces;
}

// --- write chapter files + manifest ---
const outDir = join(opts.out, slug);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entries = piecesToEntries(pieces);
if (!entries.length) die("no non-empty chapters produced");
for (const e of entries) writeFileSync(join(outDir, e.file), e.body, "utf8");

// A fresh id per split: the book's permanent name in the bucket, which is
// what lets its slug change later without moving a file. Re-splitting an
// already-published book and want to replace it in place? Copy the old
// manifest's id into the new one before publishing.
const manifest = buildManifest({ id: newBookId(), slug, title, entries });
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

const kb = (n) => `${Math.round(n / 1024)} KB`;
const sizes = entries.map((e) => e.chars);
console.log(
  `✓ ${title} → ${outDir}\n` +
  `  ${entries.length} chapters, ${manifest.totalChars.toLocaleString()} chars total\n` +
  `  chapter size: min ${kb(Math.min(...sizes))}, max ${kb(Math.max(...sizes))}\n` +
  `  next: node scripts/publish-book.mjs ${outDir} --url <worker-url> --token <ADMIN_TOKEN>`,
);
