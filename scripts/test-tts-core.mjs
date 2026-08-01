// Unit test for public/tts-core.mjs against a real split book.
// Usage: node scripts/test-tts-core.mjs [out/jianlai]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  chunkChapter,
  chunkIndexFor,
  ttsPrompt,
  CHARS_PER_SEC,
  CHUNK_CHARS,
  FIRST_CHUNK_CHARS,
} from "../public/tts-core.mjs";

const dir = process.argv[2] ?? "out/jianlai";
const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
if (!files.length) {
  console.error(`no .txt chapters in ${dir} — split a book first`);
  process.exit(1);
}

let fails = 0;
const fail = (msg) => { fails++; console.error("✗ " + msg); };

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
