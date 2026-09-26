// Unit test for src/online-sources.mjs, the site adapters behind online
// books. Everything runs on pages this file authors — encrypted the way the
// site encrypts them — through an injected fetch, so the parse rules, the
// page-seam join, the dressing strip and the error paths are each pinned
// without touching the network.
//
//   node scripts/test-online-source.mjs

import {
  findSource, fetchIndex, fetchChapterText, cleanTitle, decodeEntities, stripTags,
  makeFetch, onlineEntries, EST_CHARS, SUPPORTED_SITES,
} from "../src/online-sources.mjs";
import { safeName } from "../public/split-core.mjs";

const out = {};
const BOOK = "https://www.novels.com.tw/novels/noabc123/";

// the site's own scheme, from the other side: AES-CBC, its fixed key, zero IV
const KEY = new TextEncoder().encode("WZc0cbzgY3lhz3X6");
async function encrypt(text) {
  const key = await crypto.subtle.importKey("raw", KEY, { name: "AES-CBC" }, false, ["encrypt"]);
  const bytes = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: new Uint8Array(16) }, key, new TextEncoder().encode(text)));
  // the page escapes slashes in its JS string literal (base64 carries no
  // backslash, but the escape covers it the way a real serializer would)
  return btoa(String.fromCharCode(...bytes)).replace(/[\\/]/g, (c) => "\\" + c);
}
const chapterPage = async (h1, plain) => `<!doctype html><html><head><meta charset="UTF-8"><title>x</title></head><body>
<div class="text_title"><h1 class="style_h1">${h1}</h1></div>
<article id="article" class="content"><div id="chapter-content">
<script>
window.encryptedContent = "${await encrypt(plain)}";
</script>
請前往www.novels.com.tw網站繼續全文閱讀
</div></article></body></html>`;
const indexPage = (chapters) => `<!doctype html><html><head><meta charset="UTF-8">
<meta property="og:novel:book_name" content="測試 &amp; 小說">
<meta property="og:novel:author" content="作者甲">
<title>「測試 &amp; 小說」分頁版</title></head><body>
<div class="novel_info"><img src="https://www.novels.com.tw/ftimg/1/1/1s.jpg"></div>
<h1>測試 &amp; 小說</h1>
<div class="intro"><p><p> 第一行簡介\\\\n第二行簡介\\n</p></p></div>
<div class="section chapter_list"><div class="recent"><ul><li><a href="/novels/noabc123/9.html">最新</a></li></ul></div></div>
<div class="chapters"><ul>
${chapters.map((c) => `<li><a href="/novels/noabc123/${c.id}.html" title="${c.title}">\n   ${c.title}   \n</a></li>`).join("\n")}
</ul></div>
<div class="footer"><a href="/nosort/1/1/">分類</a></div></body></html>`;

const pages = new Map();
const hits = new Map();
const fake = async (url) => {
  hits.set(url, (hits.get(url) ?? 0) + 1);
  const body = pages.get(url);
  return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
};

// --- URL matching ---
{
  const chapterUrl = "https://www.novels.com.tw/novels/noabc123/1001_2.html";
  const src = findSource(chapterUrl);
  const canon = src?.indexUrl(new URL(chapterUrl));
  out.findSource =
    src?.site === "novels.com.tw" && canon === BOOK &&
    findSource("https://novels.com.tw/novels/noabc123/").site === "novels.com.tw" &&
    findSource("https://example.com/novels/noabc123/") === null &&
    findSource("ftp://www.novels.com.tw/novels/x/") === null &&
    findSource("not a url") === null &&
    src.indexUrl(new URL("https://www.novels.com.tw/author/x/")) === null &&
    SUPPORTED_SITES.includes("novels.com.tw")
      ? "ok"
      : `FAIL: ${src?.site} ${canon}`;
}

// --- the index page ---
{
  pages.set(BOOK, indexPage([
    { id: 1001, title: "第1 章 開始" },
    { id: 1002, title: "第2 章 &quot;引號&quot;" },
    { id: 1003, title: "番外 之一" },
  ]));
  const src = findSource(BOOK);
  const idx = await fetchIndex(src, BOOK, fake);
  const titles = idx.chapters.map((c) => c.title);
  out.parseIndex =
    idx.title === "測試 & 小說" && idx.author === "作者甲" &&
    idx.synopsis === "第一行簡介\n第二行簡介" &&
    idx.cover === "https://www.novels.com.tw/ftimg/1/1/1s.jpg" &&
    idx.chapters.length === 3 &&
    // no ideographic space before a name that opens with a quote: spaceHeading's own rule
    titles.join("|") === "第1章　開始|第2章 \"引號\"|番外 之一" &&
    idx.chapters[0].url === `${BOOK}1001.html`
      ? `ok (${idx.chapters.length} chapters, titles cleaned, recent list ignored)`
      : `FAIL: ${JSON.stringify(idx)}`;
}

