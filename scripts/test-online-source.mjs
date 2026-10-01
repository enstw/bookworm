// Unit test for src/online-sources.mjs, the site adapters behind online
// books. Everything runs on pages this file authors — encrypted or encoded
// the way each site does it — through an injected fetch, so the parse
// rules, the list-page walk, the page-seam joins, the dressing strip and
// the error paths are each pinned without touching the network.
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
    SUPPORTED_SITES.join() === "novels.com.tw,aiyanzx.com" &&
    !src.script
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

// ================= aiyanzx.com =================
//
// the site from the other side: base64 lines the way qsbs.bb reads them,
// a book page with the newest-chapters block beside the main list, list
// pages with CSS-hidden decoys at the top and the first chapters repeated
// at the bottom, and a <select> naming every list page
const AY = "https://www.aiyanzx.com/cat/book/";
const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const ayLines = (paras) => paras.map((p) =>
  `<script>document.writeln(qsbs.bb('${b64(`<p>　　${p}</p>`)}'));</script>`).join("\n");
const ayChapter = (title, paras, prev, next) => `<!doctype html><html><head><meta charset="UTF-8">
<title>${title}_測試書(作者乙)_爱研阅读</title></head><body>
<h1><a href="/"><span>爱研阅读</span></a></h1>
<div class="read_btn"><a href="${prev}">上一章</a><a href="/cat/book/">章节目录</a><a href="${next}">下一章</a></div>
<div id="chaptercontent" style="white-space:pre-line;line-height:1.8;">
${ayLines(paras)}
</div><p>请勿开启浏览器阅读模式，否则将导致章节内容缺失及无法阅读下一章。</p>
<div class="read_btn"><a href="${prev}">上一章</a><a href="${next}">下一章</a></div></body></html>`;
const ayItems = (cs) => cs.map((c) => `<li><a href="/cat/book/${c.id}.html">${c.title}</a></li>`).join("\n");
const ayIndex = (main, latest) => `<!doctype html><html><head><meta charset="UTF-8">
<meta property="og:type" content="novel"/><meta property="og:title" content="測試書"/>
<meta property="og:description" content="第一行簡介\\n第二行簡介\\n"/>
<meta property="og:image" content="/bimg/1.jpg"/>
<meta property="og:novel:author" content="主角甲主角乙"/><meta property="og:novel:book_name" content="測試書"/>
<title>測試書(主角甲主角乙)_小说最新章节更新列表_爱研阅读</title></head><body>
<h1><a href="/"><span>爱研阅读</span></a></h1><h1>測試書</h1>
<ul class="nav"><li><a href="/">首页</a></li><li><a href="/clx/1/1.html">玄幻</a></li></ul>
<div class="section-box"><ul class="section-list fix">${ayItems(latest)}</ul></div>
<div class="section-box"><ul class="fix section-list">${ayItems(main)}</ul></div>
<a href="/cat/book/mulu_1.html">查看更多章节...</a></body></html>`;
const aySelect = (n) => `<select onchange="location=this.value"><option value="/cat/book/">第1-3章</option>` +
  `<option${n === 1 ? ' selected="selected"' : ""} value="/cat/book/mulu_1.html">第4-6章</option>` +
  `<option${n === 2 ? ' selected="selected"' : ""} value="/cat/book/mulu_2.html">第7-7章</option></select>`;
const ayListPage = (n, decoys, main, trailing) => `<!doctype html><html><head><meta charset="UTF-8">
<title>測試書(作者乙)_章节目录_全文阅读_爱研阅读</title>
<style>${decoys.map((_, i) => `.section-list.ycxsid>li:nth-child(${i + 1}){display:none}`).join("")}</style></head><body>
<ul class="nav"><li><a href="/">首页</a></li></ul>
<div class="listpage">${aySelect(n)}<a href="/cat/book/mulu_${n + 1}.html" class="y">下一页</a></div>
<ul class="section-list fix ycxsid">${ayItems([...decoys, ...main, ...trailing])}</ul>
<div class="listpage">${aySelect(n)}</div></body></html>`;
// the other skin (2026-09-30): the list is a `chapter-list`, and the
// stylesheet still carries the first skin's hide rules, naming a list the
// page does not have — they must hide nothing here
const ayListPageSkin2 = (n, main) => `<!doctype html><html><head><meta charset="UTF-8">
<meta property="og:novel:author" content="作者乙"/>
<title>測試書章节目录_測試書最新章节_爱研阅读</title>
<style>.section-list.ycxsid>li:nth-child(1){display:none}.section-list.ycxsid>li:nth-child(2){display:none}</style></head><body>
<ul class="btn-group"><li><a href="/cat/book/">目录</a></li></ul>
<div class="listpage">${aySelect(n)}<a href="/cat/book/mulu_${n + 1}.html" class="y">下一页</a></div>
<ul class="chapter-list">${ayItems(main)}</ul></body></html>`;
const AY_CH = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: "abcdefg".slice(0, n) + "x", title: `第${n} 章 標題${n}` }));

// --- URLs: every page under /<category>/<book>/ is the book ---
{
  const src = findSource("https://m.aiyanzx.com/cat/book/abx_2.html");
  out.ayFindSource =
    src?.site === "aiyanzx.com" && src.script === "hans" &&
    src.indexUrl(new URL("https://m.aiyanzx.com/cat/book/abx_2.html")) === AY &&
    src.indexUrl(new URL("https://www.aiyanzx.com/cat/book/mulu_3.html")) === AY &&
    src.indexUrl(new URL("https://www.aiyanzx.com/liulan.html")) === null &&
    findSource("https://aiyanzx.com.evil.example/cat/book/") === null
      ? "ok" : `FAIL: ${src?.site}`;
}

