// Unit test for body normalization in public/split-core.mjs: blank-line runs
// (including whitespace-only lines) collapse to one line break. The same rule
// runs at import (piecesToEntries, CLI and /admin alike) and over the store
// (scripts/renormalize-books.mjs), and renormalize skips a chapter only when
// normalizeBody returns it byte-identical — so idempotence is load-bearing.
//
//   node scripts/test-split-core.mjs

import { normalizeBody, piecesToEntries } from "../public/split-core.mjs";

const out = {};

// 第N章 run into its name gets an ideographic space; existing gaps normalise
// to it; a bare number, punctuation or a part marker is left alone
import { spaceHeading, spaceHeadingLine } from "../public/split-core.mjs";
{
  const cases = [
    ["第三章血戰", "第三章　血戰"],
    ["第三章 血戰", "第三章　血戰"],
    ["第三章　血戰", "第三章　血戰"],
    ["第1章串流", "第1章　串流"],
    ["第三章", "第三章"],
    ["第三章：血戰", "第三章：血戰"],
    ["第三章 (2)", "第三章 (2)"],
    ["Chapter 3 The Title", "Chapter 3 The Title"],
    ["序章", "序章"],
  ];
  const bad = cases.filter(([a, b]) => spaceHeading(a) !== b).map(([a]) => `${a} → ${spaceHeading(a)}`);
  const line = spaceHeadingLine("　　第三章血戰\n　　正文。\n");
  out.spaceHeading = !bad.length && line === "　　第三章　血戰\n　　正文。\n"
    ? `ok (${cases.length} cases; body heading line spaced, indent kept)` : `FAIL ${JSON.stringify({ bad, line })}`;
}

out.collapse = normalizeBody("第一段\n\n\n第二段\n\n第三段\n")
  === "第一段\n第二段\n第三段\n"
  ? "ok" : `FAIL ${JSON.stringify(normalizeBody("第一段\n\n\n第二段\n\n第三段\n"))}`;

// a line of spaces (half-width, tabs, 全形) is a blank line, not a paragraph
out.whitespaceLines = normalizeBody("甲\n　　\n \t\n乙")
  === "甲\n乙\n"
  ? "ok" : `FAIL ${JSON.stringify(normalizeBody("甲\n　　\n \t\n乙"))}`;

// 段首 indent is formatting, not padding — it survives; edge blanks go
out.indentAndEdges = normalizeBody("\n\n　　首段。\n\n　　次段。\n\n")
  === "　　首段。\n　　次段。\n"
  ? "ok" : `FAIL ${JSON.stringify(normalizeBody("\n\n　　首段。\n\n　　次段。\n\n"))}`;

// invisible-but-not-whitespace junk: `line.trim()` keeps it, so before
// normalization these rendered as EMPTY paragraphs in the reader
const ZWSP = String.fromCodePoint(0x200b);    // zero-width space
const BRAILLE = String.fromCodePoint(0x2800); // braille blank — a real glyph, zero ink
const FILLER = String.fromCodePoint(0x3164);  // hangul filler
out.ghostLines = normalizeBody(`甲\n${ZWSP}\n${BRAILLE}${BRAILLE}\n${FILLER}\n乙\n`)
  === "甲\n乙\n"
  ? "ok (invisible-only lines dropped)"
  : `FAIL ${JSON.stringify(normalizeBody(`甲\n${ZWSP}\n${BRAILLE}${BRAILLE}\n${FILLER}\n乙\n`))}`;

// zero-widths vanish mid-line too (watermarks); braille blank only counts as
// blank when it is the whole line — inside prose it stays untouched
out.ghostInline = normalizeBody(`甲${ZWSP}乙\n丙${BRAILLE}丁\n`)
  === `甲乙\n丙${BRAILLE}丁\n`
  ? "ok (zero-width stripped inline, inline braille kept)"
  : `FAIL ${JSON.stringify(normalizeBody(`甲${ZWSP}乙\n丙${BRAILLE}丁\n`))}`;

const once = normalizeBody("a\n\n b\n\n\nc");
out.idempotent = normalizeBody(once) === once && normalizeBody("甲\n乙\n") === "甲\n乙\n"
  ? "ok (clean input returns byte-identical)"
  : `FAIL ${JSON.stringify(normalizeBody(once))}`;

// the import path applies it, counts chars off the collapsed body, and still
// drops pieces that were nothing but blank lines
const entries = piecesToEntries([
  { title: "第一章", body: "\n\n甲乙\n\n\n丙丁\n\n" },
  { title: "空", body: "\n　　\n\n" },
]);
out.entries = entries.length === 1
  && entries[0].body === "甲乙\n丙丁\n"
  && entries[0].chars === 6 && entries[0].bytes === 14
  && entries[0].file === "0000_第一章.txt"
  ? "ok (collapsed body, chars/bytes, blank piece dropped)"
  : `FAIL ${JSON.stringify(entries)}`;

console.log(JSON.stringify(out, null, 2));
if (Object.values(out).some((v) => String(v).startsWith("FAIL"))) process.exit(1);
