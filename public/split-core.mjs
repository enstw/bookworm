// Chapter-splitting core shared by scripts/split-book.mjs (CLI) and the
// /admin upload page. Pure functions over strings — no I/O, no Node APIs —
// so the two paths can never drift.

export const DEFAULT_PATTERN =
  "^\\s*(?:第\\s*[0-9〇零一二三四五六七八九十百千万萬两兩]+\\s*[章节節回卷部篇集话話]" +
  "|(?:Chapter|CHAPTER|Ch\\.)\\s*\\d+" +
  "|序章|序言|楔子|引子|前言|後記|后记|尾聲|尾声|終章|终章|番外)";

export const MAX_HEADING_LEN = 80; // a matching line longer than this is prose, not a heading

// 「第三章血戰」→「第三章　血戰」. A Han chapter number run straight into its
// name gets an ideographic space (U+3000 — a full em in 直排 too, where an
// ASCII space is a sliver); an existing gap of any whitespace is normalised
// to the same one. The reader shows the gap, and ttsPrompt turns it into
// 「，」, so the visible break and the heard pause come from one character
// (the owner's note, 2026-08-22). Only before a name: 「第三章」 alone, or a
// number followed by punctuation or a part marker like 「第三章 (2)」, is
// left as it is.
export const HEADING_NUMBER =
  /^(第\s*[0-9〇零一二三四五六七八九十百千万萬两兩]+\s*[章节節回卷部篇集话話])[\s　]*(?=[\p{L}\p{N}「『《【])/u;
export function spaceHeading(title) {
  return title.replace(HEADING_NUMBER, (m, num) => num + "　");
}
// the same rule on a chapter body's first line, which IS the heading (the
// reader renders it as the <h2> and skips it as a paragraph only while it
// still equals the title — so the two must be spaced together)
export function spaceHeadingLine(body) {
  return body.replace(/^([^\S\n]*)([^\n]*)/u, (m, ws, line) => ws + spaceHeading(line));
}

export function deriveSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿぀-ヿ-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// What a slug may be, in one place, because the answer is deriveSlug's
// alphabet and it belongs beside it. The worker validates every slug and
// book id against this and /admin checks the same rule before it sends —
// written twice, they disagreed: the client had no length limit at all, so
// a 41-character slug passed the form and came back 400 bad slug.
//
// Requiring the first character to be from the alphabet rather than a
// hyphen keeps `_tts/` — the audio cache namespace — unreachable as a book.
export const SLUG_CHAR = "a-z0-9\\u4e00-\\u9fff\\u3040-\\u30ff";
export const SLUG_MAX = 40;
export const SLUG_RE = new RegExp(`^[${SLUG_CHAR}][${SLUG_CHAR}-]{0,${SLUG_MAX - 1}}$`);

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

// URL names the app itself owns. A book slug shadowing one of these loses,
// not wins — the worker matches its own routes first, so /admin still opens
// the console and the BOOK becomes unreachable after any reload (and before
// the service worker learned better, a slow link served the shell for
// /admin and rendered the book instead — the worst of both). Refused at
// every slug write (registerBook, the PATCH edit) and skipped by uniqueSlug
// like any collision. sw.js keeps the document half of this list as OWN_DOCS.
export const RESERVED_SLUGS = [
  "admin", "wasmtest", "speechtest", "vhtest", "pgtest", "scrolltest", "pagedtest",
  "api", "books", "fonts", "icons", "vendor",
];

// Append the smallest numeric postfix that clears `taken` — "jl" → "jl2".
export function uniqueSlug(base, taken = []) {
  let cand = base;
  for (let n = 2; taken.includes(cand) || RESERVED_SLUGS.includes(cand); n++) cand = base + n;
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
      marks.push({ off, title: spaceHeading(t) });
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

  // enforce a max chapter size (split oversized ones at a line break). The
  // first piece of a chapter starts with its heading line: space it like the
  // title was, or the reader would show the heading twice.
  const pieces = [];
  for (const ch of chapters) {
    let s = ch.start;
    let part = 1;
    const body = (a, b) => (part === 1 ? spaceHeadingLine(text.slice(a, b)) : text.slice(a, b));
    while (ch.end - s > maxChars) {
      let cut = text.lastIndexOf("\n", s + maxChars);
      if (cut <= s) cut = s + maxChars;
      pieces.push({ title: part === 1 ? ch.title : `${ch.title} (${part})`, body: body(s, cut) });
      s = cut;
      part++;
    }
    if (ch.end - s > 0) {
      pieces.push({ title: part === 1 ? ch.title : `${ch.title} (${part})`, body: body(s, ch.end) });
    }
  }
  return { pieces, headingCount: marks.length };
}

// Zero-width characters (ZWSP/ZWNJ/ZWJ, direction marks, word joiner, BOM,
// soft hyphen, Mongolian vowel separator) carry no meaning in prose — scraped
// novels use them as watermarks and padding. Exported so
// scripts/renormalize-books.mjs can count what it removed.
export const GHOST_CHARS = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

// A line is blank when nothing on it takes ink: whitespace, plus glyphs that
// render as empty — braille blank (U+2800), Hangul fillers, lone variation
// selectors. These pass the reader's `line.trim()` check (trim only strips
// Unicode whitespace), so left alone they'd render as empty paragraphs.
const INK_FREE = /^[\s\u115f\u1160\u2800\u3164\uffa0\ufe00-\ufe0f]*$/;

// One paragraph per line is the reader's contract — the page renders each
// line with visible content as a <p>, so blank lines (including ones made of
// invisible characters) are pure offset padding. Strip ghost characters
// everywhere, drop every ink-free line, trim the tail, end with exactly one
// \n; a line's own 段首 indent survives. Idempotent — an already clean body
// comes back byte-identical, which is what lets
// scripts/renormalize-books.mjs skip unchanged chapters in the store.
export function normalizeBody(text) {
  const kept = text
    .replace(GHOST_CHARS, "")
    .split("\n")
    .filter((line) => !INK_FREE.test(line));
  return kept.join("\n").replace(/\s+$/, "") + "\n";
}

// pieces → [{ title, file, body, chars }] with normalized bodies and final
// NNNN_<sanitized-title>.txt filenames; empty pieces are dropped.
export function piecesToEntries(pieces) {
  const enc = new TextEncoder();
  const entries = [];
  for (const piece of pieces) {
    const body = normalizeBody(piece.body);
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
