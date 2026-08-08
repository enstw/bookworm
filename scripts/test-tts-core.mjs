// Unit test for public/tts-core.mjs against a real split book.
// Usage: node scripts/test-tts-core.mjs [out/jianlai]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  chunkChapter,
  chunkIndexFor,
  sentenceStartFor,
  sentenceEndFor,
  ttsPrompt,
  CHARS_PER_SEC,
  CHUNK_CHARS,
  FIRST_CHUNK_CHARS,
  ENDERS,
  CLOSERS,
} from "../public/tts-core.mjs";

let fails = 0;
const fail = (msg) => { fails++; console.error("✗ " + msg); };

// ---- sentenceStartFor: pinned cases (no book needed) ----------------------
// Boundaries fall after an ENDER plus any CLOSERS — identical to the spans
// chunkChapter builds, so each pin states where a mid-sentence index snaps.
const SENT = "甲說。「乙曰！」丙是誰？\n丁來了";
//            0123   4567   8 9……  boundaries after 。(3)、！」(8)、？(12)、\n(13)
for (const [i, want] of [[0, 0], [2, 0], [3, 3], [5, 3], [7, 3], [8, 8], [11, 8], [12, 12], [13, 13], [15, 13], [99, 13]]) {
  const got = sentenceStartFor(SENT, i);
  if (got !== want) fail(`sentenceStartFor(SENT, ${i}) = ${got}, want ${want}`);
}
if (sentenceStartFor("", 0) !== 0) fail("sentenceStartFor on empty text");
if (sentenceStartFor("無標點的一句話", 4) !== 0) fail("sentenceStartFor with no enders");

// sentenceEndFor: same boundaries from the other side — [start, end) is one
// sentence span, so end(i) is the first boundary strictly after i
for (const [i, want] of [[0, 3], [2, 3], [3, 8], [7, 8], [8, 12], [11, 12], [12, 13], [13, 16], [15, 16], [99, 16]]) {
  const got = sentenceEndFor(SENT, i);
  if (got !== want) fail(`sentenceEndFor(SENT, ${i}) = ${got}, want ${want}`);
}
if (sentenceEndFor("", 0) !== 0) fail("sentenceEndFor on empty text");
if (sentenceEndFor("無標點的一句話", 4) !== 7) fail("sentenceEndFor with no enders");
for (const i of [0, 3, 5, 8, 12, 13, 15]) {
  if (sentenceStartFor(SENT, i) >= sentenceEndFor(SENT, i))
    fail(`sentence span empty at ${i}`);
}

const dir = process.argv[2] ?? "out/jianlai";
const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
if (!files.length) {
  console.error(`no .txt chapters in ${dir} — split a book first`);
  process.exit(1);
}

let totalChunks = 0;
let totalChars = 0;
let maxChunk = 0;
for (const f of files) {
  const text = readFileSync(join(dir, f), "utf8");
  const chunks = chunkChapter(text);
  if (!text.trim()) continue;
  if (!chunks.length) { fail(`${f}: no chunks for non-empty chapter`); continue; }

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    totalChunks++;
    totalChars += c.chars;
    maxChunk = Math.max(maxChunk, c.chars);
    if (c.text !== text.slice(c.start, c.start + c.chars))
      fail(`${f}#${i}: text/slice mismatch`);
    if (i > 0 && c.start !== chunks[i - 1].start + chunks[i - 1].chars)
      fail(`${f}#${i}: gap/overlap with previous chunk`);
    // chunk 0 must be exactly the heading line (chapter number + name)
    if (i === 0 && c.text.trim() !== text.trim().split("\n")[0].trim())
      fail(`${f}#0: heading chunk is not the first line: ${JSON.stringify(c.text.slice(0, 40))}`);
    // chunk 1 targets FIRST_CHUNK_CHARS but a single unbreakable opening
    // sentence may legally reach CHUNK_CHARS, so only the hard cap is asserted
    const limit = i === 0 ? 120 : CHUNK_CHARS;
    // raw chunks may exceed the limit only via absorbed whitespace (blank
    // lines) — the cleaned prompt must always fit
    if (ttsPrompt(c.text).length > limit + 8)
      fail(`${f}#${i}: prompt ${ttsPrompt(c.text).length} chars exceeds limit ${limit}`);
    if (!ttsPrompt(c.text)) fail(`${f}#${i}: empty tts prompt`);
  }
  const last = chunks[chunks.length - 1];
  if (last.start + last.chars !== text.length && text.slice(last.start + last.chars).trim())
    fail(`${f}: tail content not covered`);

  // sentenceStartFor: on sampled offsets, the snap lands at 0 or right
  // after an ender(+closers), at or before the offset, with no ender
  // boundary strictly between the snap and the offset
  for (const off of [0, 7, Math.floor(text.length / 2), text.length - 1]) {
    const s = sentenceStartFor(text, off);
    if (s > off) { fail(`${f}: sentence start ${s} past offset ${off}`); continue; }
    if (s > 0 && !ENDERS.includes(text[s - 1]) && !CLOSERS.includes(text[s - 1]))
      fail(`${f}: sentence start ${s} not after an ender/closer`);
    for (let j = s; j < off; j++) {
      if (!ENDERS.includes(text[j])) continue;
      let e = j + 1;
      while (e < text.length && CLOSERS.includes(text[e])) e++;
      if (e <= off) { fail(`${f}: boundary ${e} between snap ${s} and offset ${off}`); break; }
    }
  }

  // offset → chunk round-trip on a few sampled offsets
  for (const off of [0, Math.floor(text.length / 3), text.length - 1]) {
    const k = chunkIndexFor(chunks, off);
    const c = chunks[k];
    const inRange = off >= c.start && (off < c.start + c.chars || k === chunks.length - 1);
    // offsets before the first chunk (leading whitespace) map to chunk 0
    if (!inRange && !(k === 0 && off < c.start))
      fail(`${f}: offset ${off} mapped to chunk ${k} [${c.start}, ${c.start + c.chars})`);
  }
}

console.log(
  `${files.length} chapters → ${totalChunks} chunks, ` +
  `avg ${(totalChars / totalChunks).toFixed(0)} chars/chunk, max ${maxChunk}, ` +
  `est ${(totalChars / totalChunks / CHARS_PER_SEC).toFixed(0)}s audio/chunk`,
);
if (fails) { console.error(`${fails} failures`); process.exit(1); }
console.log("✓ tts-core ok");
