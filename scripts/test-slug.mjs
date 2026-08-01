// The slug rule: a book's URL name is the pinyin initials of its title.
// There is no pinyin table in this repo — Intl sorts Chinese by pinyin and
// shortSlug reads the initials off that ordering — so this test is really
// asking whether the runtime's collation still says what we think it says.
// It runs in node; the same code runs in the browser on /admin.
//
//   node scripts/test-slug.mjs

import { deriveSlug, shortSlug, uniqueSlug, newBookId } from "../public/split-core.mjs";

const out = {};
const fails = [];
const check = (name, got, want) => {
  if (got !== want) fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// the ask, verbatim: 《牧神記》→ msj
const titles = {
  "牧神記": "msj",
  "劍來": "jl",
  "宅豬": "zz",
  "三國演義": "sgyy",
  "紅樓夢": "hlm",
  "西遊記": "xyj",
  "射鵰英雄傳": "sdyxc",
  "鬥破蒼穹": "dpcq",
  "凡人修仙傳": "frxxc",   // 傳 reads chuán here — polyphones take the primary
  "詭秘之主": "gmzz",
  "雪中悍刀行": "xzhdx",
  "慶餘年": "qyn",
  "誅仙": "zx",
  "天龍八部": "tlbb",
  "笑傲江湖": "xajh",
  "鹿鼎記": "ldj",
  // simplified input works the same (the /admin path converts first, but the
  // filename it derives the first guess from may still be simplified)
  "围城": "wc",
  "平凡的世界": "pfdsj",
  "百年孤独": "bngd",
  // romanized titles collapse to syllable initials, as they always have
  "jianlai": "jl",
  "thegreatgatsby": "trg",   // English through a pinyin syllable rule: stable, not meaningful
  // mixed and punctuated
  "哈利波特 3": "hlbt3",
};
for (const [title, want] of Object.entries(titles)) check(title, shortSlug(title), want);
out.initials = fails.length ? "FAIL" : `ok (${Object.keys(titles).length} titles)`;

// a title that yields nothing usable still has to produce a usable slug
check("empty", shortSlug(""), "bk");
check("punctuation only", shortSlug("《》！"), "bk");
out.fallback = fails.some((f) => /empty|punctuation/.test(f)) ? "FAIL" : "ok";

// collisions get the smallest free postfix, and a book keeps its own slug
// (callers pass the OTHER books' slugs, never their own)
check("collision", shortSlug("牧神記", ["msj"]), "msj2");
check("collision run", shortSlug("牧神記", ["msj", "msj2"]), "msj3");
check("uniqueSlug", uniqueSlug("jl", ["jl", "jl2"]), "jl3");
check("uniqueSlug free", uniqueSlug("jl", ["ab"]), "jl");
out.collisions = fails.some((f) => /collision|uniqueSlug/.test(f)) ? "FAIL" : "ok";

// deriveSlug is the tidy-up for a slug someone typed: it must never widen the
// alphabet a URL path segment and an R2 key prefix can take
check("deriveSlug case", deriveSlug("My Book!"), "my-book");
check("deriveSlug edges", deriveSlug("--a--b--"), "a-b");
check("deriveSlug cjk", deriveSlug("牧神記"), "牧神記");
out.deriveSlug = fails.some((f) => /deriveSlug/.test(f)) ? "FAIL" : "ok";

// ids are opaque, unique, and inside the slug alphabet (they go in URL paths
// and R2 key prefixes without escaping)
const ids = new Set(Array.from({ length: 500 }, newBookId));
const idOk = [...ids].every((id) => /^b[0-9a-f]{8}$/.test(id));
out.bookIds = ids.size === 500 && idOk
  ? "ok (500 distinct, all URL-safe)"
  : `FAIL ${ids.size} distinct, shape ok=${idOk}`;

if (fails.length) out.failures = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
