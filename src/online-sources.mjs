// Online books: a book whose chapters live on a website. Registering one
// (POST /api/admin/online) reads the site's index page into a manifest whose
// chapters carry a `src` URL instead of bytes; the chapter file itself is
// fetched the first time anything asks for it — the reader, its offline
// window, the TTS route — and stored under the same key a published chapter
// would have, so nothing downstream can tell the two apart afterwards.
//
// One adapter per site, each knowing three things: which URLs are its, how
// to read the index (title, author, 簡介, cover, the chapter list — one page
// via `parseIndex`, or its own walk over several via `index`) and how to
// turn one chapter URL into text. An adapter whose site writes Simplified
// says so (`script: "hans"`); the manifest carries it and the reader
// converts on the phone, the Worker stores what the site serves. Everything
// here is pure over strings plus an injected fetch, so
// scripts/test-online-source.mjs drives it with synthetic pages and the e2e
// suite points the real fetch at a stub (makeFetch below). No DOM parser in
// a Worker: the sites' markup is regexed on the exact shapes their pages
// have today, and a shape change surfaces as "書頁上找不到章節" or a decode
// error naming the site, never as a silently empty book.

import { normalizeBody, spaceHeading } from "../public/split-core.mjs";

// The manifest's estimate for a chapter nobody has fetched yet — progress
// bars need a denominator before the text exists. A real count replaces it
// once the chapter is in R2 (refreshOnline reconciles from the object's
// customMetadata); until then a 3,000-character web serial chapter is the
// honest median.
export const EST_CHARS = 3000;

const PAGE_TIMEOUT_MS = 20000;
// a chapter split across more pages than this is not a chapter
const MAX_PAGES = 40;
// an index split across more list pages than this is not a book (6,000
// chapters at a hundred a page)
const MAX_LIST_PAGES = 60;
// what the sites see: a phone browser, which is what they are built for
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// The fetch every adapter uses. `testOrigin` (the e2e suite's
// ONLINE_TEST_ORIGIN, a wrangler --var) points every source host at a
// local stub while the adapters keep matching on the real hostnames — the
// suite exercises the same code path production runs, URL matching
// included, against pages it authored.
export function makeFetch(testOrigin, fetchFn = globalThis.fetch) {
  return (url, init) => {
    let target = url;
    if (testOrigin) {
      const u = new URL(url);
      const t = new URL(testOrigin);
      u.protocol = t.protocol;
      u.host = t.host;
      target = u.toString();
    }
    return fetchFn(target, init);
  };
}