// --- a chapter across two pages, with the site's dressing ---
{
  // page 1 ends mid-paragraph (no \r), page 2 picks it up (no indent)
  const p1 = `<p> "\r</p><p> 【第1\r</p><p> 章\r</p><p> 開始】\r</p><p> ------------------------------------------\r</p>`
    + `<p> 第一段。\r</p><p> 第二段的前半，</p>`;
  const p2 = `<p>後半。\r</p><p> 第三段 &amp; 實體。\r</p><p> 第四段。\r</p><p> "\r</p>`;
  pages.set(`${BOOK}1001.html`, await chapterPage("第1 章 開始（1 / 2）", p1));
  pages.set(`${BOOK}1001_2.html`, await chapterPage("第1 章 開始（2 / 2）", p2));
  const src = findSource(BOOK);
  const { text, chars } = await fetchChapterText(src, { title: "第1章　開始", src: `${BOOK}1001.html` }, fake);
  const want = "第1章　開始\n第一段。\n第二段的前半，後半。\n第三段 & 實體。\n第四段。\n";
  out.chapterPages = text === want && chars === want.length
    ? "ok (seam joined, dressing stripped, entities decoded)"
    : `FAIL: ${JSON.stringify(text)}`;
  out.chapterFetches = hits.get(`${BOOK}1001.html`) === 1 && hits.get(`${BOOK}1001_2.html`) === 1
    && !hits.has(`${BOOK}1001_3.html`)
    ? "ok (exactly the pages the h1 counts)"
    : `FAIL: ${JSON.stringify([...hits])}`;
}

// --- one page, no page count in the h1 ---
{
  pages.set(`${BOOK}1003.html`, await chapterPage("番外 之一", `<p> 只有一頁。\r</p>`));
  const src = findSource(BOOK);
  const { text } = await fetchChapterText(src, { title: "番外 之一", src: `${BOOK}1003.html` }, fake);
  out.singlePage = text === "番外 之一\n只有一頁。\n" && !hits.has(`${BOOK}1003_2.html`)
    ? "ok" : `FAIL: ${JSON.stringify(text)}`;
}

// --- a page the site serves unencrypted still reads ---
{
  pages.set(`${BOOK}1004.html`, `<html><h1>第4 章 明文</h1><div id="chapter-content"><p>明文一。</p><p>明文二。</p></div></html>`);
  const src = findSource(BOOK);
  const { text } = await fetchChapterText(src, { title: "第4章　明文", src: `${BOOK}1004.html` }, fake);
  out.plainFallback = text === "第4章　明文\n明文一。\n明文二。\n" ? "ok" : `FAIL: ${JSON.stringify(text)}`;
}

// --- the failure paths name their cause ---
{
  const src = findSource(BOOK);
  pages.set(`${BOOK}1005.html`, `<html><h1>第5 章</h1><div id="chapter-content"><script>window.encryptedContent = "AAAAAAAAAAAAAAAAAAAAAA==";</script></div></html>`);
  let badKey = "";
  try { await fetchChapterText(src, { title: "第5章", src: `${BOOK}1005.html` }, fake); } catch (e) { badKey = e.message; }
  let missing = "";
  try { await fetchChapterText(src, { title: "x", src: `${BOOK}9999.html` }, fake); } catch (e) { missing = e.message; }
  pages.set(`${BOOK}1006.html`, await chapterPage("第6 章 空", `<p> "\r</p>`));
  let empty = "";
  try { await fetchChapterText(src, { title: "第6章　空", src: `${BOOK}1006.html` }, fake); } catch (e) { empty = e.message; }
  out.errorsNamed =
    /novels\.com\.tw 解密失敗/.test(badKey) && /HTTP 404/.test(missing) && /沒有內文/.test(empty)
      ? "ok" : `FAIL: ${JSON.stringify({ badKey, missing, empty })}`;
}

// --- helpers ---
{
  const seen = [];
  const f = makeFetch("http://localhost:8992", async (u) => { seen.push(u); return new Response(""); });
  await f("https://www.novels.com.tw/novels/x/1.html");
  const g = makeFetch("", async (u) => { seen.push(u); return new Response(""); });
  await g("https://www.novels.com.tw/novels/x/1.html");
  out.makeFetch = seen[0] === "http://localhost:8992/novels/x/1.html" &&
    seen[1] === "https://www.novels.com.tw/novels/x/1.html"
    ? "ok (rewritten only with a test origin)" : `FAIL: ${JSON.stringify(seen)}`;

  const entries = onlineEntries([{ title: "第1章　開始", url: "u1" }, { title: "?", url: "u2" }], 7, safeName);
  out.onlineEntries =
    entries[0].file === "0007_第1章-開始.txt" && entries[0].chars === EST_CHARS && entries[0].src === "u1" &&
    entries[1].file === "0008_chapter.txt" && entries[1].bytes === undefined
      ? "ok" : `FAIL: ${JSON.stringify(entries)}`;

  const cases = [
    ["第454 章 九宮迷局", "第454章　九宮迷局"],
    ["  第一百二十三 回  名字 ", "第一百二十三回　名字"],
    ["第3章", "第3章"],
    ["番外 之一", "番外 之一"],
  ];
  const bad = cases.filter(([a, b]) => cleanTitle(a) !== b).map(([a]) => `${a} → ${cleanTitle(a)}`);
  out.cleanTitle = bad.length ? `FAIL: ${bad.join("; ")}` : "ok";
  out.entities = decodeEntities("&amp;&lt;&#x4e00;&#20108;&hellip;&bogus;") === "&<一二…&bogus;" &&
    stripTags("a<br>b<i>c</i>&nbsp;d") === "a\nbc d"
    ? "ok" : `FAIL: ${decodeEntities("&amp;&lt;&#x4e00;&#20108;&hellip;&bogus;")}`;
}

console.log(JSON.stringify(out, null, 2));
process.exit(JSON.stringify(out).includes("FAIL") ? 1 : 0);
