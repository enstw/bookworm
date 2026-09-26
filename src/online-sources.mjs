// Online books: a book whose chapters live on a website. Registering one
// (POST /api/admin/online) reads the site's index page into a manifest whose
// chapters carry a `src` URL instead of bytes; the chapter file itself is
// fetched the first time anything asks for it — the reader, its offline
// window, the TTS route — and stored under the same key a published chapter
// would have, so nothing downstream can tell the two apart afterwards.
//
// One adapter per site, each knowing three things: which URLs are its, how
// to read the index page (title, author, 簡介, cover, the chapter list) and
// how to turn one chapter URL into text. Everything here is pure over
// strings plus an injected fetch, so scripts/test-online-source.mjs drives
// it with synthetic pages and the e2e suite points the real fetch at a stub
// (makeFetch below). No DOM parser in a Worker: the sites' markup is regexed
// on the exact shapes their pages have today, and a shape change surfaces
// as "書頁上找不到章節" or a decrypt error naming the site, never as a
// silently empty book.

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
  let paras = out.map((p) => stripTags(p).replace(/\r/g, "").trim()).filter(Boolean);
  // the site's own dressing: a stray quote mark first and last, the chapter
  // title re-spelled over a few lines and closed with a dashed rule, and a
  // line pointing back at the site — none of it is the book
  const dressing = /^[\s"'“”‘’「」『』.。…\-—_]*$/;
  while (paras.length && dressing.test(paras[0])) paras.shift();
  while (paras.length && dressing.test(paras[paras.length - 1])) paras.pop();
  const rule = paras.slice(0, 8).findIndex((p) => /^[-—–=_]{5,}$/.test(p));
  if (rule >= 0) paras.splice(0, rule + 1);
  return paras.filter((p) => !/novels\.com\.tw/i.test(p));
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

const SOURCES = [NOVELS_TW];

export const SUPPORTED_SITES = SOURCES.map((s) => s.site);

// the adapter for a URL, or null — the caller's "unsupported site"
export function findSource(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return SOURCES.find((s) => s.matches(u)) ?? null;
}

export async function fetchIndex(src, indexUrl, fetchFn) {
  const html = await fetchHtml(indexUrl, fetchFn);
  const index = src.parseIndex(html, indexUrl);
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
