// Chapter-splitting core shared by scripts/split-book.mjs (CLI) and the
// /admin upload page. Pure functions over strings — no I/O, no Node APIs —
// so the two paths can never drift.

export const DEFAULT_PATTERN =
  "^\\s*(?:第\\s*[0-9〇零一二三四五六七八九十百千万萬两兩]+\\s*[章节節回卷部篇集话話]" +
  "|(?:Chapter|CHAPTER|Ch\\.)\\s*\\d+" +
  "|序章|序言|楔子|引子|前言|後記|后记|尾聲|尾声|終章|终章|番外)";

export const MAX_HEADING_LEN = 80; // a matching line longer than this is prose, not a heading

export function deriveSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿぀-ヿ-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// House convention: a slug is the title's pinyin initials — 《牧神記》→ "msj",
// "jianlai" → "jl" — with a numeric postfix on collision. Short enough to
// type, and it reads back as the book. `taken` is the list of slugs already
// in use (pass slugs of OTHER books only, so republishing keeps its slug).
export function shortSlug(name, taken = []) {
  const s = deriveSlug(name);
  let base = "";
  let latin = "";
  const flushLatin = () => {
    if (!latin) return;
    // a romanized run collapses to its syllable initials, but only when that
    // leaves something recognisable ("jianlai" → "jl"); "cs9" keeps its head
    const p = pinyinInitials(latin);
    base += p.length >= 2 ? p : latin.slice(0, 2);
    latin = "";
  };
  for (const ch of s) {
    if (/[a-z0-9]/.test(ch)) { latin += ch; continue; }
    flushLatin();
    base += hanInitial(ch);
  }
  flushLatin();
  // no pinyin available (see hanInitial) — the old rule, first two characters
  if (!base) base = [...s].slice(0, 2).join("");
  return uniqueSlug(base.slice(0, 16) || "bk", taken);
}

// Append the smallest numeric postfix that clears `taken` — "jl" → "jl2".
export function uniqueSlug(base, taken = []) {
  let cand = base;
  for (let n = 2; taken.includes(cand); n++) cand = base + n;
  return cand;
}

// One hanzi → its pinyin initial, by walking 23 anchor characters backwards
// (there is no pinyin syllable starting with i/u/v). No dictionary
// is shipped: Intl sorts Chinese by pinyin, so the last anchor a character
// still sorts after IS its initial. Polyphones get their primary reading —
// 《水滸傳》comes out "shc", not "shz" — which is why the field stays editable.
const PINYIN_LETTERS = "abcdefghjklmnopqrstwxyz";
const PINYIN_ANCHORS = "阿八嚓咑妸发旮哈击喀垃妈拿哦啪七然仨他挖夕丫匝";

let pinyinCollator; // undefined = not probed yet, null = runtime can't do it
function collator() {
  if (pinyinCollator !== undefined) return pinyinCollator;
  try {
    const c = new Intl.Collator("zh-Hans-u-co-pinyin");
    // probe rather than trust: a runtime without pinyin collation quietly
    // falls back to codepoint order, where 阿 (U+963F) sorts AFTER 北 — every
    // initial would come out "z". Two comparisons tell the two apart.
    pinyinCollator =
      c.compare("阿", "北") < 0 && c.compare("匝", "阿") > 0 ? c : null;
  } catch {
    pinyinCollator = null;
  }
  return pinyinCollator;
}

function hanInitial(ch) {
  const c = collator();
  if (!c || !/[一-鿿]/.test(ch)) return "";
  for (let i = PINYIN_ANCHORS.length - 1; i >= 0; i--)
    if (c.compare(ch, PINYIN_ANCHORS[i]) >= 0) return PINYIN_LETTERS[i];
  return "";
}