// --- the index: three list pages, decoys hidden, repeats dropped, in order
//     (the newest block above the main list is as long as it — a tie must
//     still pick the main list, or a short book comes out newest-first) ---
{
  pages.set(AY, ayIndex(AY_CH.slice(0, 3), [AY_CH[6], AY_CH[5], AY_CH[4]]));
  pages.set(`${AY}mulu_1.html`, ayListPage(1, [AY_CH[6], AY_CH[5]], AY_CH.slice(3, 6), [AY_CH[0]]));
  // page 2 in the other skin, its two chapters out of order and chapter 7
  // posted twice — the later copy is the one kept — with 「第 7章」 spacing
  pages.set(`${AY}mulu_2.html`, ayListPageSkin2(2, [
    { id: "repost7x", title: "第 7章 標題7" }, AY_CH[6], AY_CH[5], { id: "abcdefgx", title: "第7 章 標題7" }]));
  pages.set(`${AY}mulu_3.html`, ayListPage(3, [AY_CH[6]], [], AY_CH.slice(0, 9))); // the page past the last: never asked for
  const src = findSource(AY);
  const idx = await fetchIndex(src, AY, fake);
  const titles = idx.chapters.map((c) => c.title);
  out.ayIndex =
    idx.title === "測試書" && idx.author === "作者乙" && idx.synopsis === "第一行簡介\n第二行簡介" &&
    idx.cover === "https://www.aiyanzx.com/bimg/1.jpg" &&
    titles.join("|") === "第1章　標題1|第2章　標題2|第3章　標題3|第4章　標題4|第5章　標題5|第6章　標題6|第7章　標題7" &&
    idx.chapters[0].url === `${AY}ax.html` && idx.chapters[6].url === `${AY}abcdefgx.html` &&
    hits.get(AY) === 1 && hits.get(`${AY}mulu_1.html`) === 1 && hits.get(`${AY}mulu_2.html`) === 1 &&
    !hits.has(`${AY}mulu_3.html`)
      ? "ok (7 chapters over 3 list pages in both skins, re-post and order settled, author from the list page)"
      : `FAIL: ${JSON.stringify({ ...idx, chapters: idx.chapters })} hits=${JSON.stringify([...hits].filter(([u]) => u.startsWith(AY)))}`;
}

// --- a chapter over three pages: cut paragraph joined, dressing gone, the
//     next chapter's link and the page-one trap both left alone ---
{
  const c = `${AY}ax`;
  pages.set(`${c}.html`, ayChapter("第1 章 標題1",
    ['"', "【第1", "章", "標題1】", "------------------------------------------", "第一段。", "第二段的前半，"],
    "/cat/book/", `/cat/book/ax_1.html`));
  pages.set(`${c}_1.html`, ayChapter("第1 章 標題1", ["後半。", "第三段 &amp; 實體。"], `/cat/book/ax.html`, `/cat/book/ax_2.html`));
  pages.set(`${c}_2.html`, ayChapter("第1 章 標題1", ["第四段！", "本章由爱研阅读整理", '"'], `/cat/book/ax_1.html`, `/cat/book/abx.html`));
  pages.set(`${c}_3.html`, pages.get(`${c}.html`)); // past the last: page one again, 下一章 → _1
  const src = findSource(AY);
  const { text, chars } = await fetchChapterText(src, { title: "第1章　標題1", src: `${c}.html` }, fake);
  const want = "第1章　標題1\n第一段。\n第二段的前半，後半。\n第三段 & 實體。\n第四段！\n";
  out.ayChapterPages = text === want && chars === want.length
    ? "ok (cut paragraph joined, dressing and site line stripped)" : `FAIL: ${JSON.stringify(text)}`;
  out.ayChapterFetches =
    hits.get(`${c}.html`) === 1 && hits.get(`${c}_1.html`) === 1 && hits.get(`${c}_2.html`) === 1 &&
    !hits.has(`${c}_3.html`) && !hits.has(`${AY}abx.html`)
      ? "ok (stopped at the link to the next chapter)" : `FAIL: ${JSON.stringify([...hits].filter(([u]) => u.startsWith(AY)))}`;
}

// --- one page whose 下一章 is the next chapter; a page that does not decode ---
{
  const src = findSource(AY);
  pages.set(`${AY}abx.html`, ayChapter("第2 章 標題2", ["只有一頁。"], "/cat/book/ax_2.html", "/cat/book/abcx.html"));
  const { text } = await fetchChapterText(src, { title: "第2章　標題2", src: `${AY}abx.html` }, fake);
  out.aySinglePage = text === "第2章　標題2\n只有一頁。\n" && !hits.has(`${AY}abcx.html`) ? "ok" : `FAIL: ${JSON.stringify(text)}`;
  pages.set(`${AY}abcx.html`, `<html><div id="chaptercontent"><script>document.writeln(qsbs.bb('${btoa("\xff\xfe")}'));</script></div></html>`);
  let bad = "";
  try { await fetchChapterText(src, { title: "x", src: `${AY}abcx.html` }, fake); } catch (e) { bad = e.message; }
  pages.set(`${AY}abcdx.html`, `<html><div id="chaptercontent"><p>　　明文一。</p><p>　　明文二。</p></div></html>`);
  const plain = await fetchChapterText(src, { title: "第4章　明文", src: `${AY}abcdx.html` }, fake);
  out.ayDecode = /aiyanzx\.com 章節解碼失敗/.test(bad) && plain.text === "第4章　明文\n明文一。\n明文二。\n"
    ? "ok (decode failure named, plain <p> page still read)" : `FAIL: ${JSON.stringify({ bad, plain: plain.text })}`;
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
    ["第 199章 龍蛋變化", "第199章　龍蛋變化"],
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