async function fetchHtml(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,*/*;q=0.8",
      "accept-language": "zh-TW,zh;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`來源回應 HTTP ${res.status}`);
  return await res.text();
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
};
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// tags out, <br> as a line break, entities decoded, nbsp as a space. The
// result is text — the reader sets it as textContent and the file is
// text/plain — so this is not an HTML sanitizer; it still strips to a
// fixed point, since one pass over "<<b>script>" leaves a tag behind.
export function stripTags(s) {
  let t = s.replace(/<br\s*\/?>/gi, "\n");
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/<[^>]*>/g, "");
    if (next === t) break;
    t = next;
  }
  return decodeEntities(t).replace(/\u00a0/g, " ");
}

const attr = (html, re) => decodeEntities((html.match(re) ?? [])[1] ?? "").trim();
const h1Of = (html) => stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? "").trim();

// 「第454 章 九宮迷局」→「第454章　九宮迷局」: the sites space the number
// from its marker, which the reader's heading rule never expects, then
// spaceHeading puts the one ideographic space before the name
export function cleanTitle(s) {
  const t = s.replace(/\s+/g, " ").trim()
    .replace(/^(第\s*[0-9〇零一二三四五六七八九十百千万萬两兩]+)\s+([章节節回卷部篇集话話])/u, "$1$2");
  return spaceHeading(t);
}

// ---------- novels.com.tw ----------
//
// Chapter text arrives as `window.encryptedContent`, AES-CBC under a fixed
// key with a zero IV, which the page's own script (gfncgd.js) decrypts for
// every visitor; the plaintext is one <p> per paragraph. A chapter longer
// than ~1,500 characters is cut into pages (<id>_2.html, _3.html …, the
// count in the <h1> as 「（1 / 3）」) at a character boundary, so the last
// paragraph of one page continues on the next — a cut paragraph ends
// without the \r every whole one carries, and its continuation starts
// without the indent space. Requesting a page past the last repeats the
// last one, so the count is the only stop. The key is the site's, copied
// here; when they rotate it the decrypt throws an error that names the site.
const NOVELS_TW_KEY = "WZc0cbzgY3lhz3X6";

async function aesCbcDecrypt(b64, keyText) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(keyText), { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) }, key, bytes));
  let s = new TextDecoder("utf-8").decode(plain);
  // the page's script strips a second PKCS#7 layer by hand; so do we
  const last = s.charCodeAt(s.length - 1);
  if (last > 0 && last <= 16) {
    let pad = true;
    for (let i = 0; i < last; i++) if (s.charCodeAt(s.length - 1 - i) !== last) { pad = false; break; }
    if (pad) s = s.slice(0, -last);
  }
  return s;
}

// one page → its raw paragraphs (\r and indent kept: the seam rule reads them)
async function novelsTwPage(html) {
  const enc = html.match(/window\.encryptedContent\s*=\s*"([^"]*)"/);
  let content;
  if (enc) {
    try {
      content = await aesCbcDecrypt(enc[1].replace(/\\\//g, "/"), NOVELS_TW_KEY);
    } catch (err) {
      throw new Error(`novels.com.tw 解密失敗（網站可能換了金鑰）: ${err?.message ?? err}`);
    }
  } else {
    // no encryption on this page: the plain article, if there is one
    content = (html.match(/<div id="chapter-content"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1] ?? "";
  }
  const paras = [...content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  return paras.length ? paras : content.split("\n");
}

function novelsTwJoin(pages) {
  const out = [];
  for (const [i, page] of pages.entries()) {
    const ps = page.slice();
    if (i > 0 && out.length && ps.length) {
      const prev = out[out.length - 1], next = ps[0];
      if (!/\r\s*$/.test(prev) || !/^\s/.test(next)) {
        out[out.length - 1] = prev.replace(/\s+$/, "") + next.replace(/^\s+/, "");
        ps.shift();
      }
    }
    out.push(...ps);
  }
  const paras = out.map((p) => stripTags(p).replace(/\r/g, "").trim()).filter(Boolean);
  return stripDressing(paras, /novels\.com\.tw/i);
}

// The sites' own dressing, the same on both (they mirror the same feed): a
// stray quote mark first and last, the chapter title re-spelled over a few
// lines and closed with a dashed rule, and a line pointing back at the site
// — none of it is the book
function stripDressing(paras, siteRe) {
  const dressing = /^[\s"'“”‘’「」『』.。…\-—_]*$/;
  while (paras.length && dressing.test(paras[0])) paras.shift();
  while (paras.length && dressing.test(paras[paras.length - 1])) paras.pop();
  const rule = paras.slice(0, 8).findIndex((p) => /^[-—–=_]{5,}$/.test(p));
  if (rule >= 0) paras.splice(0, rule + 1);
  return paras.filter((p) => !siteRe.test(p));
}

const NOVELS_TW = {
  site: "novels.com.tw",
  matches: (u) => /^(www\.)?novels\.com\.tw$/.test(u.hostname),
  // the book page and every chapter page share the /novels/<id>/ prefix
  indexUrl(u) {
    const m = u.pathname.match(/^\/novels\/([a-z0-9]+)\//);
    return m ? `https://www.novels.com.tw/novels/${m[1]}/` : null;
  },
  parseIndex(html, indexUrl) {
    const meta = (p) => attr(html, new RegExp(`<meta property="${p}" content="([^"]*)"`));
    const title = meta("og:novel:book_name") || h1Of(html);
    const author = meta("og:novel:author");
    const intro = (html.match(/class="intro"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1] ?? "";
    const synopsis = stripTags(intro).replace(/\\+n/g, "\n")
      .split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
    const cover = attr(html, /<img[^>]+src="(https?:\/\/[^"]*\/ftimg\/[^"]+)"/);
    const block = (html.match(/<div class="chapters">([\s\S]*?)<\/div>/) ?? [])[1] ?? "";
    const chapters = [];
    for (const m of block.matchAll(/<a\s+href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const t = cleanTitle(stripTags(m[2]));
      if (t) chapters.push({ title: t, url: new URL(m[1], indexUrl).toString() });
    }
    return { title, author, synopsis, cover, chapters };
  },
  async chapter(url, fetchFn) {
    const first = await fetchHtml(url, fetchFn);
    const pm = h1Of(first).match(/[（(]\s*\d+\s*\/\s*(\d+)\s*[)）]\s*$/);
    const pages = Math.min(MAX_PAGES, Math.max(1, pm ? Number(pm[1]) : 1));
    const raw = [await novelsTwPage(first)];
    const base = url.replace(/(?:_\d+)?\.html$/, "");
    for (let n = 2; n <= pages; n++)
      raw.push(await novelsTwPage(await fetchHtml(`${base}_${n}.html`, fetchFn)));
    return novelsTwJoin(raw);
  },
};

// ---------- aiyanzx.com ----------
//
// A Simplified mirror of the 番茄小说 serials, reachable by a plain fetch
// where every Traditional mirror of the same feed sits behind a Cloudflare
// challenge a Worker cannot pass (the owner's book, 2026-09-27). Its text
// is Simplified, so the adapter says `script: "hans"` and the phone converts.
//
// The "qsbs" template: the book page carries the meta and the first hundred
// chapters and links a `mulu_1.html` list page, whose <select> enumerates
// every list page (the book page is its first option). Each list page
// repeats the newest chapters at its top, hidden by one
// `li:nth-child(n){display:none}` rule per decoy, and pads its bottom with
// the first few chapters again — the rule count drops the decoys, the URL
// set drops the repeats. A chapter page holds one
// `document.writeln(qsbs.bb('<base64>'))` per paragraph (qsbs.bb is plain
// base64) inside #chaptercontent, over `_1.html`, `_2.html` … pages; the
// 下一章 link names the next page until the last, where it names the next
// chapter, and a page past the last serves page one again — so only a link
// to exactly the page after this one is followed. The cut between pages can
// fall inside a paragraph, and nothing marks it but the missing full stop.
const AIYANZX = {
  site: "aiyanzx.com",
  script: "hans",
  matches: (u) => /^(www\.|m\.)?aiyanzx\.com$/.test(u.hostname),
  // /<category>/<book>/ prefixes the book page, its list pages and every chapter
  indexUrl(u) {
    const m = u.pathname.match(/^\/([a-z0-9]+)\/([a-z0-9]+)\//);
    return m ? `https://www.aiyanzx.com/${m[1]}/${m[2]}/` : null;
  },
  async index(indexUrl, fetchFn) {
    const first = await fetchHtml(indexUrl, fetchFn);
    const meta = (p) => attr(first, new RegExp(`<meta property="${p}" content="([^"]*)"`));
    const title = meta("og:novel:book_name") || meta("og:title") || attr(first, /<title>([^<(_]*)/);
    const synopsis = meta("og:description").replace(/\\+n/g, "\n")
      .split("\n").map((s) => s.trim()).filter(Boolean).join("\n");
    const cover = meta("og:image") ? new URL(meta("og:image"), indexUrl).toString() : "";
    let author = meta("og:novel:author");
    const htmls = new Map([[indexUrl, first]]);
    let pages = [indexUrl];
    const listLink = first.match(/href="([^"]*mulu_\d+\.html)"/);
    if (listLink) {
      const listUrl = new URL(decodeEntities(listLink[1]), indexUrl).toString();
      const list = await fetchHtml(listUrl, fetchFn);
      htmls.set(listUrl, list);
      // the list page's <title> is 「書名(作者)_章节目录…」; the book page's
      // og:novel:author is another field of the site's, seen holding the
      // protagonists' names instead
      const by = list.match(/<title>[^<(]*\(([^)]+)\)_/);
      if (by) author = decodeEntities(by[1]).trim();
      const opts = [...list.matchAll(/<option[^>]*value="([^"]+)"/g)]
        .map((m) => new URL(decodeEntities(m[1]), indexUrl).toString());
      pages = [...new Set([indexUrl, ...(opts.length ? opts : [listUrl])])].slice(0, MAX_LIST_PAGES);
    }
    const chapters = [];
    const seen = new Set();
    for (const page of pages) {
      const html = htmls.get(page) ?? await fetchHtml(page, fetchFn);
      for (const c of qsbsList(html, page)) {
        if (!c.url.startsWith(indexUrl) || seen.has(c.url)) continue;
        seen.add(c.url);
        chapters.push(c);
      }
    }
    return { title, author, synopsis, cover, chapters };
  },
  async chapter(url, fetchFn) {
    const base = url.replace(/(?:_\d+)?\.html$/, "");
    const pages = [];
    let page = url;
    for (let n = 0; page && n < MAX_PAGES; n++) {
      const html = await fetchHtml(page, fetchFn);
      pages.push(qsbsPage(html));
      const nav = html.match(/<a[^>]+href="([^"]+)"[^>]*>\s*下一章\s*<\/a>/);
      const to = nav ? new URL(decodeEntities(nav[1]), page).toString() : "";
      page = to === `${base}_${n + 1}.html` ? to : "";
    }
    return stripDressing(joinCut(pages), /aiyanzx|爱研阅读/i);
  },
};

// one list page's chapters: the biggest <ul class="section-list"> on it,
// minus the decoys its stylesheet hides at the top. The newest-chapters
// block is the other one, above the main list and never longer — and equal
// on a book of a dozen chapters, which is why a tie goes to the later list.
function qsbsList(html, pageUrl) {
  const rules = [...html.matchAll(/\.([\w-]+)>li:nth-child\(\d+\)\{display:\s*none\}/g)];
  const hiddenClass = rules[0]?.[1];
  let best = [];
  for (const ul of html.matchAll(/<ul[^>]*class="([^"]*section-list[^"]*)"[^>]*>([\s\S]*?)<\/ul>/g)) {
    const items = [];
    for (const a of ul[2].matchAll(/<a\s[^>]*?href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const t = cleanTitle(stripTags(a[2]));
      if (t) items.push({ title: t, url: new URL(decodeEntities(a[1]), pageUrl).toString() });
    }
    if (hiddenClass && ul[1].split(/\s+/).includes(hiddenClass)) items.splice(0, rules.length);
    if (items.length >= best.length) best = items;
  }
  return best;
}

// one chapter page → its paragraphs: the base64 the page's own script
// decodes into <p> lines (plain <p> lines when a page comes unobfuscated)
function qsbsPage(html) {
  const block = (html.match(/<div id="chaptercontent"[^>]*>([\s\S]*?)<\/div>/) ?? [])[1] ?? "";
  const enc = [...block.matchAll(/qsbs\.bb\('([A-Za-z0-9+/=]*)'\)/g)];
  let lines;
  try {
    lines = enc.map((m) => new TextDecoder("utf-8", { fatal: true })
      .decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))));
  } catch (err) {
    throw new Error(`aiyanzx.com 章節解碼失敗（網站可能換了編碼）: ${err?.message ?? err}`);
  }
  if (!enc.length) lines = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  return lines.map((l) => stripTags(l).trim()).filter(Boolean);
}

// the pages of one chapter as one paragraph list: a page whose last
// paragraph does not close on punctuation was cut mid-paragraph, and the
// next page's first paragraph is its rest (every whole paragraph the site
// serves closes on one — 149 of 149 measured)
const CLOSED = /[。！？!?…”’」』）)】》〕—～]\s*$/;
function joinCut(pages) {
  const out = [];
  for (const page of pages) {
    const ps = page.slice();
    if (out.length && ps.length && !CLOSED.test(out[out.length - 1]))
      out[out.length - 1] += ps.shift();
    out.push(...ps);
  }
  return out;
}

const SOURCES = [NOVELS_TW, AIYANZX];

export const SUPPORTED_SITES = SOURCES.map((s) => s.site);

// the adapter for a URL, or null — the caller's "unsupported site"
export function findSource(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return SOURCES.find((s) => s.matches(u)) ?? null;
}

export async function fetchIndex(src, indexUrl, fetchFn) {
  const index = src.index
    ? await src.index(indexUrl, fetchFn)
    : src.parseIndex(await fetchHtml(indexUrl, fetchFn), indexUrl);
  index.title = index.title.slice(0, 100);
  return index;
}

// One chapter, as the file the reader will get: the manifest's title on the
// first line (the reader renders it as the <h2> and skips it as a paragraph
// while it equals the title), one paragraph per line, normalized exactly
// like an uploaded chapter.
export async function fetchChapterText(src, chapter, fetchFn) {
  const paras = await src.chapter(chapter.src, fetchFn);
  if (!paras.length) throw new Error("章節頁上沒有內文");
  const text = normalizeBody([chapter.title, ...paras].join("\n") + "\n");
  return { text, chars: text.length };
}

// the manifest entries for a list of {title, url}, numbered from `start`
// (a refresh appends after what the book already has)
export function onlineEntries(chapters, start = 0, safeName) {
  return chapters.map((c, i) => {
    const n = start + i;
    return {
      title: c.title,
      file: `${String(n).padStart(4, "0")}_${safeName(c.title) || "chapter"}.txt`,
      chars: EST_CHARS,
      src: c.url,
    };
  });
}