// A book id is the name its files are actually stored under: opaque, minted
// once, never changed. The slug in the URL is only a label — re-slugging is a
// row in D1, not a copy of 1,835 chapter files. 8 hex digits with a "b" in
// front: unmistakable in a bucket listing, and inside the slug alphabet so it
// drops into a URL path unescaped.
export function newBookId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return "b" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// "jianlai" → "jl": a consonant starts a syllable when a vowel follows it
// (looking through h-clusters like zh/ch/sh/th), so syllable finals (n/ng/r)
// never count. Pinyin is what it is for; on English it produces something
// stable but not meaningful ("thegreatgatsby" → "trg", since pinyin has no
// gr- onset). Ambiguous n-vs-ng splits resolve toward consonant-initial
// syllables ("sanguo" → s,g), matching how names romanize.
function pinyinInitials(word) {
  const vowels = "aeiouvü";
  let out = "";
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (vowels.includes(c)) continue;
    const cluster = word[i + 1] === "h";
    const next = cluster ? word[i + 2] : word[i + 1];
    if (i === 0 || (next && vowels.includes(next))) {
      out += c;
      if (cluster) i++; // don't count the h of zh/ch/sh again
    }
  }
  return out;
}

export function safeName(t) {
  return t
    .normalize("NFC")
    .replace(/[\s/\\?#%&+=:;*"'<>|.,!、。，！？：；「」『』（）()\[\]【】·…—~`^{}]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// One big text → [{ title, body }] pieces.
// Returns { pieces, headingCount }; headingCount < 3 means heading detection
// failed and the whole text became one piece (caller should warn).
export function splitTextIntoPieces(text, opts = {}) {
  const {
    pattern = DEFAULT_PATTERN,
    maxChars = 150000,
    bookTitle = "book",
  } = opts;

  const re = new RegExp(pattern);
  const marks = [];
  let off = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    // a line with a full stop is a sentence, not a heading (chapter titles may
    // contain ，/、 but never 。)
    if (t && t.length <= MAX_HEADING_LEN && !t.includes("。") && re.test(t))
      marks.push({ off, title: t });
    off += line.length + 1;
  }

  // two heading lines with no body between them are a source artifact (e.g.
  // the chapter number repeated under the real title) — keep the first
  for (let i = marks.length - 1; i > 0; i--) {
    const between = text.slice(marks[i - 1].off, marks[i].off).split("\n").slice(1);
    if (!between.join("").trim()) marks.splice(i, 1);
  }

  let chapters = [];
  if (marks.length >= 3) {
    if (marks[0].off > 0 && text.slice(0, marks[0].off).trim()) {
      chapters.push({ title: "前言", start: 0, end: marks[0].off });
    }
    for (let i = 0; i < marks.length; i++) {
      chapters.push({
        title: marks[i].title,
        start: marks[i].off,
        end: marks[i + 1]?.off ?? text.length,
      });
    }
  } else {
    chapters.push({ title: bookTitle, start: 0, end: text.length });
  }

  // enforce a max chapter size (split oversized ones at a line break)
  const pieces = [];
  for (const ch of chapters) {
    let s = ch.start;
    let part = 1;
    while (ch.end - s > maxChars) {
      let cut = text.lastIndexOf("\n", s + maxChars);
      if (cut <= s) cut = s + maxChars;
      pieces.push({ title: part === 1 ? ch.title : `${ch.title} (${part})`, body: text.slice(s, cut) });
      s = cut;
      part++;
    }
    if (ch.end - s > 0) {
      pieces.push({ title: part === 1 ? ch.title : `${ch.title} (${part})`, body: text.slice(s, ch.end) });
    }
  }
  return { pieces, headingCount: marks.length };
}

// pieces → [{ title, file, body, chars }] with normalized bodies and final
// NNNN_<sanitized-title>.txt filenames; empty pieces are dropped.
export function piecesToEntries(pieces) {
  const enc = new TextEncoder();
  const entries = [];
  for (const piece of pieces) {
    const body = piece.body.replace(/^\n+|\n+$/g, "") + "\n";
    if (!body.trim()) continue;
    const i = entries.length;
    const file = `${String(i).padStart(4, "0")}_${safeName(piece.title) || "chapter"}.txt`;
    // chars is what the reader counts progress in; bytes is what R2 will
    // report back, and the only way a later check can tell "this chapter is
    // there" from "this chapter is there and is the whole chapter"
    entries.push({
      title: piece.title, file, body,
      chars: body.length, bytes: enc.encode(body).length,
    });
  }
  return entries;
}

export function buildManifest({ id, slug, title, entries }) {
  return {
    id,
    slug,
    title,
    charset: "utf-8",
    totalChars: entries.reduce((a, c) => a + c.chars, 0),
    chapters: entries.map(({ title, file, chars, bytes }) => ({ title, file, chars, bytes })),
    generatedAt: new Date().toISOString(),
  };
}
