// Unit test for body normalization in public/split-core.mjs: blank-line runs
// (including whitespace-only lines) collapse to one line break. The same rule
// runs at import (piecesToEntries, CLI and /admin alike) and over the store
// (scripts/renormalize-books.mjs), and renormalize skips a chapter only when
// normalizeBody returns it byte-identical — so idempotence is load-bearing.
//
//   node scripts/test-split-core.mjs

import { normalizeBody, piecesToEntries } from "../public/split-core.mjs";

const out = {};

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
